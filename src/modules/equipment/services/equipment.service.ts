import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  BookingStatus,
  CategoryKind,
  EquipmentCondition,
  EquipmentStatus,
  Prisma,
  UserRole,
} from '@prisma/client';

import { AuditService } from '../../../shared/audit/audit.service';
import { categoryScope } from '../../../shared/categories/category-scope';
import { PrismaService } from '../../../shared/db/prisma.service';
import { runSerializable } from '../../../shared/db/serializable-transaction';
import { MetricsService } from '../../../shared/metrics/metrics.service';
import { hideFromOutsiders } from '../../../shared/moderation/hide-from-outsiders';
import {
  changedFields,
  ListingEditor,
  returnsToReview,
} from '../../../shared/moderation/listing-moderation';
import { PushService } from '../../../shared/push/push.service';
import {
  peakOccupancy,
  RESERVING_STATUSES,
  startOfDay,
  todayAsPeriod,
} from '../../bookings/booking-occupancy';
import type { OccupancyPeriod } from '../../bookings/booking-occupancy';
import { RENTAL_PAID_OUT_STATUSES } from '../../payments/payment-states';
import { VerificationsService } from '../../verifications/services/verifications.service';
import { CreateEquipmentDto } from '../dto/create-equipment.dto';
import {
  EquipmentSortBy,
  FindEquipmentQueryDto,
} from '../dto/find-equipment-query.dto';
import { UpdateEquipmentDto } from '../dto/update-equipment.dto';
import { EquipmentPresenter } from '../presenters/equipment.presenter';
import { EquipmentAvailabilityService } from './equipment-availability.service';

const OWNER_SELECT = {
  id: true,
  name: true,
  avatarUrl: true,
} as const;

const OWNER_DETAIL_SELECT = {
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
 * Quantos alugueres do anúncio chegaram ao fim. Conta-se nas reservas em vez
 * de se guardar num contador, que ninguém mantinha e mostrava sempre zero.
 */
const COMPLETED_RENTALS = {
  select: { bookings: { where: { status: BookingStatus.COMPLETED } } },
} satisfies Prisma.EquipmentInclude['_count'];

/** O anúncio como sai nas listas, públicas e do dono. */
const LISTING_INCLUDE = {
  owner: { select: OWNER_SELECT },
  category: { select: CATEGORY_SELECT },
  photos: { orderBy: PHOTOS_ORDER },
  _count: COMPLETED_RENTALS,
} satisfies Prisma.EquipmentInclude;

/** O que uma edição precisa de saber do anúncio para ver o que muda. */
const EDITABLE_SELECT = {
  id: true,
  ownerId: true,
  status: true,
  title: true,
  description: true,
  categoryId: true,
  pricePerDay: true,
  pricePerWeek: true,
  pricePerMonth: true,
  depositAmount: true,
  location: true,
  latitude: true,
  longitude: true,
  deliveryIncluded: true,
  operatorAvailable: true,
  isAvailable: true,
  condition: true,
  quantity: true,
} satisfies Prisma.EquipmentSelect;

/** O que um admin aprovou. Mudá-lo devolve o anúncio à revisão. */
const MODERATED_FIELDS: readonly string[] = [
  'title',
  'description',
  'categoryId',
];

const NOT_FOUND = 'Equipamento não encontrado.';
const UPDATED = 'Equipamento atualizado com sucesso.';
const SENT_TO_REVIEW =
  'Alterações guardadas. Como mudou o que tinha sido aprovado, o anúncio volta à revisão antes de ficar público.';
const RESUBMITTED =
  'Alterações guardadas. O anúncio foi enviado de novo para revisão.';
const REMOVAL_BLOCKED =
  'Este equipamento tem reservas em curso. Pausa o anúncio para não receber mais e remove-o quando elas terminarem.';

/** Quantos anúncios por página nas listas do dono e do admin, por omissão. */
const DEFAULT_LISTINGS_PAGE_SIZE = 50;

@Injectable()
export class EquipmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly verifications: VerificationsService,
    private readonly push: PushService,
    private readonly metrics: MetricsService,
    private readonly availability: EquipmentAvailabilityService,
  ) {}

  async create(ownerId: string, dto: CreateEquipmentDto) {
    const categoryId = dto.categoryId.trim();
    const owner = await this.prisma.user.findUnique({
      where: { id: ownerId },
      select: { role: true, listingsSuspendedUntil: true },
    });

    // Providers com strikes acumulados ficam suspensos de
    // publicar novas listagens durante o período de suspensão.
    if (
      owner?.listingsSuspendedUntil &&
      owner.listingsSuspendedUntil > new Date()
    ) {
      throw new ForbiddenException(
        'A tua conta está temporariamente suspensa de publicar listagens devido a cancelamentos de reservas confirmadas.',
      );
    }

    await this.assertEquipmentCategory(categoryId);

    const autoApprove = await this.publishesWithoutReview(ownerId);
    const quantity = dto.quantity && dto.quantity > 0 ? dto.quantity : 1;

    // Quem publica passa a PROVIDER. Só depois de o pedido estar validado:
    // um anúncio recusado não muda a conta.
    if (owner?.role === UserRole.CLIENT) {
      await this.prisma.user.update({
        where: { id: ownerId },
        data: { role: UserRole.PROVIDER },
      });
    }

    const equipment = await this.prisma.equipment.create({
      data: {
        ownerId,
        title: dto.title.trim(),
        description: dto.description.trim(),
        categoryId,
        pricePerDay: dto.pricePerDay,
        pricePerWeek: dto.pricePerWeek,
        pricePerMonth: dto.pricePerMonth,
        depositAmount: dto.depositAmount,
        location: dto.location.trim(),
        latitude: dto.latitude,
        longitude: dto.longitude,
        deliveryIncluded: dto.deliveryAvailable ?? false,
        operatorAvailable: dto.operatorAvailable ?? false,
        condition: dto.condition ?? EquipmentCondition.GOOD,
        status: autoApprove
          ? EquipmentStatus.ACTIVE
          : EquipmentStatus.PENDING_REVIEW,
        isAvailable: autoApprove,
        quantity,
        availableQuantity: quantity,
      },
      include: LISTING_INCLUDE,
    });

    return {
      message: autoApprove
        ? 'Equipamento criado e publicado com sucesso.'
        : 'Equipamento criado com sucesso. Aguarda aprovação do administrador.',
      // Acabado de criar, ainda não tem reservas: estão todas livres.
      data: EquipmentPresenter.toOwnerListingItem(equipment, quantity),
    };
  }

  async findAll(query: FindEquipmentQueryDto) {
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

    const where: Prisma.EquipmentWhereInput = {
      status: EquipmentStatus.ACTIVE,
      // Os anúncios de uma conta suspensa saem do catálogo enquanto durar.
      owner: { isActive: true },
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

    if (query.ownerId?.trim()) {
      where.ownerId = query.ownerId.trim();
    }

    if (query.location?.trim()) {
      where.location = { contains: query.location.trim(), mode: 'insensitive' };
    }

    // `deliveryIncluded` é o nome antigo do filtro, que a app ainda envia.
    const delivery = query.deliveryAvailable ?? query.deliveryIncluded;
    if (delivery !== undefined) {
      where.deliveryIncluded = delivery;
    }

    if (query.operatorAvailable !== undefined) {
      where.operatorAvailable = query.operatorAvailable;
    }

    await this.excludeFullyBooked(where, query);

    if (query.condition !== undefined) {
      where.condition = query.condition;
    }

    if (query.minPrice !== undefined || query.maxPrice !== undefined) {
      where.pricePerDay = {};
      if (query.minPrice !== undefined) where.pricePerDay.gte = query.minPrice;
      if (query.maxPrice !== undefined) where.pricePerDay.lte = query.maxPrice;
    }

    const orderBy = this.buildOrderBy(query.sortBy);

    const [items, total] = await Promise.all([
      this.prisma.equipment.findMany({
        where,
        skip,
        take: limit,
        orderBy,
        include: LISTING_INCLUDE,
      }),
      this.prisma.equipment.count({ where }),
    ]);

    const totalPages = Math.ceil(total / limit);

    return {
      message: 'Equipamentos obtidos com sucesso.',
      data: await this.withFreeUnits(items, (item, freeUnitsToday) =>
        EquipmentPresenter.toListItem(item, freeUnitsToday),
      ),
      meta: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page * limit < total,
        hasPreviousPage: page > 1,
      },
      // A app ainda lê a paginação desta lista no topo; repete-se a de `meta`.
      total,
      page,
      limit,
      totalPages,
    };
  }

  /**
   * Detalhe público: só anúncios activos. Quem gere o anúncio também o recebe
   * fora do catálogo, como em `findMine`: a app edita a partir desta rota.
   */
  async findOne(id: string, viewerId?: string) {
    const equipment = await this.prisma.equipment.findFirst({
      where: {
        id,
        status: EquipmentStatus.ACTIVE,
        owner: { isActive: true },
      },
      include: {
        owner: { select: OWNER_DETAIL_SELECT },
        category: { select: CATEGORY_SELECT },
        photos: { orderBy: PHOTOS_ORDER },
        _count: COMPLETED_RENTALS,
      },
    });

    if (!equipment) {
      if (!viewerId) throw new NotFoundException(NOT_FOUND);
      return hideFromOutsiders(() => this.findMine(viewerId, id), NOT_FOUND);
    }

    return {
      message: 'Equipamento obtido com sucesso.',
      data: EquipmentPresenter.toDetails(
        equipment,
        await this.freeUnitsOf(equipment),
      ),
    };
  }

  /**
   * O anúncio como o dono o vê, em qualquer estado menos removido. O detalhe
   * público só mostra anúncios activos, por isso é daqui que a app lê um
   * anúncio em revisão ou rejeitado para o editar.
   */
  async findMine(userId: string, id: string) {
    const equipment = await this.prisma.equipment.findUnique({
      where: { id },
      include: {
        owner: { select: OWNER_DETAIL_SELECT },
        category: { select: CATEGORY_SELECT },
        photos: { orderBy: PHOTOS_ORDER },
        _count: COMPLETED_RENTALS,
      },
    });

    if (!equipment || equipment.status === EquipmentStatus.DELETED) {
      throw new NotFoundException(NOT_FOUND);
    }

    await this.managerRoleOf(
      userId,
      equipment.ownerId,
      'Não tens permissão para ver este anúncio.',
    );

    return {
      message: 'Equipamento obtido com sucesso.',
      data: EquipmentPresenter.toOwnerDetails(
        equipment,
        await this.freeUnitsOf(equipment),
      ),
    };
  }

  async getProviderAnalytics(userId: string) {
    const [equipmentByStatus, bookingsByStatus, payouts, ratingAgg] =
      await Promise.all([
        this.prisma.equipment.groupBy({
          by: ['status'],
          where: { ownerId: userId },
          _count: { _all: true },
        }),
        this.prisma.booking.groupBy({
          by: ['status'],
          where: { ownerId: userId },
          _count: { _all: true },
        }),
        this.prisma.payment.aggregate({
          // Só o que foi mesmo pago ao provider. Um pagamento por entrar,
          // reembolsado ou falhado não é receita.
          where: { ownerId: userId, status: { in: RENTAL_PAID_OUT_STATUSES } },
          _sum: { ownerPayout: true, totalCharged: true },
          _count: { _all: true },
        }),
        this.prisma.user.findUnique({
          where: { id: userId },
          select: { providerRating: true, providerReviews: true },
        }),
      ]);

    const bucketBy = <T extends string>(
      rows: Array<{ status: T; _count: { _all: number } }>,
    ): Record<string, number> =>
      rows.reduce<Record<string, number>>((acc, r) => {
        acc[r.status] = r._count._all;
        return acc;
      }, {});

    const eqBuckets = bucketBy(equipmentByStatus);
    const bkBuckets = bucketBy(bookingsByStatus);
    const totalEquipment = Object.values(eqBuckets).reduce((a, b) => a + b, 0);
    const totalBookings = Object.values(bkBuckets).reduce((a, b) => a + b, 0);

    return {
      message: 'Analytics obtidos com sucesso.',
      data: {
        equipment: {
          total: totalEquipment,
          active: eqBuckets.ACTIVE ?? 0,
          pendingReview: eqBuckets.PENDING_REVIEW ?? 0,
          paused: eqBuckets.PAUSED ?? 0,
          rejected: eqBuckets.REJECTED ?? 0,
          deleted: eqBuckets.DELETED ?? 0,
        },
        bookings: {
          total: totalBookings,
          pending: bkBuckets.PENDING ?? 0,
          confirmed: bkBuckets.CONFIRMED ?? 0,
          active: bkBuckets.ACTIVE ?? 0,
          completed: bkBuckets.COMPLETED ?? 0,
          cancelled: bkBuckets.CANCELLED ?? 0,
          disputed: bkBuckets.DISPUTED ?? 0,
        },
        revenue: {
          currency: 'MZN',
          totalPayments: payouts._count?._all ?? 0,
          totalCharged: Number(payouts._sum?.totalCharged ?? 0),
          totalPayout: Number(payouts._sum?.ownerPayout ?? 0),
        },
        rating: {
          average: ratingAgg?.providerRating
            ? Number(ratingAgg.providerRating)
            : null,
          totalReviews: ratingAgg?.providerReviews ?? 0,
        },
      },
    };
  }

  async findMyListings(
    userId: string,
    query: { page?: number; limit?: number } = {},
  ) {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 50;
    const skip = (page - 1) * limit;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });

    if (!user) {
      throw new NotFoundException('Utilizador não encontrado.');
    }

    const where: Prisma.EquipmentWhereInput =
      user.role === UserRole.ADMIN
        ? { status: { not: EquipmentStatus.DELETED } }
        : { ownerId: userId, status: { not: EquipmentStatus.DELETED } };

    const [items, total] = await Promise.all([
      this.prisma.equipment.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: LISTING_INCLUDE,
      }),
      this.prisma.equipment.count({ where }),
    ]);

    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

    return {
      message: 'Equipamentos obtidos com sucesso.',
      data: await this.withFreeUnits(items, (item, freeUnitsToday) =>
        EquipmentPresenter.toOwnerListingItem(item, freeUnitsToday),
      ),
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

  async approve(adminId: string, equipmentId: string) {
    await this.assertAdmin(adminId);

    const equipment = await this.prisma.equipment.findUnique({
      where: { id: equipmentId },
      select: {
        id: true,
        status: true,
        owner: { select: { listingsSuspendedUntil: true } },
      },
    });

    if (!equipment) {
      throw new NotFoundException('Equipamento não encontrado.');
    }

    if (equipment.status === EquipmentStatus.ACTIVE) {
      throw new BadRequestException('Este equipamento já está activo.');
    }

    if (equipment.status === EquipmentStatus.DELETED) {
      throw new BadRequestException(
        'Não é possível aprovar um equipamento removido.',
      );
    }

    const suspendedUntil = equipment.owner?.listingsSuspendedUntil;
    const ownerIsSuspended = !!suspendedUntil && suspendedUntil > new Date();

    const updated = await this.prisma.equipment.update({
      where: { id: equipmentId },
      data: {
        status: EquipmentStatus.ACTIVE,
        // A aprovação não desfaz uma suspensão por strikes: o anúncio fica
        // público, mas pausado até a suspensão acabar.
        isAvailable: !ownerIsSuspended,
        rejectionReason: null,
        rejectedAt: null,
      },
      include: {
        owner: { select: { ...OWNER_SELECT, pushToken: true } },
        category: { select: CATEGORY_SELECT },
        photos: { orderBy: PHOTOS_ORDER },
        _count: COMPLETED_RENTALS,
      },
    });

    await this.audit.record({
      action: AuditAction.EQUIPMENT_APPROVED,
      actorId: adminId,
      targetType: 'Equipment',
      targetId: equipmentId,
      metadata: { previousStatus: equipment.status, title: updated.title },
    });

    this.metrics.businessEvents.inc({ event: 'equipment_approved' });

    if (updated.owner?.pushToken) {
      this.push
        .send({
          to: updated.owner.pushToken,
          title: '✅ Equipamento aprovado',
          body: `"${updated.title}" já está visível no catálogo público.`,
          data: { type: 'equipment_approved', equipmentId },
        })
        .catch(() => {});
    }

    return {
      message: 'Equipamento aprovado com sucesso.',
      data: EquipmentPresenter.toOwnerListingItem(
        updated,
        await this.freeUnitsOf(updated),
      ),
    };
  }

  async reject(adminId: string, equipmentId: string, reason?: string) {
    await this.assertAdmin(adminId);

    const equipment = await this.prisma.equipment.findUnique({
      where: { id: equipmentId },
      select: { id: true, status: true },
    });

    if (!equipment) {
      throw new NotFoundException('Equipamento não encontrado.');
    }

    if (equipment.status === EquipmentStatus.REJECTED) {
      throw new BadRequestException('Este equipamento já foi rejeitado.');
    }

    if (equipment.status === EquipmentStatus.DELETED) {
      throw new BadRequestException(
        'Não é possível rejeitar um equipamento removido.',
      );
    }

    const rejectionReason = reason?.trim() || null;

    const updated = await this.prisma.equipment.update({
      where: { id: equipmentId },
      data: {
        status: EquipmentStatus.REJECTED,
        isAvailable: false,
        // Fica no anúncio para o dono saber o que corrigir.
        rejectionReason,
        rejectedAt: new Date(),
      },
      include: {
        owner: { select: { ...OWNER_SELECT, pushToken: true } },
        category: { select: CATEGORY_SELECT },
        photos: { orderBy: PHOTOS_ORDER },
        _count: COMPLETED_RENTALS,
      },
    });

    if (updated.owner?.pushToken) {
      this.push
        .send({
          to: updated.owner.pushToken,
          title: 'Anúncio rejeitado',
          body: rejectionReason
            ? `"${updated.title}" não foi aprovado. Motivo: ${rejectionReason.replace(/\.+$/, '')}. Corrige o anúncio e guarda para pedir nova revisão.`
            : `"${updated.title}" não foi aprovado. Corrige o anúncio e guarda para pedir nova revisão.`,
          data: { type: 'equipment_rejected', equipmentId },
        })
        .catch(() => {});
    }

    await this.audit.record({
      action: AuditAction.EQUIPMENT_REJECTED,
      actorId: adminId,
      targetType: 'Equipment',
      targetId: equipmentId,
      metadata: {
        previousStatus: equipment.status,
        title: updated.title,
        reason: rejectionReason,
      },
    });

    return {
      message: rejectionReason
        ? `Equipamento rejeitado. Motivo: ${rejectionReason}`
        : 'Equipamento rejeitado.',
      data: EquipmentPresenter.toOwnerListingItem(
        updated,
        await this.freeUnitsOf(updated),
      ),
    };
  }

  async toggleAvailability(userId: string, equipmentId: string) {
    const equipment = await this.prisma.equipment.findUnique({
      where: { id: equipmentId },
      select: { id: true, ownerId: true, status: true, isAvailable: true },
    });

    if (!equipment) {
      throw new NotFoundException('Equipamento não encontrado.');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });

    if (!user) {
      throw new NotFoundException('Utilizador não encontrado.');
    }

    const canManage =
      user.role === UserRole.ADMIN || equipment.ownerId === userId;

    if (!canManage) {
      throw new ForbiddenException(
        'Não tens permissão para alterar este equipamento.',
      );
    }

    if (equipment.status !== EquipmentStatus.ACTIVE) {
      throw new BadRequestException(
        'Apenas equipamentos activos podem ter a disponibilidade alterada.',
      );
    }

    if (!equipment.isAvailable) {
      await this.assertOwnerMayReopenListings(equipment.ownerId, user.role);
    }

    const updated = await this.prisma.equipment.update({
      where: { id: equipmentId },
      data: { isAvailable: !equipment.isAvailable },
      include: LISTING_INCLUDE,
    });

    await this.audit.record({
      action: AuditAction.EQUIPMENT_AVAILABILITY_TOGGLED,
      actorId: userId,
      targetType: 'Equipment',
      targetId: equipmentId,
      metadata: {
        actorRole: user.role,
        from: equipment.isAvailable,
        to: updated.isAvailable,
        title: updated.title,
      },
    });

    return {
      message: updated.isAvailable
        ? 'Equipamento marcado como disponível.'
        : 'Equipamento marcado como indisponível.',
      data: EquipmentPresenter.toOwnerListingItem(
        updated,
        await this.freeUnitsOf(updated),
      ),
    };
  }

  /**
   * Edita um anúncio. Só conta o que muda de facto: a app envia o formulário
   * inteiro em cada gravação. Mudar o que um admin aprovou devolve o anúncio
   * à revisão, e qualquer mudança num anúncio rejeitado pede nova revisão.
   */
  async update(userId: string, id: string, dto: UpdateEquipmentDto) {
    const existing = await this.prisma.equipment.findUnique({
      where: { id },
      select: EDITABLE_SELECT,
    });

    if (!existing || existing.status === EquipmentStatus.DELETED) {
      throw new NotFoundException(NOT_FOUND);
    }

    const editorRole = await this.managerRoleOf(
      userId,
      existing.ownerId,
      'Não tens permissão para editar este equipamento.',
    );

    if (dto.availableNow === true) {
      await this.assertOwnerMayReopenListings(existing.ownerId, editorRole);
    }

    const patch = this.toPatch(dto);
    const changed = changedFields(existing, patch);

    if (patch.categoryId !== undefined && changed.includes('categoryId')) {
      await this.assertEquipmentCategory(patch.categoryId);
    }

    const backToReview = returnsToReview({
      status: existing.status,
      editor: await this.editorOf(editorRole, existing.ownerId),
      changed: changed.length > 0,
      moderatedContentChanged: changed.some((field) =>
        MODERATED_FIELDS.includes(field),
      ),
    });

    const data: Prisma.EquipmentUncheckedUpdateInput = {
      ...patch,
      ...(backToReview ? { status: EquipmentStatus.PENDING_REVIEW } : {}),
    };

    const updatedEquipment =
      patch.quantity !== undefined && patch.quantity < existing.quantity
        ? await this.updateWithFewerUnits(id, patch.quantity, data)
        : await this.prisma.equipment.update({
            where: { id },
            data,
            include: LISTING_INCLUDE,
          });

    if (backToReview) {
      await this.audit.record({
        action: AuditAction.EQUIPMENT_SENT_TO_REVIEW,
        actorId: userId,
        targetType: 'Equipment',
        targetId: id,
        metadata: {
          previousStatus: existing.status,
          changed,
          title: updatedEquipment.title,
        },
      });
    }

    return {
      message: this.editMessage(backToReview, existing.status),
      data: EquipmentPresenter.toOwnerListingItem(
        updatedEquipment,
        await this.freeUnitsOf(updatedEquipment),
      ),
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
    equipment: { id: string; ownerId: string; status: EquipmentStatus };
    addedPhotos: boolean;
  }): Promise<boolean> {
    const { equipment } = change;

    const backToReview = returnsToReview({
      status: equipment.status,
      editor: await this.editorOf(change.actorRole, equipment.ownerId),
      changed: true,
      moderatedContentChanged: change.addedPhotos,
    });

    if (!backToReview) {
      return false;
    }

    await this.prisma.equipment.update({
      where: { id: equipment.id },
      data: { status: EquipmentStatus.PENDING_REVIEW },
    });

    await this.audit.record({
      action: AuditAction.EQUIPMENT_SENT_TO_REVIEW,
      actorId: change.actorId,
      targetType: 'Equipment',
      targetId: equipment.id,
      metadata: { previousStatus: equipment.status, changed: ['photos'] },
    });

    return true;
  }

  async remove(userId: string, id: string) {
    const existingEquipment = await this.prisma.equipment.findUnique({
      where: { id },
      select: { id: true, ownerId: true, status: true },
    });

    if (
      !existingEquipment ||
      existingEquipment.status === EquipmentStatus.DELETED
    ) {
      throw new NotFoundException(NOT_FOUND);
    }

    const actorRole = await this.managerRoleOf(
      userId,
      existingEquipment.ownerId,
      'Não tens permissão para remover este equipamento.',
    );

    // Dentro da transacção, para não se cruzar com uma reserva que entra ao
    // mesmo tempo e ficaria presa a um anúncio removido.
    await runSerializable(
      this.prisma,
      async (tx) => {
        const inProgress = await tx.booking.count({
          where: { equipmentId: id, status: { in: RESERVING_STATUSES } },
        });

        if (inProgress > 0) {
          throw new BadRequestException(REMOVAL_BLOCKED);
        }

        await tx.equipment.update({
          where: { id },
          data: { status: EquipmentStatus.DELETED, isAvailable: false },
        });
      },
      () =>
        new BadRequestException(
          'Entrou uma reserva enquanto removias o equipamento. Actualiza e tenta de novo.',
        ),
    );

    await this.audit.record({
      action: AuditAction.EQUIPMENT_REMOVED,
      actorId: userId,
      targetType: 'Equipment',
      targetId: id,
      metadata: {
        actorRole,
        ownerWasSelf: existingEquipment.ownerId === userId,
      },
    });

    return {
      message: 'Equipamento removido com sucesso.',
    };
  }

  async findPending(
    adminId: string,
    query: { page?: number; limit?: number } = {},
  ) {
    await this.assertAdmin(adminId);

    const page = query.page && query.page > 0 ? query.page : 1;
    const limit =
      query.limit && query.limit > 0 ? query.limit : DEFAULT_LISTINGS_PAGE_SIZE;
    const where: Prisma.EquipmentWhereInput = {
      status: EquipmentStatus.PENDING_REVIEW,
    };

    const [items, total] = await Promise.all([
      this.prisma.equipment.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'asc' },
        include: LISTING_INCLUDE,
      }),
      this.prisma.equipment.count({ where }),
    ]);

    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

    return {
      message: 'Equipamentos pendentes de revisão obtidos com sucesso.',
      data: await this.withFreeUnits(items, (item, freeUnitsToday) =>
        EquipmentPresenter.toOwnerListingItem(item, freeUnitsToday),
      ),
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

  // Defesa em profundidade: além do RolesGuard no controller, os métodos
  // de moderação revalidam o role na base de dados.
  /**
   * Tira da listagem os equipamentos sem unidade livre: hoje, quando se pede
   * `onlyAvailableNow`, e no período de `availableFrom` a `availableTo`.
   */
  private async excludeFullyBooked(
    where: Prisma.EquipmentWhereInput,
    query: FindEquipmentQueryDto,
  ): Promise<void> {
    const fullyBookedIds: string[] = [];

    if (query.onlyAvailableNow !== undefined) {
      where.isAvailable = query.onlyAvailableNow;
    }

    if (query.onlyAvailableNow) {
      fullyBookedIds.push(
        ...(await this.availability.findFullyBookedIds(todayAsPeriod())),
      );
    }

    const requestedPeriod = this.parseAvailabilityPeriod(query);
    if (requestedPeriod) {
      fullyBookedIds.push(
        ...(await this.availability.findFullyBookedIds(requestedPeriod)),
      );
    }

    if (fullyBookedIds.length > 0) {
      where.id = { notIn: fullyBookedIds };
    }
  }

  /**
   * O período pedido no filtro de datas, ou null se o filtro não foi usado.
   * Vem em dias inteiros, como as reservas: o que aqui aparece livre para um
   * período é o que a criação de uma reserva aceita para esse período.
   */
  private parseAvailabilityPeriod(
    query: FindEquipmentQueryDto,
  ): OccupancyPeriod | null {
    if (!query.availableFrom && !query.availableTo) {
      return null;
    }

    if (!query.availableFrom || !query.availableTo) {
      throw new BadRequestException(
        'availableFrom e availableTo devem ser fornecidos juntos.',
      );
    }

    const requestedStart = new Date(query.availableFrom);
    const requestedEnd = new Date(query.availableTo);

    if (
      Number.isNaN(requestedStart.getTime()) ||
      Number.isNaN(requestedEnd.getTime())
    ) {
      throw new BadRequestException(
        'availableFrom/availableTo devem ser datas ISO válidas.',
      );
    }

    const startDate = startOfDay(requestedStart);
    const endDate = startOfDay(requestedEnd);

    if (endDate <= startDate) {
      throw new BadRequestException(
        'availableTo deve ser posterior a availableFrom.',
      );
    }

    return { startDate, endDate };
  }

  /** Formata uma lista de equipamentos, cada um com as suas unidades livres hoje. */
  private async withFreeUnits<T extends { id: string; quantity: number }, R>(
    items: T[],
    present: (item: T, freeUnitsToday: number) => R,
  ): Promise<R[]> {
    const freeUnits = await this.availability.freeUnitsToday(items);

    return items.map((item) => present(item, freeUnits.get(item.id) ?? 0));
  }

  private async freeUnitsOf(equipment: {
    id: string;
    quantity: number;
  }): Promise<number> {
    const freeUnits = await this.availability.freeUnitsToday([equipment]);

    return freeUnits.get(equipment.id) ?? 0;
  }

  /**
   * Um provider suspenso por strikes não pode voltar a pôr os anúncios a
   * aceitar reservas antes de a suspensão acabar. O admin pode fazê-lo por ele.
   */
  private async assertOwnerMayReopenListings(
    ownerId: string,
    actorRole: UserRole,
  ) {
    if (actorRole === UserRole.ADMIN) {
      return;
    }

    const owner = await this.prisma.user.findUnique({
      where: { id: ownerId },
      select: { listingsSuspendedUntil: true },
    });

    if (
      owner?.listingsSuspendedUntil &&
      owner.listingsSuspendedUntil > new Date()
    ) {
      throw new ForbiddenException(
        'Os teus anúncios estão suspensos por cancelamentos de reservas confirmadas e ainda não podem voltar a aceitar reservas.',
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

  /** A categoria existe, está activa e serve para equipamentos. */
  private async assertEquipmentCategory(categoryId: string) {
    const category = await this.prisma.category.findFirst({
      where: { id: categoryId, isActive: true },
    });

    if (!category) {
      throw new BadRequestException('Categoria não encontrada ou inativa.');
    }

    if (category.kind === CategoryKind.SERVICE) {
      throw new BadRequestException(
        'Esta categoria é de serviços. Escolhe uma categoria de equipamentos.',
      );
    }
  }

  /**
   * Este dono publica sem passar pela revisão: é um provider verificado, ou
   * a auto-aprovação está ligada no ambiente (desenvolvimento).
   */
  private async publishesWithoutReview(ownerId: string): Promise<boolean> {
    return (
      process.env.AUTO_APPROVE_EQUIPMENT === 'true' ||
      (await this.verifications.isVerified(ownerId))
    );
  }

  private async editorOf(
    role: UserRole,
    ownerId: string,
  ): Promise<ListingEditor> {
    if (role === UserRole.ADMIN) {
      return 'admin';
    }

    return (await this.publishesWithoutReview(ownerId))
      ? 'trusted-owner'
      : 'owner';
  }

  /**
   * Confirma que quem pede é o dono do anúncio ou um admin, e devolve o
   * papel dele.
   */
  private async managerRoleOf(
    userId: string,
    ownerId: string,
    forbiddenMessage: string,
  ): Promise<UserRole> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });

    if (!user) {
      throw new NotFoundException('Utilizador não encontrado.');
    }

    if (user.role !== UserRole.ADMIN && ownerId !== userId) {
      throw new ForbiddenException(forbiddenMessage);
    }

    return user.role;
  }

  /** O pedido de edição com os nomes das colunas. O que não veio fica undefined. */
  private toPatch(dto: UpdateEquipmentDto) {
    return {
      title: dto.title?.trim(),
      description: dto.description?.trim(),
      categoryId: dto.categoryId?.trim(),
      pricePerDay: dto.pricePerDay,
      pricePerWeek: dto.pricePerWeek,
      pricePerMonth: dto.pricePerMonth,
      depositAmount: dto.depositAmount,
      location: dto.location?.trim(),
      latitude: dto.latitude,
      longitude: dto.longitude,
      deliveryIncluded: dto.deliveryAvailable,
      operatorAvailable: dto.operatorAvailable,
      isAvailable: dto.availableNow,
      condition: dto.condition,
      quantity: dto.quantity,
    };
  }

  private editMessage(backToReview: boolean, previous: EquipmentStatus) {
    if (!backToReview) {
      return UPDATED;
    }

    return previous === EquipmentStatus.REJECTED ? RESUBMITTED : SENT_TO_REVIEW;
  }

  /**
   * Baixar a quantidade não pode deixar reservas sem unidade. Corre dentro
   * da transacção para não se cruzar com uma reserva que entra ao mesmo tempo.
   */
  private updateWithFewerUnits(
    id: string,
    quantity: number,
    data: Prisma.EquipmentUncheckedUpdateInput,
  ) {
    return runSerializable(
      this.prisma,
      async (tx) => {
        const liveBookings = await tx.booking.findMany({
          where: { equipmentId: id, status: { in: RESERVING_STATUSES } },
          select: { status: true, startDate: true, endDate: true },
        });
        const unitsNeeded = peakOccupancy(liveBookings);

        if (quantity < unitsNeeded) {
          throw new BadRequestException(
            `Este equipamento tem reservas para ${unitsNeeded} ${unitsNeeded === 1 ? 'unidade' : 'unidades'} ao mesmo tempo. A quantidade não pode ficar abaixo disso.`,
          );
        }

        return tx.equipment.update({
          where: { id },
          data,
          include: LISTING_INCLUDE,
        });
      },
      () =>
        new BadRequestException(
          'Entrou uma reserva enquanto alteravas a quantidade. Actualiza e tenta de novo.',
        ),
    );
  }

  private buildOrderBy(
    sortBy?: EquipmentSortBy,
  ): Prisma.EquipmentOrderByWithRelationInput[] {
    switch (sortBy) {
      case EquipmentSortBy.LOWEST_PRICE:
        return [{ pricePerDay: 'asc' }, { createdAt: 'desc' }];

      case EquipmentSortBy.HIGHEST_PRICE:
        return [{ pricePerDay: 'desc' }, { createdAt: 'desc' }];

      case EquipmentSortBy.RELEVANT:
        // Primeiro os destacados, depois os mais avaliados e os de melhor
        // nota. O contador de reservas nunca foi mantido, por isso ordenar
        // por ele dava a ordem de criação.
        return [
          { isPremium: 'desc' },
          { totalReviews: 'desc' },
          { totalRating: { sort: 'desc', nulls: 'last' } },
          { createdAt: 'desc' },
        ];

      case EquipmentSortBy.NEAREST:
      case EquipmentSortBy.NEWEST:
      default:
        return [{ createdAt: 'desc' }];
    }
  }
}
