import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  CategoryKind,
  Prisma,
  ServiceBookingStatus,
  ServicePricingType,
  ServiceStatus,
  UserRole,
} from '@prisma/client';

import { AuditService } from '../../../shared/audit/audit.service';
import { categoryScope } from '../../../shared/categories/category-scope';
import { PrismaService } from '../../../shared/db/prisma.service';
import { runSerializable } from '../../../shared/db/serializable-transaction';
import { hideFromOutsiders } from '../../../shared/moderation/hide-from-outsiders';
import {
  changedFields,
  ListingEditor,
  returnsToReview,
} from '../../../shared/moderation/listing-moderation';
import { PushService } from '../../../shared/push/push.service';
import { CreateServiceDto } from '../dto/create-service.dto';
import {
  FindServicesQueryDto,
  ServiceSortBy,
} from '../dto/find-services-query.dto';
import { UpdateServiceDto } from '../dto/update-service.dto';
import { ServicePresenter } from '../presenters/service.presenter';

const PROVIDER_SELECT = {
  id: true,
  name: true,
  avatarUrl: true,
} as const;

const PROVIDER_DETAIL_SELECT = {
  id: true,
  name: true,
  avatarUrl: true,
  bio: true,
  providerRating: true,
  providerReviews: true,
} as const;

const CATEGORY_SELECT = {
  id: true,
  name: true,
  slug: true,
} as const;

const PHOTOS_ORDER = [
  { isPrimary: 'desc' as const },
  { order: 'asc' as const },
];

/**
 * Quantos trabalhos do serviço chegaram ao fim. Conta-se nas reservas em vez
 * de se guardar num contador, que ninguém mantinha e mostrava sempre zero.
 */
const COMPLETED_JOBS = {
  select: { bookings: { where: { status: ServiceBookingStatus.COMPLETED } } },
} satisfies Prisma.ServiceInclude['_count'];

/** O anúncio como sai nas listas, públicas e do provider. */
const LISTING_INCLUDE = {
  provider: { select: PROVIDER_SELECT },
  category: { select: CATEGORY_SELECT },
  photos: { orderBy: PHOTOS_ORDER },
  _count: COMPLETED_JOBS,
} satisfies Prisma.ServiceInclude;

/** O que uma edição precisa de saber do anúncio para ver o que muda. */
const EDITABLE_SELECT = {
  id: true,
  providerId: true,
  status: true,
  title: true,
  description: true,
  categoryId: true,
  basePrice: true,
  pricingType: true,
  estimatedHours: true,
  location: true,
  latitude: true,
  longitude: true,
  acceptsUrgent: true,
  urgentSurcharge: true,
} satisfies Prisma.ServiceSelect;

/** O que um admin aprovou. Mudá-lo devolve o anúncio à revisão. */
const MODERATED_FIELDS: readonly string[] = [
  'title',
  'description',
  'categoryId',
];

/** Reservas em que o serviço ainda tem trabalho ou dinheiro por fechar. */
const BOOKINGS_IN_PROGRESS: ServiceBookingStatus[] = [
  ServiceBookingStatus.PENDING,
  ServiceBookingStatus.IN_PROGRESS,
  ServiceBookingStatus.DISPUTED,
];

const NOT_FOUND = 'Serviço não encontrado.';
const UPDATED = 'Serviço atualizado com sucesso.';
const SENT_TO_REVIEW =
  'Alterações guardadas. Como mudou o que tinha sido aprovado, o anúncio volta à revisão antes de ficar público.';
const RESUBMITTED =
  'Alterações guardadas. O anúncio foi enviado de novo para revisão.';
const REMOVAL_BLOCKED =
  'Este serviço tem reservas em curso. Pausa o anúncio para não receber mais pedidos e remove-o quando elas terminarem.';

/** Quantos anúncios por página nas listas do provider e do admin, por omissão. */
const DEFAULT_LISTINGS_PAGE_SIZE = 50;

interface ListingsPage {
  page?: number;
  limit?: number;
}

@Injectable()
export class ServicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly push: PushService,
  ) {}

  async create(providerId: string, dto: CreateServiceDto) {
    const categoryId = dto.categoryId.trim();

    // Providers suspensos por strikes não publicam listagens.
    const provider = await this.prisma.user.findUnique({
      where: { id: providerId },
      select: { role: true, listingsSuspendedUntil: true },
    });

    if (
      provider?.listingsSuspendedUntil &&
      provider.listingsSuspendedUntil > new Date()
    ) {
      throw new ForbiddenException(
        'A tua conta está temporariamente suspensa de publicar listagens devido a cancelamentos de reservas confirmadas.',
      );
    }

    const category = await this.prisma.category.findFirst({
      where: { id: categoryId, isActive: true },
    });

    if (!category) {
      throw new BadRequestException('Categoria não encontrada ou inativa.');
    }

    if (
      category.kind !== CategoryKind.SERVICE &&
      category.kind !== CategoryKind.BOTH
    ) {
      throw new BadRequestException(
        'Esta categoria não está marcada para serviços.',
      );
    }

    const pricingType = dto.pricingType ?? ServicePricingType.FIXED;

    if (pricingType === ServicePricingType.HOURLY && !dto.estimatedHours) {
      throw new BadRequestException('Pricing por hora requer estimatedHours.');
    }

    if (dto.acceptsUrgent && dto.urgentSurcharge === undefined) {
      throw new BadRequestException(
        'urgentSurcharge é obrigatório se acceptsUrgent=true.',
      );
    }

    if (!dto.acceptsUrgent && dto.urgentSurcharge !== undefined) {
      throw new BadRequestException(
        'urgentSurcharge só pode ser definido se acceptsUrgent=true.',
      );
    }

    // Dev/staging: AUTO_APPROVE_SERVICES=true publica directamente como ACTIVE.
    const autoApprove = process.env.AUTO_APPROVE_SERVICES === 'true';

    // Quem publica passa a PROVIDER, como no equipamento. O papel só serve à
    // app para mostrar a área de provider: as permissões decidem-se pela
    // posse do serviço e pela posição em cada reserva.
    if (provider?.role === UserRole.CLIENT) {
      await this.prisma.user.update({
        where: { id: providerId },
        data: { role: UserRole.PROVIDER },
      });
    }

    const service = await this.prisma.service.create({
      data: {
        providerId,
        title: dto.title.trim(),
        description: dto.description.trim(),
        categoryId,
        basePrice: dto.basePrice,
        pricingType,
        estimatedHours: dto.estimatedHours,
        location: dto.location.trim(),
        latitude: dto.latitude,
        longitude: dto.longitude,
        acceptsUrgent: dto.acceptsUrgent ?? false,
        urgentSurcharge: dto.urgentSurcharge,
        status: autoApprove
          ? ServiceStatus.ACTIVE
          : ServiceStatus.PENDING_REVIEW,
        isActive: autoApprove,
      },
      include: LISTING_INCLUDE,
    });

    return {
      message: autoApprove
        ? 'Serviço criado e publicado com sucesso.'
        : 'Serviço criado com sucesso. Aguarda aprovação do administrador.',
      data: ServicePresenter.toProviderListingItem(service),
    };
  }

  async findAll(query: FindServicesQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const skip = (page - 1) * limit;

    if (
      query.minPrice !== undefined &&
      query.maxPrice !== undefined &&
      query.minPrice > query.maxPrice
    ) {
      throw new BadRequestException(
        'O preço mínimo não pode ser maior que o preço máximo.',
      );
    }

    const where: Prisma.ServiceWhereInput = {
      status: ServiceStatus.ACTIVE,
      isActive: true,
      // Os anúncios de uma conta suspensa saem do catálogo enquanto durar.
      provider: { isActive: true },
    };

    if (query.search?.trim()) {
      const search = query.search.trim();
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { location: { contains: search, mode: 'insensitive' } },
        {
          category: { is: { name: { contains: search, mode: 'insensitive' } } },
        },
      ];
    }

    // A categoria pedida e as que estão debaixo dela.
    const categoryIds = await categoryScope(this.prisma, query);
    if (categoryIds) {
      where.categoryId = { in: categoryIds };
    }

    if (query.location?.trim()) {
      where.location = { contains: query.location.trim(), mode: 'insensitive' };
    }

    if (query.isUrgent !== undefined) {
      where.acceptsUrgent = query.isUrgent;
    }

    if (query.minPrice !== undefined || query.maxPrice !== undefined) {
      where.basePrice = {};
      if (query.minPrice !== undefined) where.basePrice.gte = query.minPrice;
      if (query.maxPrice !== undefined) where.basePrice.lte = query.maxPrice;
    }

    const orderBy = this.buildOrderBy(query.sortBy);

    const [items, total] = await Promise.all([
      this.prisma.service.findMany({
        where,
        skip,
        take: limit,
        orderBy,
        include: LISTING_INCLUDE,
      }),
      this.prisma.service.count({ where }),
    ]);

    return {
      message: 'Serviços obtidos com sucesso.',
      data: items.map((item) => ServicePresenter.toListItem(item)),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total,
        hasPreviousPage: page > 1,
      },
    };
  }

  /**
   * Detalhe público: só anúncios activos. Quem gere o anúncio também o recebe
   * fora do catálogo, como em `findMine`: a app abre-o por esta rota.
   */
  async findOne(id: string, viewerId?: string) {
    const service = await this.prisma.service.findFirst({
      where: {
        id,
        status: ServiceStatus.ACTIVE,
        provider: { isActive: true },
      },
      include: {
        provider: { select: PROVIDER_DETAIL_SELECT },
        category: { select: CATEGORY_SELECT },
        photos: { orderBy: PHOTOS_ORDER },
        _count: COMPLETED_JOBS,
      },
    });

    if (!service) {
      if (!viewerId) throw new NotFoundException(NOT_FOUND);
      return hideFromOutsiders(() => this.findMine(viewerId, id), NOT_FOUND);
    }

    return {
      message: 'Serviço obtido com sucesso.',
      data: ServicePresenter.toDetails(service),
    };
  }

  /**
   * O anúncio como o provider o vê, em qualquer estado menos removido. O
   * detalhe público só mostra anúncios activos, por isso é daqui que a app
   * lê um anúncio em revisão ou rejeitado para o editar.
   */
  async findMine(userId: string, id: string) {
    const service = await this.prisma.service.findUnique({
      where: { id },
      include: {
        provider: { select: PROVIDER_DETAIL_SELECT },
        category: { select: CATEGORY_SELECT },
        photos: { orderBy: PHOTOS_ORDER },
        _count: COMPLETED_JOBS,
      },
    });

    if (!service || service.status === ServiceStatus.DELETED) {
      throw new NotFoundException(NOT_FOUND);
    }

    await this.managerRoleOf(
      userId,
      service.providerId,
      'Não tens permissão para ver este anúncio.',
    );

    return {
      message: 'Serviço obtido com sucesso.',
      data: ServicePresenter.toProviderDetails(service),
    };
  }

  async findMyListings(userId: string, query: ListingsPage = {}) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });

    if (!user) {
      throw new NotFoundException('Utilizador não encontrado.');
    }

    // Um anúncio removido deixa de aparecer, como nos equipamentos.
    const where: Prisma.ServiceWhereInput =
      user.role === UserRole.ADMIN
        ? { status: { not: ServiceStatus.DELETED } }
        : { providerId: userId, status: { not: ServiceStatus.DELETED } };

    return {
      message: 'Serviços obtidos com sucesso.',
      ...(await this.listingsPage(where, { createdAt: 'desc' }, query)),
    };
  }

  async findPending(adminId: string, query: ListingsPage = {}) {
    await this.assertAdmin(adminId);

    return {
      message: 'Serviços pendentes de revisão obtidos com sucesso.',
      ...(await this.listingsPage(
        { status: ServiceStatus.PENDING_REVIEW },
        { createdAt: 'asc' },
        query,
      )),
    };
  }

  async approve(adminId: string, serviceId: string) {
    await this.assertAdmin(adminId);

    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
      select: {
        id: true,
        status: true,
        provider: { select: { listingsSuspendedUntil: true } },
      },
    });

    if (!service) {
      throw new NotFoundException('Serviço não encontrado.');
    }

    if (service.status === ServiceStatus.ACTIVE) {
      throw new BadRequestException('Este serviço já está activo.');
    }

    if (service.status === ServiceStatus.DELETED) {
      throw new BadRequestException(
        'Não é possível aprovar um serviço removido.',
      );
    }

    const suspendedUntil = service.provider?.listingsSuspendedUntil;
    const providerIsSuspended = !!suspendedUntil && suspendedUntil > new Date();

    const updated = await this.prisma.service.update({
      where: { id: serviceId },
      data: {
        status: ServiceStatus.ACTIVE,
        // A aprovação não desfaz uma suspensão por strikes: o anúncio fica
        // aprovado, mas pausado até a suspensão acabar.
        isActive: !providerIsSuspended,
        rejectionReason: null,
        rejectedAt: null,
      },
      include: {
        provider: { select: { ...PROVIDER_SELECT, pushToken: true } },
        category: { select: CATEGORY_SELECT },
        photos: { orderBy: PHOTOS_ORDER },
        _count: COMPLETED_JOBS,
      },
    });

    this.notifyProvider(updated.provider?.pushToken, {
      title: 'Serviço aprovado',
      body: `"${updated.title}" já está visível no catálogo público.`,
      data: { type: 'service_approved', serviceId },
    });

    await this.audit.record({
      action: AuditAction.SERVICE_APPROVED,
      actorId: adminId,
      targetType: 'Service',
      targetId: serviceId,
      metadata: { previousStatus: service.status, title: updated.title },
    });

    return {
      message: 'Serviço aprovado com sucesso.',
      data: ServicePresenter.toProviderListingItem(updated),
    };
  }

  async reject(adminId: string, serviceId: string, reason?: string) {
    await this.assertAdmin(adminId);

    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
      select: { id: true, status: true },
    });

    if (!service) {
      throw new NotFoundException('Serviço não encontrado.');
    }

    if (service.status === ServiceStatus.REJECTED) {
      throw new BadRequestException('Este serviço já foi rejeitado.');
    }

    if (service.status === ServiceStatus.DELETED) {
      throw new BadRequestException(
        'Não é possível rejeitar um serviço removido.',
      );
    }

    const rejectionReason = reason?.trim() || null;

    const updated = await this.prisma.service.update({
      where: { id: serviceId },
      data: {
        status: ServiceStatus.REJECTED,
        isActive: false,
        // Fica no anúncio para o provider saber o que corrigir.
        rejectionReason,
        rejectedAt: new Date(),
      },
      include: {
        provider: { select: { ...PROVIDER_SELECT, pushToken: true } },
        category: { select: CATEGORY_SELECT },
        photos: { orderBy: PHOTOS_ORDER },
        _count: COMPLETED_JOBS,
      },
    });

    this.notifyProvider(updated.provider?.pushToken, {
      title: 'Anúncio rejeitado',
      body: rejectionReason
        ? `"${updated.title}" não foi aprovado. Motivo: ${rejectionReason.replace(/\.+$/, '')}. Corrige o anúncio e guarda para pedir nova revisão.`
        : `"${updated.title}" não foi aprovado. Corrige o anúncio e guarda para pedir nova revisão.`,
      data: { type: 'service_rejected', serviceId },
    });

    await this.audit.record({
      action: AuditAction.SERVICE_REJECTED,
      actorId: adminId,
      targetType: 'Service',
      targetId: serviceId,
      metadata: {
        previousStatus: service.status,
        title: updated.title,
        reason: rejectionReason,
      },
    });

    return {
      message: rejectionReason
        ? `Serviço rejeitado. Motivo: ${rejectionReason}`
        : 'Serviço rejeitado.',
      data: ServicePresenter.toProviderListingItem(updated),
    };
  }

  async toggleAvailability(userId: string, serviceId: string) {
    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
      select: { id: true, providerId: true, status: true, isActive: true },
    });

    if (!service) {
      throw new NotFoundException('Serviço não encontrado.');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });

    if (!user) {
      throw new NotFoundException('Utilizador não encontrado.');
    }

    const canManage =
      user.role === UserRole.ADMIN || service.providerId === userId;

    if (!canManage) {
      throw new ForbiddenException(
        'Não tens permissão para alterar este serviço.',
      );
    }

    if (service.status !== ServiceStatus.ACTIVE) {
      throw new BadRequestException(
        'Apenas serviços activos podem ter a disponibilidade alterada.',
      );
    }

    if (!service.isActive && user.role !== UserRole.ADMIN) {
      await this.assertProviderMayReopenListings(service.providerId);
    }

    const updated = await this.prisma.service.update({
      where: { id: serviceId },
      data: { isActive: !service.isActive },
      include: LISTING_INCLUDE,
    });

    return {
      message: updated.isActive
        ? 'Serviço marcado como disponível.'
        : 'Serviço marcado como indisponível.',
      data: ServicePresenter.toProviderListingItem(updated),
    };
  }

  /**
   * Edita um anúncio. Só conta o que muda de facto. Mudar o que um admin
   * aprovou devolve o anúncio à revisão, e qualquer mudança num anúncio
   * rejeitado pede nova revisão.
   */
  async update(userId: string, id: string, dto: UpdateServiceDto) {
    const existing = await this.prisma.service.findUnique({
      where: { id },
      select: EDITABLE_SELECT,
    });

    if (!existing || existing.status === ServiceStatus.DELETED) {
      throw new NotFoundException(NOT_FOUND);
    }

    const editorRole = await this.managerRoleOf(
      userId,
      existing.providerId,
      'Não tens permissão para editar este serviço.',
    );

    const patch = this.toPatch(dto);
    const changed = changedFields(existing, patch);

    if (patch.categoryId !== undefined && changed.includes('categoryId')) {
      await this.assertServiceCategory(patch.categoryId);
    }

    const willAcceptUrgent = dto.acceptsUrgent ?? existing.acceptsUrgent;
    const willHaveSurcharge =
      dto.urgentSurcharge ?? existing.urgentSurcharge ?? undefined;

    if (willAcceptUrgent && willHaveSurcharge === undefined) {
      throw new BadRequestException(
        'urgentSurcharge é obrigatório se acceptsUrgent=true.',
      );
    }

    if (!willAcceptUrgent && dto.urgentSurcharge !== undefined) {
      throw new BadRequestException(
        'urgentSurcharge só pode ser definido se acceptsUrgent=true.',
      );
    }

    const backToReview = returnsToReview({
      status: existing.status,
      editor: this.editorOf(editorRole),
      changed: changed.length > 0,
      moderatedContentChanged: changed.some((field) =>
        MODERATED_FIELDS.includes(field),
      ),
    });

    const updated = await this.prisma.service.update({
      where: { id },
      data: {
        ...patch,
        urgentSurcharge:
          dto.acceptsUrgent === false ? null : dto.urgentSurcharge,
        ...(backToReview ? { status: ServiceStatus.PENDING_REVIEW } : {}),
      },
      include: LISTING_INCLUDE,
    });

    if (backToReview) {
      await this.audit.record({
        action: AuditAction.SERVICE_SENT_TO_REVIEW,
        actorId: userId,
        targetType: 'Service',
        targetId: id,
        metadata: {
          previousStatus: existing.status,
          changed,
          title: updated.title,
        },
      });
    }

    return {
      message: this.editMessage(backToReview, existing.status),
      data: ServicePresenter.toProviderListingItem(updated),
    };
  }

  /**
   * As fotos de um anúncio mudaram. Uma foto nova é conteúdo que nenhum
   * admin viu, por isso conta como mudar o que foi aprovado. Devolve true
   * quando o anúncio voltou à revisão.
   */
  async reviewAfterPhotoChange(change: {
    actorId: string;
    actorRole: UserRole;
    service: { id: string; status: ServiceStatus };
    addedPhotos: boolean;
  }): Promise<boolean> {
    const { service } = change;

    const backToReview = returnsToReview({
      status: service.status,
      editor: this.editorOf(change.actorRole),
      changed: true,
      moderatedContentChanged: change.addedPhotos,
    });

    if (!backToReview) {
      return false;
    }

    await this.prisma.service.update({
      where: { id: service.id },
      data: { status: ServiceStatus.PENDING_REVIEW },
    });

    await this.audit.record({
      action: AuditAction.SERVICE_SENT_TO_REVIEW,
      actorId: change.actorId,
      targetType: 'Service',
      targetId: service.id,
      metadata: { previousStatus: service.status, changed: ['photos'] },
    });

    return true;
  }

  async remove(userId: string, id: string) {
    const existing = await this.prisma.service.findUnique({
      where: { id },
      select: { id: true, providerId: true, status: true },
    });

    if (!existing || existing.status === ServiceStatus.DELETED) {
      throw new NotFoundException(NOT_FOUND);
    }

    const actorRole = await this.managerRoleOf(
      userId,
      existing.providerId,
      'Não tens permissão para remover este serviço.',
    );

    // Dentro da transacção, para não se cruzar com um orçamento que é
    // aceite ao mesmo tempo.
    await runSerializable(
      this.prisma,
      async (tx) => {
        const inProgress = await tx.serviceBooking.count({
          where: { serviceId: id, status: { in: BOOKINGS_IN_PROGRESS } },
        });

        if (inProgress > 0) {
          throw new BadRequestException(REMOVAL_BLOCKED);
        }

        await tx.service.update({
          where: { id },
          data: { status: ServiceStatus.DELETED, isActive: false },
        });
      },
      () =>
        new BadRequestException(
          'Entrou uma reserva enquanto removias o serviço. Actualiza e tenta de novo.',
        ),
    );

    await this.audit.record({
      action: AuditAction.SERVICE_REMOVED,
      actorId: userId,
      targetType: 'Service',
      targetId: id,
      metadata: {
        actorRole,
        providerWasSelf: existing.providerId === userId,
      },
    });

    return { message: 'Serviço removido com sucesso.' };
  }

  /** Uma página de anúncios no formato das listas do provider e do admin. */
  private async listingsPage(
    where: Prisma.ServiceWhereInput,
    orderBy: Prisma.ServiceOrderByWithRelationInput,
    query: ListingsPage,
  ) {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit =
      query.limit && query.limit > 0 ? query.limit : DEFAULT_LISTINGS_PAGE_SIZE;

    const [items, total] = await Promise.all([
      this.prisma.service.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy,
        include: LISTING_INCLUDE,
      }),
      this.prisma.service.count({ where }),
    ]);

    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

    return {
      data: items.map((item) => ServicePresenter.toProviderListingItem(item)),
      meta: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },
    };
  }

  /** A categoria existe, está activa e serve para serviços. */
  private async assertServiceCategory(categoryId: string) {
    const category = await this.prisma.category.findFirst({
      where: { id: categoryId, isActive: true },
    });

    if (!category) {
      throw new BadRequestException('Categoria não encontrada ou inativa.');
    }

    if (
      category.kind !== CategoryKind.SERVICE &&
      category.kind !== CategoryKind.BOTH
    ) {
      throw new BadRequestException(
        'Esta categoria não está marcada para serviços.',
      );
    }
  }

  /**
   * Quem edita: um admin, um provider que publica sem revisão (com a
   * auto-aprovação ligada no ambiente, em desenvolvimento) ou outro provider.
   */
  private editorOf(role: UserRole): ListingEditor {
    if (role === UserRole.ADMIN) {
      return 'admin';
    }

    return process.env.AUTO_APPROVE_SERVICES === 'true'
      ? 'trusted-owner'
      : 'owner';
  }

  /**
   * Confirma que quem pede é o provider do anúncio ou um admin, e devolve o
   * papel dele.
   */
  private async managerRoleOf(
    userId: string,
    providerId: string,
    forbiddenMessage: string,
  ): Promise<UserRole> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });

    if (!user) {
      throw new NotFoundException('Utilizador não encontrado.');
    }

    if (user.role !== UserRole.ADMIN && providerId !== userId) {
      throw new ForbiddenException(forbiddenMessage);
    }

    return user.role;
  }

  /** O pedido de edição com os nomes das colunas. O que não veio fica undefined. */
  private toPatch(dto: UpdateServiceDto) {
    return {
      title: dto.title?.trim(),
      description: dto.description?.trim(),
      categoryId: dto.categoryId?.trim(),
      basePrice: dto.basePrice,
      pricingType: dto.pricingType,
      estimatedHours: dto.estimatedHours,
      location: dto.location?.trim(),
      latitude: dto.latitude,
      longitude: dto.longitude,
      acceptsUrgent: dto.acceptsUrgent,
    };
  }

  private editMessage(backToReview: boolean, previous: ServiceStatus) {
    if (!backToReview) {
      return UPDATED;
    }

    return previous === ServiceStatus.REJECTED ? RESUBMITTED : SENT_TO_REVIEW;
  }

  /** Aviso ao provider sobre a moderação. Se falhar, não trava a operação. */
  private notifyProvider(
    pushToken: string | null | undefined,
    notice: { title: string; body: string; data: Record<string, string> },
  ) {
    if (!pushToken) {
      return;
    }

    this.push.send({ to: pushToken, ...notice }).catch(() => {});
  }

  private buildOrderBy(
    sortBy?: ServiceSortBy,
  ): Prisma.ServiceOrderByWithRelationInput[] {
    switch (sortBy) {
      case ServiceSortBy.LOWEST_PRICE:
        return [{ basePrice: 'asc' }, { createdAt: 'desc' }];

      case ServiceSortBy.HIGHEST_PRICE:
        return [{ basePrice: 'desc' }, { createdAt: 'desc' }];

      case ServiceSortBy.RELEVANT:
        // Os mais avaliados e os de melhor nota primeiro. O contador de
        // trabalhos concluídos nunca foi mantido.
        return [
          { totalReviews: 'desc' },
          { totalRating: { sort: 'desc', nulls: 'last' } },
          { createdAt: 'desc' },
        ];

      case ServiceSortBy.NEAREST:
      case ServiceSortBy.NEWEST:
      default:
        return [{ createdAt: 'desc' }];
    }
  }

  // Defesa em profundidade: além do RolesGuard no controller, os métodos
  // de moderação revalidam o role na base de dados.
  /**
   * Um provider com os anúncios suspensos por strikes não reabre um serviço
   * antes de a suspensão acabar.
   */
  private async assertProviderMayReopenListings(providerId: string) {
    const provider = await this.prisma.user.findUnique({
      where: { id: providerId },
      select: { listingsSuspendedUntil: true },
    });

    if (
      provider?.listingsSuspendedUntil &&
      provider.listingsSuspendedUntil > new Date()
    ) {
      throw new ForbiddenException(
        'Os teus anúncios estão suspensos por cancelamentos de reservas e ainda não podem voltar a aceitar pedidos.',
      );
    }
  }

  private async assertAdmin(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });

    if (!user || user.role !== UserRole.ADMIN) {
      throw new ForbiddenException(
        'Não tens permissão para executar esta operação.',
      );
    }
  }
}
