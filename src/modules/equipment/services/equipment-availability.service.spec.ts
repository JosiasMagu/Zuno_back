import { BookingStatus } from '@prisma/client';

import { PrismaService } from '../../../shared/db/prisma.service';
import { EquipmentAvailabilityService } from './equipment-availability.service';

const reserved = (equipmentId: string, units: number) => ({
  equipmentId,
  _count: { _all: units },
});

describe('EquipmentAvailabilityService', () => {
  const prisma = {
    booking: { groupBy: jest.fn(), findMany: jest.fn() },
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

    const booking = (equipmentId: string, from: string, to: string) => ({
      equipmentId,
      status: BookingStatus.CONFIRMED,
      startDate: new Date(from),
      endDate: new Date(to),
    });

    it('devolve só os equipamentos com todas as unidades ocupadas no período', async () => {
      prisma.booking.groupBy.mockResolvedValue([
        reserved('betoneira', 1),
        reserved('gerador', 1),
      ]);
      prisma.equipment.findMany.mockResolvedValue([
        { id: 'betoneira', quantity: 1 },
        { id: 'gerador', quantity: 2 },
      ]);
      prisma.booking.findMany.mockResolvedValue([
        booking('betoneira', '2030-06-02', '2030-06-04'),
      ]);

      await expect(service.findFullyBookedIds(period)).resolves.toEqual([
        'betoneira',
      ]);
    });

    it('não dá por cheio o equipamento cujas reservas nunca coincidem', async () => {
      // 2 andaimes, duas reservas em dias diferentes: há sempre um livre.
      prisma.booking.groupBy.mockResolvedValue([reserved('andaime', 2)]);
      prisma.equipment.findMany.mockResolvedValue([
        { id: 'andaime', quantity: 2 },
      ]);
      prisma.booking.findMany.mockResolvedValue([
        booking('andaime', '2030-06-01', '2030-06-02'),
        booking('andaime', '2030-06-03', '2030-06-05'),
      ]);

      await expect(service.findFullyBookedIds(period)).resolves.toEqual([]);
    });

    it('dá por cheio quando as reservas coincidem em tantas unidades como as que há', async () => {
      prisma.booking.groupBy.mockResolvedValue([reserved('andaime', 2)]);
      prisma.equipment.findMany.mockResolvedValue([
        { id: 'andaime', quantity: 2 },
      ]);
      prisma.booking.findMany.mockResolvedValue([
        booking('andaime', '2030-06-01', '2030-06-04'),
        booking('andaime', '2030-06-03', '2030-06-05'),
      ]);

      await expect(service.findFullyBookedIds(period)).resolves.toEqual([
        'andaime',
      ]);
    });

    it('não consulta os equipamentos quando não há reservas no período', async () => {
      await expect(service.findFullyBookedIds(period)).resolves.toEqual([]);

      expect(prisma.equipment.findMany).not.toHaveBeenCalled();
    });
  });
});
