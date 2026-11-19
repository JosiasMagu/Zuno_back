import { BookingStatus } from '@prisma/client';

import {
  COMMITTED_STATUSES,
  occupyingDuring,
  RESERVING_STATUSES,
  startOfDay,
  todayAsPeriod,
} from './booking-occupancy';

const MAPUTO_OFFSET_MS = 2 * 60 * 60 * 1000;

// 16 de Novembro de 2026, 14:30 em Maputo. As datas escrevem-se em UTC para
// os testes darem o mesmo resultado em qualquer máquina.
const NOW = new Date('2026-11-16T12:30:00.000Z');

/** A meia-noite desse dia de Novembro de 2026 em Maputo. */
const day = (dayOfMonth: number) =>
  new Date(Date.UTC(2026, 10, dayOfMonth) - MAPUTO_OFFSET_MS);

describe('ocupação de um equipamento pelas reservas', () => {
  it('uma reserva por confirmar pede uma unidade, mas não a compromete', () => {
    expect(RESERVING_STATUSES).toContain(BookingStatus.PENDING);
    expect(COMMITTED_STATUSES).not.toContain(BookingStatus.PENDING);
  });

  it('uma reserva em disputa continua a ocupar a unidade', () => {
    expect(RESERVING_STATUSES).toContain(BookingStatus.DISPUTED);
    expect(COMMITTED_STATUSES).toContain(BookingStatus.DISPUTED);
  });

  describe('occupyingDuring()', () => {
    it('num período futuro, só apanha as reservas cujas datas se cruzam com ele', () => {
      const where = occupyingDuring(
        { startDate: day(20), endDate: day(23) },
        COMMITTED_STATUSES,
        NOW,
      );

      expect(where).toEqual({
        status: { in: COMMITTED_STATUSES },
        startDate: { lt: day(23) },
        OR: [{ endDate: { gt: day(20) } }],
      });
    });

    it('num período que já começou, apanha também as unidades por devolver', () => {
      const where = occupyingDuring(
        { startDate: day(16), endDate: day(17) },
        RESERVING_STATUSES,
        NOW,
      );

      expect(where.OR).toEqual([
        { endDate: { gt: day(16) } },
        { status: { in: [BookingStatus.ACTIVE, BookingStatus.DISPUTED] } },
      ]);
    });
  });

  describe('todayAsPeriod()', () => {
    it('vai da meia-noite de hoje à meia-noite de amanhã', () => {
      expect(todayAsPeriod(NOW)).toEqual({
        startDate: day(16),
        endDate: day(17),
      });
    });

    it('passa para o mês seguinte no último dia do mês', () => {
      // 30 de Novembro, 23:59 em Maputo.
      const lastOfNovember = new Date('2026-11-30T21:59:00.000Z');

      expect(todayAsPeriod(lastOfNovember).endDate).toEqual(
        new Date('2026-11-30T22:00:00.000Z'),
      );
    });
  });

  describe('startOfDay()', () => {
    it('é a meia-noite de Maputo, que são as 22:00 UTC da véspera', () => {
      expect(startOfDay(NOW)).toEqual(new Date('2026-11-15T22:00:00.000Z'));
    });

    it('põe no dia 25 quem reserva à meia-noite e meia de Maputo', () => {
      // Em UTC ainda é dia 24, e era aí que a reserva ficava num servidor em UTC.
      const halfPastMidnight = new Date('2026-11-24T22:30:00.000Z');

      expect(startOfDay(halfPastMidnight)).toEqual(
        new Date('2026-11-24T22:00:00.000Z'),
      );
    });

    it('ainda conta como dia 24 um minuto antes da meia-noite de Maputo', () => {
      const oneMinuteToMidnight = new Date('2026-11-24T21:59:00.000Z');

      expect(startOfDay(oneMinuteToMidnight)).toEqual(
        new Date('2026-11-23T22:00:00.000Z'),
      );
    });

    it('não mexe numa data que já é meia-noite de Maputo', () => {
      expect(startOfDay(day(20))).toEqual(day(20));
    });

    it('dá o mesmo dia a duas horas do mesmo dia', () => {
      const morning = new Date('2026-11-16T05:00:00.000Z');
      const night = new Date('2026-11-16T21:30:00.000Z');

      expect(startOfDay(morning)).toEqual(startOfDay(night));
    });
  });
});
