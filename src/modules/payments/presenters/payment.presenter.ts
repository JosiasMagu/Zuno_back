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
  releasedAt: Date | null;
  refundedAt: Date | null;
  refundAmount: unknown;
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
  dispute?: {
    id: string;
    status: string;
  } | null;
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
      releasedAt: payment.releasedAt,
      refundedAt: payment.refundedAt,
      refundAmount: toNumber(payment.refundAmount),
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
    };
  }

  static toDetails(payment: PaymentDetailsEntity) {
    return {
      id: payment.id,
      bookingId: payment.bookingId,
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
      releasedAt: payment.releasedAt,
      refundedAt: payment.refundedAt,
      refundAmount: toNumber(payment.refundAmount),
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
            totalDays: payment.booking.totalDays,
            status: payment.booking.status,
            deliveryAddress: payment.booking.deliveryAddress,
            clientNote: payment.booking.clientNote,
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
      dispute: payment.dispute
        ? {
            id: payment.dispute.id,
            status: payment.dispute.status,
          }
        : null,
    };
  }
}
