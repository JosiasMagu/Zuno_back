import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  Prisma,
  ServiceRequestStatus,
  ServiceStatus,
  UserRole,
} from '@prisma/client';

import { AuditService } from '../../../shared/audit/audit.service';
import { PrismaService } from '../../../shared/db/prisma.service';
import { CreateServiceRequestDto } from '../dto/create-service-request.dto';
import { FindServiceRequestsQueryDto } from '../dto/find-service-requests-query.dto';
import { ServiceRequestPresenter } from '../presenters/service-request.presenter';

const SERVICE_SELECT = {
  id: true,
  title: true,
  providerId: true,
  basePrice: true,
  urgentSurcharge: true,
  acceptsUrgent: true,
  status: true,
  isActive: true,
} as const;

const CLIENT_SELECT = {
  id: true,
  name: true,
  avatarUrl: true,
} as const;

const DEFAULT_EXPIRY_DAYS = 7;

@Injectable()
export class ServiceRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(clientId: string, dto: CreateServiceRequestDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: clientId },
      select: { id: true, role: true },
    });

    if (!user) {
      throw new NotFoundException('Utilizador não encontrado.');
    }

    if (user.role !== UserRole.CLIENT) {
      throw new ForbiddenException(
        'Apenas clientes podem criar pedidos de serviço.',
      );
    }

    const serviceId = dto.serviceId.trim();

    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
      select: SERVICE_SELECT,
    });

    if (!service) {
      throw new NotFoundException('Serviço não encontrado.');
    }

    if (service.status !== ServiceStatus.ACTIVE || !service.isActive) {
      throw new BadRequestException(
        'Este serviço não está disponível para pedidos.',
      );
    }

    if (service.providerId === clientId) {
      throw new BadRequestException(
        'Não podes solicitar o teu próprio serviço.',
      );
    }

    if (dto.isUrgent && !service.acceptsUrgent) {
      throw new BadRequestException(
        'Este serviço não aceita pedidos urgentes.',
      );
    }

    const expiresAt = dto.expiresAt
      ? new Date(dto.expiresAt)
      : new Date(Date.now() + DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    if (expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException(
        'A data de expiração deve estar no futuro.',
      );
    }

    const created = await this.prisma.serviceRequest.create({
      data: {
        clientId,
        serviceId,
        description: dto.description.trim(),
        preferredDate: dto.preferredDate ? new Date(dto.preferredDate) : null,
        isUrgent: dto.isUrgent ?? false,
        address: dto.address.trim(),
        latitude: dto.latitude,
        longitude: dto.longitude,
        expiresAt,
        status: ServiceRequestStatus.OPEN,
      },
      include: {
        service: { select: SERVICE_SELECT },
        client: { select: CLIENT_SELECT },
      },
    });

    await this.audit.record({
      action: AuditAction.SERVICE_REQUEST_CREATED,
      actorId: clientId,
      targetType: 'ServiceRequest',
      targetId: created.id,
      metadata: { serviceId, isUrgent: created.isUrgent },
    });

    return {
      message: 'Pedido de serviço criado com sucesso.',
      data: ServiceRequestPresenter.toItem(created),
    };
  }

  async findMine(clientId: string, query: FindServiceRequestsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const skip = (page - 1) * limit;

    const where: Prisma.ServiceRequestWhereInput = { clientId };
    if (query.status) {
      where.status = query.status;
    }

    const [items, total] = await Promise.all([
      this.prisma.serviceRequest.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          service: { select: SERVICE_SELECT },
          client: { select: CLIENT_SELECT },
        },
      }),
      this.prisma.serviceRequest.count({ where }),
    ]);

    return {
      message: 'Pedidos obtidos com sucesso.',
      data: items.map((item) => ServiceRequestPresenter.toItem(item)),
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

  async findOne(userId: string, requestId: string) {
    const request = await this.prisma.serviceRequest.findUnique({
      where: { id: requestId },
      include: {
        service: { select: SERVICE_SELECT },
        client: { select: CLIENT_SELECT },
      },
    });

    if (!request) {
      throw new NotFoundException('Pedido não encontrado.');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });

    if (!user) {
      throw new NotFoundException('Utilizador não encontrado.');
    }

    const canAccess =
      user.role === UserRole.ADMIN ||
      request.clientId === userId ||
      request.service?.providerId === userId;

    if (!canAccess) {
      throw new ForbiddenException('Não tens permissão para ver este pedido.');
    }

    return {
      message: 'Pedido obtido com sucesso.',
      data: ServiceRequestPresenter.toItem(request),
    };
  }

  async cancel(userId: string, requestId: string) {
    const request = await this.prisma.serviceRequest.findUnique({
      where: { id: requestId },
      select: { id: true, clientId: true, status: true },
    });

    if (!request) {
      throw new NotFoundException('Pedido não encontrado.');
    }

    if (request.clientId !== userId) {
      throw new ForbiddenException(
        'Apenas o cliente do pedido pode cancelá-lo.',
      );
    }

    if (
      request.status !== ServiceRequestStatus.OPEN &&
      request.status !== ServiceRequestStatus.QUOTED
    ) {
      throw new BadRequestException(
        'Apenas pedidos em estado OPEN ou QUOTED podem ser cancelados.',
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const cancelled = await tx.serviceRequest.update({
        where: { id: requestId },
        data: { status: ServiceRequestStatus.CANCELLED },
        include: {
          service: { select: SERVICE_SELECT },
          client: { select: CLIENT_SELECT },
        },
      });

      await tx.serviceQuote.updateMany({
        where: { requestId, status: 'PENDING' },
        data: { status: 'REJECTED' },
      });

      return cancelled;
    });

    return {
      message: 'Pedido cancelado com sucesso.',
      data: ServiceRequestPresenter.toItem(updated),
    };
  }
}
