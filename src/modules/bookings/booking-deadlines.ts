import {
  BOOKING_PAYMENT_CUTOFF_HOURS_BEFORE_START,
  BOOKING_PAYMENT_MIN_WINDOW_HOURS,
  BOOKING_PAYMENT_WINDOW_HOURS,
  DEPOSIT_CLAIM_WINDOW_HOURS,
} from '../../shared/constants/policy';

const HOUR_MS = 60 * 60 * 1000;

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * HOUR_MS);
}

/**
 * Até quando uma reserva pode ser paga. É o prazo normal a contar da criação,
 * ou o corte antes do início do aluguer quando este chega primeiro. Uma
 * reserva feita em cima do início tem sempre o prazo mínimo.
 */
export function paymentDeadline(createdAt: Date, startDate: Date): Date {
  const byWindow = addHours(createdAt, BOOKING_PAYMENT_WINDOW_HOURS);
  const beforeStart = addHours(
    startDate,
    -BOOKING_PAYMENT_CUTOFF_HOURS_BEFORE_START,
  );
  const earliest = byWindow < beforeStart ? byWindow : beforeStart;
  const minimum = addHours(createdAt, BOOKING_PAYMENT_MIN_WINDOW_HOURS);

  return earliest > minimum ? earliest : minimum;
}

/**
 * Até quando o provider pode reclamar o depósito. A janela conta do fim do
 * aluguer ou da entrega, o que for mais tarde: assim um aluguer curto,
 * entregue tarde ou libertado pelo auto-release, não chega às mãos do
 * provider com a janela já fechada.
 */
export function depositClaimDeadline(booking: {
  endDate: Date;
  deliveryConfirmedAt: Date | null;
}): Date {
  const { endDate, deliveryConfirmedAt } = booking;
  const windowStart =
    deliveryConfirmedAt && deliveryConfirmedAt > endDate
      ? deliveryConfirmedAt
      : endDate;

  return addHours(windowStart, DEPOSIT_CLAIM_WINDOW_HOURS);
}
