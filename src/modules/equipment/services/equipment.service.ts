import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  BookingStatus,
  EquipmentCondition,
  EquipmentStatus,
  Prisma,
  UserRole,
} from '@prisma/client';

import { AuditService } from '../../../shared/audit/audit.service';
import { PrismaService } from '../../../shared/db/prisma.service';
import { MetricsService } from '../../../shared/metrics/metrics.service';
import { PushService } from '../../../shared/push/push.service';
import { VerificationsService } from '../../verifications/services/verifications.service';
import { CreateEquipmentDto } from '../dto/create-equipment.dto';
import {
  EquipmentSortBy,
  FindEquipmentQueryDto,
} from '../dto/find-equipment-query.dto';
import { UpdateEquipmentDto } from '../dto/update-equipment.dto';
import { EquipmentPresenter } from '../presenters/equipment.presenter';

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
export class EquipmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly verifications: VerificationsService,
    private readonly push: PushService,
    private readonly metrics: MetricsService,
  ) { }

  async create(ownerId: string, dto: CreateEquipmentDto) {
    const categoryId = dto.categoryId.trim();
    const owner = await this.prisma.user.findUnique({
      where: { id: ownerId },
      select: { role: true },
    });

    if (owner?.role === UserRole.CLIENT) {
      await this.prisma.user.update({
        where: { id: ownerId },
        data: { role: UserRole.PROVIDER },
      });
    }

    const category = await this.prisma.category.findFirst({
      where: { id: categoryId, isActive: true },
    });

    if (!category) {
      throw new BadRequestException('Categoria não encontrada ou inativa.');
    }

    const envFlag = process.env.AUTO_APPROVE_EQUIPMENT === 'true';
    const isVerifiedProvider = await this.verifications.isVerified(ownerId);
    const autoApprove = envFlag || isVerifiedProvider;

    const quantity = dto.quantity && dto.quantity > 0 ? dto.quantity : 1;

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
      include: {
        owner: { select: OWNER_SELECT },
        category: { select: CATEGORY_SELECT },
        photos: { orderBy: PHOTOS_ORDER },
      },
    });

    return {
      message: autoApprove
        ? 'Equipamento criado e publicado com sucesso.'
        : 'Equipamento criado com sucesso. Aguarda aprovação do administrador.',
      data: EquipmentPresenter.toOwnerListingItem(equipment),
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

    if (query.ownerId?.trim()) {
      where.ownerId = query.ownerId.trim();
    }

    if (query.location?.trim()) {
      where.location = { contains: query.location.trim(), mode: 'insensitive' };
    }

    if (query.deliveryAvailable !== undefined) {
      where.deliveryIncluded = query.deliveryAvailable;
    }

    if (query.operatorAvailable !== undefined) {
      where.operatorAvailable = query.operatorAvailable;
    }

    if (query.onlyAvailableNow !== undefined) {
      where.isAvailable = query.onlyAvailableNow;
    }

    if (query.availableFrom && query.availableTo) {
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
      if (requestedEnd <= requestedStart) {
        throw new BadRequestException(
          'availableTo deve ser posterior a availableFrom.',
        );
      }

      where.NOT = {
        bookings: {
          some: {
            status: {
              in: [
                BookingStatus.PENDING,
                BookingStatus.CONFIRMED,
                BookingStatus.ACTIVE,
              ],
            },
            AND: [
              { startDate: { lt: requestedEnd } },
              { endDate: { gt: requestedStart } },
            ],
          },
        },
      };
    } else if (query.availableFrom || query.availableTo) {
      throw new BadRequestException(
        'availableFrom e availableTo devem ser fornecidos juntos.',
      );
    }

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
        include: {
          owner: { select: OWNER_SELECT },
          category: { select: CATEGORY_SELECT },
          photos: { orderBy: PHOTOS_ORDER },
        },
      }),
      this.prisma.equipment.count({ where }),
    ]);

    return {
      message: 'Equipamentos obtidos com sucesso.',
      data: items.map((item) => EquipmentPresenter.toListItem(item)),
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
    const equipment = await this.prisma.equipment.findFirst({
      where: { id, status: EquipmentStatus.ACTIVE },
      include: {
        owner: { select: OWNER_DETAIL_SELECT },
        category: { select: CATEGORY_SELECT },
        photos: { orderBy: PHOTOS_ORDER },
      },
    });

    if (!equipment) {
      throw new NotFoundException('Equipamento não encontrado.');
    }

    return {
      message: 'Equipamento obtido com sucesso.',
      data: EquipmentPresenter.toDetails(equipment),
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
          where: { ownerId: userId },
          _sum: { ownerPayout: true, totalCharged: true },
          _count: { _all: true },
        }),
        this.prisma.user.findUnique({
          where: { id: userId },
          select: { totalRating: true, totalReviews: true },
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
          average: ratingAgg?.totalRating ? Number(ratingAgg.totalRating) : null,
          totalReviews: ratingAgg?.totalReviews ?? 0,
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
        include: {
          owner: { select: OWNER_SELECT },
          category: { select: CATEGORY_SELECT },
          photos: { orderBy: PHOTOS_ORDER },
        },
      }),
      this.prisma.equipment.count({ where }),
    ]);

    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

    return {
      message: 'Equipamentos obtidos com sucesso.',
      data: items.map((item) => EquipmentPresenter.toOwnerListingItem(item)),
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
    const equipment = await this.prisma.equipment.findUnique({
      where: { id: equipmentId },
      select: { id: true, status: true },
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

    const updated = await this.prisma.equipment.update({
      where: { id: equipmentId },
      data: {
        status: EquipmentStatus.ACTIVE,
        isAvailable: true,
      },
      include: {
        owner: { select: { ...OWNER_SELECT, pushToken: true } },
        category: { select: CATEGORY_SELECT },
        photos: { orderBy: PHOTOS_ORDER },
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
      this.push.send({
        to: updated.owner.pushToken,
        title: '✅ Equipamento aprovado',
        body: `"${updated.title}" já está visível no catálogo público.`,
        data: { type: 'equipment_approved', equipmentId },
      }).catch(() => {});
    }

    return {
      message: 'Equipamento aprovado com sucesso.',
      data: EquipmentPresenter.toOwnerListingItem(updated),
    };
  }

  async reject(adminId: string, equipmentId: string, reason?: string) {
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

    const updated = await this.prisma.equipment.update({
      where: { id: equipmentId },
      data: {
        status: EquipmentStatus.REJECTED,
        isAvailable: false,
      },
      include: {
        owner: { select: OWNER_SELECT },
        category: { select: CATEGORY_SELECT },
        photos: { orderBy: PHOTOS_ORDER },
      },
    });

    await this.audit.record({
      action: AuditAction.EQUIPMENT_REJECTED,
      actorId: adminId,
      targetType: 'Equipment',
      targetId: equipmentId,
      metadata: {
        previousStatus: equipment.status,
        title: updated.title,
        reason: reason ?? null,
      },
    });

    return {
      message: reason
        ? `Equipamento rejeitado. Motivo: ${reason}`
        : 'Equipamento rejeitado.',
      data: EquipmentPresenter.toOwnerListingItem(updated),
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

    const updated = await this.prisma.equipment.update({
      where: { id: equipmentId },
      data: { isAvailable: !equipment.isAvailable },
      include: {
        owner: { select: OWNER_SELECT },
        category: { select: CATEGORY_SELECT },
        photos: { orderBy: PHOTOS_ORDER },
      },
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
      data: EquipmentPresenter.toOwnerListingItem(updated),
    };
  }

  async update(userId: string, id: string, dto: UpdateEquipmentDto) {
    const existingEquipment = await this.prisma.equipment.findUnique({
      where: { id },
      select: { id: true, ownerId: true },
    });

    if (!existingEquipment) {
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
      user.role === UserRole.ADMIN || existingEquipment.ownerId === userId;

    if (!canManage) {
      throw new ForbiddenException(
        'Não tens permissão para editar este equipamento.',
      );
    }

    if (dto.categoryId !== undefined) {
      const category = await this.prisma.category.findFirst({
        where: { id: dto.categoryId.trim(), isActive: true },
      });

      if (!category) {
        throw new BadRequestException('Categoria não encontrada ou inativa.');
      }
    }

    const updatedEquipment = await this.prisma.equipment.update({
      where: { id },
      data: {
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
      },
      include: {
        owner: { select: OWNER_SELECT },
        category: { select: CATEGORY_SELECT },
        photos: { orderBy: PHOTOS_ORDER },
      },
    });

    return {
      message: 'Equipamento atualizado com sucesso.',
      data: EquipmentPresenter.toOwnerListingItem(updatedEquipment),
    };
  }

  async remove(userId: string, id: string) {
    const existingEquipment = await this.prisma.equipment.findUnique({
      where: { id },
      select: { id: true, ownerId: true },
    });

    if (!existingEquipment) {
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
      user.role === UserRole.ADMIN || existingEquipment.ownerId === userId;

    if (!canManage) {
      throw new ForbiddenException(
        'Não tens permissão para remover este equipamento.',
      );
    }

    await this.prisma.equipment.update({
      where: { id },
      data: {
        status: EquipmentStatus.DELETED,
        isAvailable: false,
      },
    });

    await this.audit.record({
      action: AuditAction.EQUIPMENT_REMOVED,
      actorId: userId,
      targetType: 'Equipment',
      targetId: id,
      metadata: {
        actorRole: user.role,
        ownerWasSelf: existingEquipment.ownerId === userId,
      },
    });

    return {
      message: 'Equipamento removido com sucesso.',
    };
  }

  async findPending(adminId: string) {
    void adminId;

    const items = await this.prisma.equipment.findMany({
      where: { status: EquipmentStatus.PENDING_REVIEW },
      orderBy: { createdAt: 'asc' },
      include: {
        owner: { select: OWNER_SELECT },
        category: { select: CATEGORY_SELECT },
        photos: { orderBy: PHOTOS_ORDER },
      },
    });

    return {
      message: 'Equipamentos pendentes de revisão obtidos com sucesso.',
      data: items.map((item) => EquipmentPresenter.toOwnerListingItem(item)),
    };
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
        return [
          { isPremium: 'desc' },
          { totalBookings: 'desc' },
          { createdAt: 'desc' },
        ];

      case EquipmentSortBy.NEAREST:
      case EquipmentSortBy.NEWEST:
      default:
        return [{ createdAt: 'desc' }];
    }
  }
}