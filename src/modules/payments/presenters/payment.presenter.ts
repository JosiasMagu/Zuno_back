import { CollectionPresenter } from './collection.presenter';

type PaymentListEntity = {
  id: string;
  bookingId: string | null;
  serviceBookingId?: string | null;
  clientId: string;
  ownerId: string;
  rentalAmount: unknown;
  depositAmount: unknown;
  platformFee: unknown;
  totalCharged: unknown;
  ownerPayout: unknown;
  currency: string;
  method: string;
  mpesaReference: string | null;
  status: string;
  heldAt: Date | null;
  /** Quando o cliente declarou que pagou. Null se ainda não declarou. */
  declaredAt?: Date | null;
  releasedAt: Date | null;
  refundedAt: Date | null;
  refundAmount: unknown;
  depositStatus?: string;
  depositReleasedAt: Date | null;
  depositHeldAmount: unknown;
  receiptNumber: string;
  createdAt: Date;
  updatedAt: Date;
  booking: {
    id: string;
    startDate: Date;
    endDate: Date;
    status: string;
  } | null;
  serviceBooking?: {
    id: string;
    status: string;
    scheduledFor: Date | null;
  } | null;
  client?: {
    id: string;
    name: string;
    avatarUrl: string | null;
  };
  owner?: {
    id: string;
    name: string;
    avatarUrl: string | null;
  };
};

type PaymentDetailsEntity = PaymentListEntity & {
  booking: {
    id: string;
    startDate: Date;
    endDate: Date;
    totalDays: number;
    status: string;
    deliveryAddress: string | null;
    clientNote: string | null;
  } | null;
  /** A disputa mais recente da reserva, quando a consulta a traz. */
  disputes?: { id: string; status: string }[];
  /** A cobrança mais recente no telemóvel, quando a consulta a traz. */
  providerOperations?: Parameters<typeof CollectionPresenter.toItem>[0][];
};

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

export class PaymentPresenter {
  static toListItem(payment: PaymentListEntity) {
    return {
      id: payment.id,
      bookingId: payment.bookingId,
      serviceBookingId: payment.serviceBookingId ?? null,
      rentalAmount: Number(payment.rentalAmount),
      depositAmount: Number(payment.depositAmount),
      platformFee: Number(payment.platformFee),
      totalCharged: Number(payment.totalCharged),
      ownerPayout: toNumber(payment.ownerPayout),
      currency: payment.currency,
      method: payment.method,
      mpesaReference: payment.mpesaReference,
      status: payment.status,
      heldAt: payment.heldAt,
      declaredAt: payment.declaredAt ?? null,
      releasedAt: payment.releasedAt,
      refundedAt: payment.refundedAt,
      refundAmount: toNumber(payment.refundAmount),
      depositStatus: payment.depositStatus ?? null,
      depositReleasedAt: payment.depositReleasedAt,
      depositHeldAmount: toNumber(payment.depositHeldAmount),
      receiptNumber: payment.receiptNumber,
      createdAt: payment.createdAt,
      updatedAt: payment.updatedAt,
      booking: payment.booking
        ? {
            id: payment.booking.id,
            startDate: payment.booking.startDate,
            endDate: payment.booking.endDate,
            status: payment.booking.status,
          }
        : null,
      serviceBooking: payment.serviceBooking
        ? {
            id: payment.serviceBooking.id,
            status: payment.serviceBooking.status,
            scheduledFor: payment.serviceBooking.scheduledFor,
          }
        : null,
      client: payment.client
        ? {
            id: payment.client.id,
            name: payment.client.name,
            avatarUrl: payment.client.avatarUrl,
          }
        : undefined,
      owner: payment.owner
        ? {
            id: payment.owner.id,
            name: payment.owner.name,
            avatarUrl: payment.owner.avatarUrl,
          }
        : undefined,
      ownerId: payment.ownerId,
    };
  }

  /**
   * O pagamento como o vê quem o declarou: a referência que indicou e até
   * quando a reserva espera pela confirmação do admin.
   */
  static toDeclared(
    payment: PaymentListEntity & {
      declaredReference: string | null;
      booking: { expiresAt: Date | null } | null;
      serviceBooking: { expiresAt: Date | null } | null;
    },
  ) {
    const reservation = payment.booking ?? payment.serviceBooking;

    return {
      ...PaymentPresenter.toListItem(payment),
      declaredReference: payment.declaredReference,
      confirmBy: reservation?.expiresAt ?? null,
    };
  }

  /**
   * Um pagamento na fila do admin: o que o cliente declarou, para comparar
   * com o extracto, e até quando a reserva espera pela confirmação.
   */
  static toAwaitingConfirmation(payment: {
    id: string;
    receiptNumber: string;
    totalCharged: unknown;
    declaredReference: string | null;
    declaredPayerMsisdn: string | null;
    declaredAt: Date | null;
    booking: { id: string; expiresAt: Date | null } | null;
    serviceBooking: { id: string; expiresAt: Date | null } | null;
    client: { id: string; name: string; phone: string };
  }) {
    const reservation = payment.booking ?? payment.serviceBooking;

    return {
      id: payment.id,
      receiptNumber: payment.receiptNumber,
      totalCharged: Number(payment.totalCharged),
      declaredReference: payment.declaredReference,
      declaredPayerMsisdn: payment.declaredPayerMsisdn,
      declaredAt: payment.declaredAt,
      confirmBy: reservation?.expiresAt ?? null,
      bookingId: payment.booking?.id ?? null,
      serviceBookingId: payment.serviceBooking?.id ?? null,
      client: {
        id: payment.client.id,
        name: payment.client.name,
        phone: payment.client.phone,
      },
    };
  }

  /**
   * `seesPayerNumber`: o número de onde saiu o dinheiro é do cliente. Só ele
   * e um admin o vêem; para o provider sai vazio.
   */
  static toDetails(
    payment: PaymentDetailsEntity,
    viewer: { seesPayerNumber: boolean },
  ) {
    const [lastCollection] = payment.providerOperations ?? [];
    const collection = lastCollection
      ? CollectionPresenter.toItem(lastCollection)
      : null;
    const [dispute] = payment.disputes ?? [];

    return {
      ...PaymentPresenter.toListItem(payment),
      booking: payment.booking
        ? {
            id: payment.booking.id,
            startDate: payment.booking.startDate,
            endDate: payment.booking.endDate,
            totalDays: payment.booking.totalDays,
            status: payment.booking.status,
            deliveryAddress: payment.booking.deliveryAddress,
            clientNote: payment.booking.clientNote,
          }
        : null,
      dispute: dispute ? { id: dispute.id, status: dispute.status } : null,
      // A cobrança mais recente no telemóvel: em curso, confirmada ou falhada.
      collection:
        collection && !viewer.seesPayerNumber
          ? { ...collection, msisdn: null }
          : collection,
    };
  }
}
