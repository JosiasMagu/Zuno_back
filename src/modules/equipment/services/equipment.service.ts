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
import { VerificationsService } from '../../verifications/services/verifications.service';
import { CreateEquipmentDto } from '../dto/create-equipment.dto';
import {
  EquipmentSortBy,
  FindEquipmentQueryDto,
} from '../dto/find-equipment-query.dto';
import { UpdateEquipmentDto } from '../dto/update-equipment.dto';
import { EquipmentPresenter } from '../presenters/equipment.presenter';

// Selector reutilizado nos includes de owner e category
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
  ) { }

  // Criar equipamento


  async create(ownerId: string, dto: CreateEquipmentDto) {
    const categoryId = dto.categoryId.trim();
    // Promove automaticamente CLIENT → PROVIDER ao criar primeiro equipamento
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

    // Auto-aprovação acontece em 2 cenários:
    //   1. Dev/staging com AUTO_APPROVE_EQUIPMENT=true (bypass total)
    //   2. Producer já KYC-VERIFIED → confiamos nele para publicar directamente
    //      sem fila de moderação.
    const envFlag = process.env.AUTO_APPROVE_EQUIPMENT === 'true';
    const isVerifiedProvider = await this.verifications.isVerified(ownerId);
    const autoApprove = envFlag || isVerifiedProvider;

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

  // Listar equipamentos (publico, so ACTIVE)

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

    // Filtro por janela de disponibilidade: exclui equipamentos com
    // bookings (PENDING/CONFIRMED/ACTIVE) que se sobrepõem ao intervalo
    // [availableFrom, availableTo]. Overlap: existing.start < requested.end
    // && existing.end > requested.start.
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

  // Detalhe publico (so ACTIVE)

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

  // Listings do owner / admin

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

    // ADMIN ve todos; OWNER so ve os seus
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

  // Aprovar equipamento (ADMIN)
  // Permissão garantida pelo RolesGuard no controller; `adminId` mantido
  // na assinatura para futura escrita no AuditLog.

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
        owner: { select: OWNER_SELECT },
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

    return {
      message: 'Equipamento aprovado com sucesso.',
      data: EquipmentPresenter.toOwnerListingItem(updated),
    };
  }

  // Rejeitar equipamento (ADMIN)

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

  // Pausar / reactivar equipamento (OWNER ou ADMIN)

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

    return {
      message: updated.isAvailable
        ? 'Equipamento marcado como disponível.'
        : 'Equipamento marcado como indisponível.',
      data: EquipmentPresenter.toOwnerListingItem(updated),
    };
  }

  // Actualizar equipamento (OWNER ou ADMIN)

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

  // Soft delete (OWNER ou ADMIN)

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
