import { BookingStatus } from '@prisma/client';

import { PrismaService } from '../../../shared/db/prisma.service';
import { EquipmentAvailabilityService } from './equipment-availability.service';

const reserved = (equipmentId: string, units: number) => ({
  equipmentId,
  _count: { _all: units },
});

describe('EquipmentAvailabilityService', () => {
  const prisma = {
    booking: { groupBy: jest.fn() },
    equipment: { findMany: jest.fn() },
  };
  const service = new EquipmentAvailabilityService(
    prisma as unknown as PrismaService,
  );

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.booking.groupBy.mockResolvedValue([]);
  });

  describe('freeUnitsToday()', () => {
    it('desconta das unidades do equipamento as que as reservas ocupam hoje', async () => {
      prisma.booking.groupBy.mockResolvedValue([reserved('betoneira', 2)]);

      const freeUnits = await service.freeUnitsToday([
        { id: 'betoneira', quantity: 3 },
        { id: 'gerador', quantity: 1 },
      ]);

      expect(freeUnits.get('betoneira')).toBe(1);
      expect(freeUnits.get('gerador')).toBe(1);
    });

    it('nunca devolve um número negativo', async () => {
      prisma.booking.groupBy.mockResolvedValue([reserved('betoneira', 3)]);

      const freeUnits = await service.freeUnitsToday([
        { id: 'betoneira', quantity: 2 },
      ]);

      expect(freeUnits.get('betoneira')).toBe(0);
    });

    it('conta só as reservas dos equipamentos pedidos, incluindo as por confirmar e as em disputa', async () => {
      await service.freeUnitsToday([{ id: 'betoneira', quantity: 1 }]);

      const { where } = prisma.booking.groupBy.mock.calls[0][0] as {
        where: { equipmentId: unknown; status: { in: BookingStatus[] } };
      };
      expect(where.equipmentId).toEqual({ in: ['betoneira'] });
      expect(where.status.in).toEqual(
        expect.arrayContaining([
          BookingStatus.PENDING,
          BookingStatus.CONFIRMED,
          BookingStatus.ACTIVE,
          BookingStatus.DISPUTED,
        ]),
      );
    });
  });

  describe('findFullyBookedIds()', () => {
    const period = {
      startDate: new Date('2030-06-01'),
      endDate: new Date('2030-06-05'),
    };

    it('devolve só os equipamentos com todas as unidades ocupadas no período', async () => {
      prisma.booking.groupBy.mockResolvedValue([
        reserved('betoneira', 1),
        reserved('gerador', 1),
      ]);
      prisma.equipment.findMany.mockResolvedValue([
        { id: 'betoneira', quantity: 1 },
        { id: 'gerador', quantity: 2 },
      ]);

      await expect(service.findFullyBookedIds(period)).resolves.toEqual([
        'betoneira',
      ]);
    });

    it('não consulta os equipamentos quando não há reservas no período', async () => {
      await expect(service.findFullyBookedIds(period)).resolves.toEqual([]);

      expect(prisma.equipment.findMany).not.toHaveBeenCalled();
    });
  });
});
