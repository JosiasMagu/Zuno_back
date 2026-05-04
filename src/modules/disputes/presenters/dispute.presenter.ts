type DisputeListEntity = {
  id: string;
  bookingId: string;
  paymentId: string;
  openedBy: string;
  reason: string;
  description: string;
  ownerResponse: string | null;
  status: string;
  resolution: string | null;
  refundPercent: number | null;
  autoResolvedAt: Date | null;
  ownerDeadline: Date | null;
  createdAt: Date;
  updatedAt: Date;
  booking: {
    id: string;
    status: string;
    startDate: Date;
    endDate: Date;
    clientId?: string;
    ownerId?: string;
  };
  payment: {
    id: string;
    status: string;
    totalCharged: unknown;
    receiptNumber: string;
    refundAmount?: unknown;
  };
  opener: {
    id: string;
    name: string;
    avatarUrl: string | null;
  };
};

type DisputeDetailsEntity = DisputeListEntity;

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

export class DisputePresenter {
  static toListItem(dispute: DisputeListEntity) {
    return {
      id: dispute.id,
      bookingId: dispute.bookingId,
      paymentId: dispute.paymentId,
      openedBy: dispute.openedBy,
      reason: dispute.reason,
      description: dispute.description,
      ownerResponse: dispute.ownerResponse,
      status: dispute.status,
      resolution: dispute.resolution,
      refundPercent: dispute.refundPercent,
      autoResolvedAt: dispute.autoResolvedAt,
      ownerDeadline: dispute.ownerDeadline,
      createdAt: dispute.createdAt,
      updatedAt: dispute.updatedAt,
      booking: {
        id: dispute.booking.id,
        status: dispute.booking.status,
        startDate: dispute.booking.startDate,
        endDate: dispute.booking.endDate,
        clientId: dispute.booking.clientId,
        ownerId: dispute.booking.ownerId,
      },
      payment: {
        id: dispute.payment.id,
        status: dispute.payment.status,
        totalCharged: Number(dispute.payment.totalCharged),
        receiptNumber: dispute.payment.receiptNumber,
        refundAmount: toNumber(dispute.payment.refundAmount),
      },
      opener: {
        id: dispute.opener.id,
        name: dispute.opener.name,
        avatarUrl: dispute.opener.avatarUrl,
      },
    };
  }
  833915119;

  static toDetails(dispute: DisputeDetailsEntity) {
    return this.toListItem(dispute);
  }
}
