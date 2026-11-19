import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../shared/db/prisma.service';
import {
  occupyingDuring,
  RESERVING_STATUSES,
  todayAsPeriod,
} from '../../bookings/booking-occupancy';
import type { OccupancyPeriod } from '../../bookings/booking-occupancy';

/**
 * Unidades livres de um equipamento, calculadas a partir das reservas.
 *
 * Usa a mesma regra de ocupação que a criação de reservas. Assim, um
 * equipamento que aqui aparece com unidades livres num período aceita uma
 * reserva para esse período.
 */
@Injectable()
export class EquipmentAvailabilityService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Unidades livres hoje de cada equipamento, por id. É o valor que a API
   * devolve em `availableQuantity`.
   */
  async freeUnitsToday(
    equipments: Array<{ id: string; quantity: number }>,
  ): Promise<Map<string, number>> {
    const reserved = await this.countReservedUnits(
      todayAsPeriod(),
      equipments.map((equipment) => equipment.id),
    );

    return new Map(
      equipments.map((equipment) => [
        equipment.id,
        Math.max(equipment.quantity - (reserved.get(equipment.id) ?? 0), 0),
      ]),
    );
  }

  /** Ids dos equipamentos sem nenhuma unidade livre durante o período. */
  async findFullyBookedIds(period: OccupancyPeriod): Promise<string[]> {
    const reserved = await this.countReservedUnits(period);
    if (reserved.size === 0) {
      return [];
    }

    const equipments = await this.prisma.equipment.findMany({
      where: { id: { in: [...reserved.keys()] } },
      select: { id: true, quantity: true },
    });

    return equipments
      .filter(({ id, quantity }) => (reserved.get(id) ?? 0) >= quantity)
      .map(({ id }) => id);
  }

  /** Unidades que as reservas ocupam no período, por id de equipamento. */
  private async countReservedUnits(
    period: OccupancyPeriod,
    equipmentIds?: string[],
  ): Promise<Map<string, number>> {
    const rows = await this.prisma.booking.groupBy({
      by: ['equipmentId'],
      where: {
        ...(equipmentIds ? { equipmentId: { in: equipmentIds } } : {}),
        ...occupyingDuring(period, RESERVING_STATUSES),
      },
      _count: { _all: true },
    });

    return new Map(rows.map((row) => [row.equipmentId, row._count._all]));
  }
}
