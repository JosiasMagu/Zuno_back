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
  ServicePricingType,
  ServiceStatus,
  UserRole,
} from '@prisma/client';

import { AuditService } from '../../../shared/audit/audit.service';
import { PrismaService } from '../../../shared/db/prisma.service';
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
  totalRating: true,
  totalReviews: true,
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

@Injectable()
export class ServicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(providerId: string, dto: CreateServiceDto) {
    const categoryId = dto.categoryId.trim();

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
      include: {
        provider: { select: PROVIDER_SELECT },
        category: { select: CATEGORY_SELECT },
        photos: { orderBy: PHOTOS_ORDER },
      },
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

    if (query.categoryId?.trim()) {
      where.categoryId = query.categoryId.trim();
    }

    if (query.categorySlug?.trim()) {
      where.category = {
        is: { slug: query.categorySlug.trim(), isActive: true },
      };
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
        include: {
          provider: { select: PROVIDER_SELECT },
          category: { select: CATEGORY_SELECT },
          photos: { orderBy: PHOTOS_ORDER },
        },
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

  async findOne(id: string) {
    const service = await this.prisma.service.findFirst({
      where: { id, status: ServiceStatus.ACTIVE },
      include: {
        provider: { select: PROVIDER_DETAIL_SELECT },
        category: { select: CATEGORY_SELECT },
        photos: { orderBy: PHOTOS_ORDER },
      },
    });

    if (!service) {
      throw new NotFoundException('Serviço não encontrado.');
    }

    return {
      message: 'Serviço obtido com sucesso.',
      data: ServicePresenter.toDetails(service),
    };
  }

  async findMyListings(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });

    if (!user) {
      throw new NotFoundException('Utilizador não encontrado.');
    }

    const where: Prisma.ServiceWhereInput =
      user.role === UserRole.ADMIN ? {} : { providerId: userId };

    const items = await this.prisma.service.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        provider: { select: PROVIDER_SELECT },
        category: { select: CATEGORY_SELECT },
        photos: { orderBy: PHOTOS_ORDER },
      },
    });

    return {
      message: 'Serviços obtidos com sucesso.',
      data: items.map((item) => ServicePresenter.toProviderListingItem(item)),
    };
  }

  async findPending(adminId: string) {
    void adminId;

    const items = await this.prisma.service.findMany({
      where: { status: ServiceStatus.PENDING_REVIEW },
      orderBy: { createdAt: 'asc' },
      include: {
        provider: { select: PROVIDER_SELECT },
        category: { select: CATEGORY_SELECT },
        photos: { orderBy: PHOTOS_ORDER },
      },
    });

    return {
      message: 'Serviços pendentes de revisão obtidos com sucesso.',
      data: items.map((item) => ServicePresenter.toProviderListingItem(item)),
    };
  }

  async approve(adminId: string, serviceId: string) {
    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
      select: { id: true, status: true },
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

    const updated = await this.prisma.service.update({
      where: { id: serviceId },
      data: { status: ServiceStatus.ACTIVE, isActive: true },
      include: {
        provider: { select: PROVIDER_SELECT },
        category: { select: CATEGORY_SELECT },
        photos: { orderBy: PHOTOS_ORDER },
      },
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

    const updated = await this.prisma.service.update({
      where: { id: serviceId },
      data: { status: ServiceStatus.REJECTED, isActive: false },
      include: {
        provider: { select: PROVIDER_SELECT },
        category: { select: CATEGORY_SELECT },
        photos: { orderBy: PHOTOS_ORDER },
      },
    });

    await this.audit.record({
      action: AuditAction.SERVICE_REJECTED,
      actorId: adminId,
      targetType: 'Service',
      targetId: serviceId,
      metadata: {
        previousStatus: service.status,
        title: updated.title,
        reason: reason ?? null,
      },
    });

    return {
      message: reason
        ? `Serviço rejeitado. Motivo: ${reason}`
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

    const updated = await this.prisma.service.update({
      where: { id: serviceId },
      data: { isActive: !service.isActive },
      include: {
        provider: { select: PROVIDER_SELECT },
        category: { select: CATEGORY_SELECT },
        photos: { orderBy: PHOTOS_ORDER },
      },
    });

    return {
      message: updated.isActive
        ? 'Serviço marcado como disponível.'
        : 'Serviço marcado como indisponível.',
      data: ServicePresenter.toProviderListingItem(updated),
    };
  }

  async update(userId: string, id: string, dto: UpdateServiceDto) {
    const existing = await this.prisma.service.findUnique({
      where: { id },
      select: {
        id: true,
        providerId: true,
        acceptsUrgent: true,
        urgentSurcharge: true,
      },
    });

    if (!existing) {
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
      user.role === UserRole.ADMIN || existing.providerId === userId;

    if (!canManage) {
      throw new ForbiddenException(
        'Não tens permissão para editar este serviço.',
      );
    }

    if (dto.categoryId !== undefined) {
      const category = await this.prisma.category.findFirst({
        where: { id: dto.categoryId.trim(), isActive: true },
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

    const updated = await this.prisma.service.update({
      where: { id },
      data: {
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
        urgentSurcharge:
          dto.acceptsUrgent === false ? null : dto.urgentSurcharge,
      },
      include: {
        provider: { select: PROVIDER_SELECT },
        category: { select: CATEGORY_SELECT },
        photos: { orderBy: PHOTOS_ORDER },
      },
    });

    return {
      message: 'Serviço atualizado com sucesso.',
      data: ServicePresenter.toProviderListingItem(updated),
    };
  }

  async remove(userId: string, id: string) {
    const existing = await this.prisma.service.findUnique({
      where: { id },
      select: { id: true, providerId: true },
    });

    if (!existing) {
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
      user.role === UserRole.ADMIN || existing.providerId === userId;

    if (!canManage) {
      throw new ForbiddenException(
        'Não tens permissão para remover este serviço.',
      );
    }

    await this.prisma.service.update({
      where: { id },
      data: { status: ServiceStatus.DELETED, isActive: false },
    });

    return { message: 'Serviço removido com sucesso.' };
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
        return [{ totalCompleted: 'desc' }, { createdAt: 'desc' }];

      case ServiceSortBy.NEAREST:
      case ServiceSortBy.NEWEST:
      default:
        return [{ createdAt: 'desc' }];
    }
  }
}
