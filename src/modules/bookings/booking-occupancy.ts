import { BookingStatus, Prisma } from '@prisma/client';

import { BUSINESS_UTC_OFFSET_HOURS } from '../../shared/constants/policy';

/** Estados em que uma reserva pede ou ocupa uma unidade nas suas datas. */
export const RESERVING_STATUSES: BookingStatus[] = [
  BookingStatus.PENDING,
  BookingStatus.CONFIRMED,
  BookingStatus.ACTIVE,
  BookingStatus.DISPUTED,
];

/** Estados em que a unidade já está comprometida: confirmada, entregue ou em disputa. */
export const COMMITTED_STATUSES: BookingStatus[] = [
  BookingStatus.CONFIRMED,
  BookingStatus.ACTIVE,
  BookingStatus.DISPUTED,
];

/** Estados em que o equipamento pode estar com o cliente sem ter voltado. */
const UNRETURNED_STATUSES: BookingStatus[] = [
  BookingStatus.ACTIVE,
  BookingStatus.DISPUTED,
];

/** Um período em dias inteiros. O dia de `endDate` já não faz parte dele. */
export interface OccupancyPeriod {
  startDate: Date;
  endDate: Date;
}

/**
 * Filtro das reservas que ocupam uma unidade do equipamento durante `period`.
 *
 * A disponibilidade de um equipamento decide-se sempre por aqui: contam-se as
 * reservas que este filtro apanha e compara-se com `Equipment.quantity`.
 *
 * Uma reserva ocupa a unidade de `startDate` a `endDate`. Uma unidade que
 * ainda não foi devolvida continua ocupada depois do prazo, por isso conta
 * para qualquer período que já tenha começado.
 */
export function occupyingDuring(
  period: OccupancyPeriod,
  statuses: BookingStatus[],
  now: Date = new Date(),
): Prisma.BookingWhereInput {
  const overlapsByDates: Prisma.BookingWhereInput = {
    endDate: { gt: period.startDate },
  };
  const periodHasBegun = period.startDate <= now;

  return {
    status: { in: statuses },
    startDate: { lt: period.endDate },
    OR: periodHasBegun
      ? [overlapsByDates, { status: { in: UNRETURNED_STATUSES } }]
      : [overlapsByDates],
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const BUSINESS_OFFSET_MS = BUSINESS_UTC_OFFSET_HOURS * 60 * 60 * 1000;

/**
 * A meia-noite do dia em que `date` cai em Moçambique, seja qual for o fuso
 * do servidor. As reservas e os períodos de disponibilidade contam-se em
 * dias inteiros a partir daqui.
 *
 * Com a hora do servidor, num contentor em UTC quem reservava o dia 25 à
 * meia-noite e meia de Maputo ficava com a reserva no dia 24.
 */
export function startOfDay(date: Date): Date {
  const businessTime = date.getTime() + BUSINESS_OFFSET_MS;
  const businessMidnight = Math.floor(businessTime / DAY_MS) * DAY_MS;

  return new Date(businessMidnight - BUSINESS_OFFSET_MS);
}

/** O dia de hoje como período: da meia-noite de hoje à meia-noite de amanhã. */
export function todayAsPeriod(now: Date = new Date()): OccupancyPeriod {
  const startDate = startOfDay(now);

  return { startDate, endDate: new Date(startDate.getTime() + DAY_MS) };
}

/**
 * O maior número de unidades que estas reservas ocupam ao mesmo tempo, de
 * hoje em diante. É até onde se pode baixar a quantidade de um equipamento
 * sem deixar uma reserva sem unidade.
 *
 * Segue a regra de `occupyingDuring`: cada reserva ocupa de `startDate` a
 * `endDate`, e a que foi entregue e ainda não voltou continua a ocupar hoje.
 */
export function peakOccupancy(
  bookings: Array<{ status: BookingStatus; startDate: Date; endDate: Date }>,
  now: Date = new Date(),
): number {
  const today = todayAsPeriod(now);
  const changes: Array<{ at: number; units: number }> = [];

  for (const booking of bookings) {
    const stillOut = UNRETURNED_STATUSES.includes(booking.status);
    const end = Math.max(
      booking.endDate.getTime(),
      stillOut ? today.endDate.getTime() : 0,
    );

    if (end <= today.startDate.getTime()) {
      continue;
    }

    changes.push({ at: booking.startDate.getTime(), units: 1 });
    changes.push({ at: end, units: -1 });
  }

  // No mesmo instante, quem sai liberta a unidade antes de quem entra.
  changes.sort((a, b) => a.at - b.at || a.units - b.units);

  let occupied = 0;
  let peak = 0;
  for (const change of changes) {
    occupied += change.units;
    peak = Math.max(peak, occupied);
  }

  return peak;
}
