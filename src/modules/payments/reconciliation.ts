import {
  BookingStatus,
  DepositStatus,
  PaymentStatus,
  ServiceBookingStatus,
} from '@prisma/client';

/** O que pode não bater certo num pagamento. */
export enum ReconciliationCheck {
  /** O ledger não registou a entrada do valor cobrado, ou registou-a sem o dinheiro ter entrado. */
  INFLOW_MISMATCH = 'INFLOW_MISMATCH',
  /** Saiu mais do que entrou. */
  OUTFLOW_EXCEEDS_INFLOW = 'OUTFLOW_EXCEEDS_INFLOW',
  /** O que resta no escrow não é o que o estado do pagamento diz que devia restar. */
  BALANCE_MISMATCH = 'BALANCE_MISMATCH',
  /** As saídas para o cliente não têm os payouts correspondentes. */
  CLIENT_PAYOUTS_MISMATCH = 'CLIENT_PAYOUTS_MISMATCH',
  /** As saídas para o provider não têm os payouts correspondentes. */
  PROVIDER_PAYOUTS_MISMATCH = 'PROVIDER_PAYOUTS_MISMATCH',
  /** A reserva está num estado que não combina com o do pagamento. */
  RESERVATION_STATE_MISMATCH = 'RESERVATION_STATE_MISMATCH',
  /** O depósito está num estado que não combina com o do pagamento. */
  DEPOSIT_STATE_MISMATCH = 'DEPOSIT_STATE_MISMATCH',
}

/** Tudo o que a reconciliação precisa de saber de um pagamento, já somado. */
export interface PaymentSnapshot {
  id: string;
  receiptNumber: string;
  status: PaymentStatus;
  depositStatus: DepositStatus;
  totalCharged: number;
  depositAmount: number;
  /** O dinheiro chegou a entrar no escrow. */
  everHeld: boolean;
  bookingStatus: BookingStatus | null;
  serviceBookingStatus: ServiceBookingStatus | null;
  ledger: {
    inflow: number;
    outflowToClient: number;
    outflowToProvider: number;
    outflowToPlatform: number;
  };
  /** Soma dos payouts de cada lado, em qualquer estado. */
  payouts: { toClient: number; toProvider: number };
}

export interface ReconciliationFinding {
  paymentId: string;
  receiptNumber: string;
  check: ReconciliationCheck;
  detail: string;
}

/** Estados em que uma reserva de equipamento pode estar para cada estado do pagamento. */
const BOOKING_STATES: Record<PaymentStatus, BookingStatus[]> = {
  [PaymentStatus.PENDING]: [BookingStatus.CONFIRMED],
  [PaymentStatus.HELD]: [BookingStatus.CONFIRMED, BookingStatus.DISPUTED],
  [PaymentStatus.RELEASED]: [
    BookingStatus.ACTIVE,
    BookingStatus.COMPLETED,
    BookingStatus.DISPUTED,
  ],
  [PaymentStatus.REFUNDED]: [BookingStatus.CANCELLED],
  // Cancelamento tardio (CANCELLED), ou resolução parcial de uma disputa:
  // o equipamento foi entregue e a reserva segue até à devolução.
  [PaymentStatus.PARTIALLY_REFUNDED]: [
    BookingStatus.CANCELLED,
    BookingStatus.ACTIVE,
    BookingStatus.DISPUTED,
    BookingStatus.COMPLETED,
  ],
  [PaymentStatus.FAILED]: [BookingStatus.CANCELLED, BookingStatus.EXPIRED],
};

/** O mesmo para as reservas de serviço. */
const SERVICE_BOOKING_STATES: Record<PaymentStatus, ServiceBookingStatus[]> = {
  [PaymentStatus.PENDING]: [ServiceBookingStatus.PENDING],
  [PaymentStatus.HELD]: [
    ServiceBookingStatus.PENDING,
    ServiceBookingStatus.IN_PROGRESS,
    ServiceBookingStatus.COMPLETED,
    ServiceBookingStatus.DISPUTED,
  ],
  [PaymentStatus.RELEASED]: [ServiceBookingStatus.COMPLETED],
  [PaymentStatus.REFUNDED]: [ServiceBookingStatus.CANCELLED],
  [PaymentStatus.PARTIALLY_REFUNDED]: [ServiceBookingStatus.COMPLETED],
  [PaymentStatus.FAILED]: [
    ServiceBookingStatus.CANCELLED,
    ServiceBookingStatus.EXPIRED,
  ],
};

/** Compara dinheiro em cêntimos, para não tropeçar em casas decimais. */
const cents = (value: number) => Math.round(value * 100);
const sameMoney = (a: number, b: number) => cents(a) === cents(b);
const mzn = (value: number) => `${(cents(value) / 100).toFixed(2)} MZN`;

/** O que devia restar no escrow, dado o estado do pagamento e do depósito. */
function expectedBalance(payment: PaymentSnapshot): number {
  if (payment.status === PaymentStatus.HELD) {
    return payment.totalCharged;
  }

  const nothingEntered =
    payment.status === PaymentStatus.PENDING ||
    payment.status === PaymentStatus.FAILED;

  if (nothingEntered || payment.depositStatus !== DepositStatus.HELD) {
    return 0;
  }

  // Depois do release, só o depósito continua retido.
  return payment.depositAmount;
}

function checkLedger(
  payment: PaymentSnapshot,
): [ReconciliationCheck, string][] {
  const { inflow, outflowToClient, outflowToProvider, outflowToPlatform } =
    payment.ledger;
  const outflow = outflowToClient + outflowToProvider + outflowToPlatform;
  const balance = inflow - outflow;
  const expectedInflow = payment.everHeld ? payment.totalCharged : 0;
  const problems: [ReconciliationCheck, string][] = [];

  if (!sameMoney(inflow, expectedInflow)) {
    problems.push([
      ReconciliationCheck.INFLOW_MISMATCH,
      `O ledger tem ${mzn(inflow)} de entradas e devia ter ${mzn(expectedInflow)}.`,
    ]);
  }

  if (cents(outflow) > cents(inflow)) {
    problems.push([
      ReconciliationCheck.OUTFLOW_EXCEEDS_INFLOW,
      `Saíram ${mzn(outflow)} e só entraram ${mzn(inflow)}.`,
    ]);
  }

  if (!sameMoney(balance, expectedBalance(payment))) {
    problems.push([
      ReconciliationCheck.BALANCE_MISMATCH,
      `Restam ${mzn(balance)} no escrow e, com o pagamento ${payment.status} e o depósito ${payment.depositStatus}, deviam restar ${mzn(expectedBalance(payment))}.`,
    ]);
  }

  return problems;
}

function checkPayouts(
  payment: PaymentSnapshot,
): [ReconciliationCheck, string][] {
  const { outflowToClient, outflowToProvider } = payment.ledger;
  const problems: [ReconciliationCheck, string][] = [];

  if (!sameMoney(payment.payouts.toClient, outflowToClient)) {
    problems.push([
      ReconciliationCheck.CLIENT_PAYOUTS_MISMATCH,
      `O ledger tem ${mzn(outflowToClient)} de saídas para o cliente e os payouts somam ${mzn(payment.payouts.toClient)}.`,
    ]);
  }

  if (!sameMoney(payment.payouts.toProvider, outflowToProvider)) {
    problems.push([
      ReconciliationCheck.PROVIDER_PAYOUTS_MISMATCH,
      `O ledger tem ${mzn(outflowToProvider)} de saídas para o provider e os payouts somam ${mzn(payment.payouts.toProvider)}.`,
    ]);
  }

  return problems;
}

function checkReservation(
  payment: PaymentSnapshot,
): [ReconciliationCheck, string][] {
  const { bookingStatus, serviceBookingStatus, status } = payment;

  if (bookingStatus) {
    return BOOKING_STATES[status].includes(bookingStatus)
      ? []
      : [
          [
            ReconciliationCheck.RESERVATION_STATE_MISMATCH,
            `A reserva está ${bookingStatus} com o pagamento ${status}.`,
          ],
        ];
  }

  if (serviceBookingStatus) {
    return SERVICE_BOOKING_STATES[status].includes(serviceBookingStatus)
      ? []
      : [
          [
            ReconciliationCheck.RESERVATION_STATE_MISMATCH,
            `A reserva de serviço está ${serviceBookingStatus} com o pagamento ${status}.`,
          ],
        ];
  }

  return [
    [
      ReconciliationCheck.RESERVATION_STATE_MISMATCH,
      'O pagamento não tem reserva associada.',
    ],
  ];
}

function checkDeposit(
  payment: PaymentSnapshot,
): [ReconciliationCheck, string][] {
  const { depositStatus, depositAmount, status } = payment;
  const hasDeposit = cents(depositAmount) > 0;
  const mismatch = (detail: string): [ReconciliationCheck, string][] => [
    [ReconciliationCheck.DEPOSIT_STATE_MISMATCH, detail],
  ];

  if (depositStatus !== DepositStatus.NONE && !hasDeposit) {
    return mismatch(
      `O depósito está ${depositStatus} num pagamento sem depósito.`,
    );
  }

  const moneyIsInEscrow =
    status === PaymentStatus.HELD ||
    status === PaymentStatus.RELEASED ||
    status === PaymentStatus.PARTIALLY_REFUNDED;

  if (depositStatus === DepositStatus.HELD && !moneyIsInEscrow) {
    return mismatch(`O depósito está HELD com o pagamento ${status}.`);
  }

  const expectedWhileHeld = hasDeposit
    ? DepositStatus.HELD
    : DepositStatus.NONE;

  if (status === PaymentStatus.HELD && depositStatus !== expectedWhileHeld) {
    return mismatch(
      `Com o pagamento HELD, o depósito devia estar ${expectedWhileHeld} e está ${depositStatus}.`,
    );
  }

  return [];
}

/**
 * Confere um pagamento contra o seu ledger, os seus payouts e a sua reserva.
 * Devolve uma linha por cada coisa que não bate certo, e nenhuma quando está
 * tudo em ordem. Não escreve nem corrige nada.
 */
export function reconcilePayment(
  payment: PaymentSnapshot,
): ReconciliationFinding[] {
  return [
    ...checkLedger(payment),
    ...checkPayouts(payment),
    ...checkReservation(payment),
    ...checkDeposit(payment),
  ].map(([check, detail]) => ({
    paymentId: payment.id,
    receiptNumber: payment.receiptNumber,
    check,
    detail,
  }));
}
