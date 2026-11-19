import { BookingStatus } from '@prisma/client';

import { peakOccupancy } from './booking-occupancy';

const NOW = new Date('2026-11-17T10:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

/** Meia-noite de Maputo daqui a `offset` dias (22:00 UTC da véspera). */
const day = (offset: number) =>
  new Date(Date.parse('2026-11-16T22:00:00.000Z') + offset * DAY_MS);

const booking = (
  from: number,
  to: number,
  status: BookingStatus = BookingStatus.CONFIRMED,
) => ({ status, startDate: day(from), endDate: day(to) });

describe('peakOccupancy', () => {
  it('é zero sem reservas', () => {
    expect(peakOccupancy([], NOW)).toBe(0);
  });

  it('conta uma unidade para reservas que não se cruzam', () => {
    expect(peakOccupancy([booking(1, 3), booking(5, 8)], NOW)).toBe(1);
  });

  it('conta as reservas que se cruzam no mesmo dia', () => {
    expect(
      peakOccupancy([booking(1, 5), booking(3, 7), booking(4, 6)], NOW),
    ).toBe(3);
  });

  it('não conta como cruzadas a reserva que acaba no dia em que a outra começa', () => {
    expect(peakOccupancy([booking(1, 4), booking(4, 7)], NOW)).toBe(1);
  });

  it('ignora as reservas que já acabaram e foram devolvidas', () => {
    expect(peakOccupancy([booking(-10, -5), booking(2, 4)], NOW)).toBe(1);
  });

  it.each([BookingStatus.ACTIVE, BookingStatus.DISPUTED])(
    'conta para hoje a unidade %s que passou do prazo e ainda não voltou',
    (status) => {
      expect(
        peakOccupancy([booking(-10, -5, status), booking(0, 2)], NOW),
      ).toBe(2);
    },
  );

  it('não conta a unidade em atraso para reservas que começam depois de hoje', () => {
    expect(
      peakOccupancy(
        [booking(-10, -5, BookingStatus.ACTIVE), booking(3, 6)],
        NOW,
      ),
    ).toBe(1);
  });
});
