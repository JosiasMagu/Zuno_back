type DisputeEntity = {
  id: string;
  bookingId: string | null;
  serviceBookingId?: string | null;
  paymentId: string;
  openedBy: string;
  type?: string;
  reason: string;
  description: string;
  evidenceUrls?: string[] | null;
  response: string | null;
  responseEvidenceUrls?: string[] | null;
  respondedAt?: Date | null;
  respondedBy?: string | null;
  status: string;
  resolution: string | null;
  refundPercent: number | null;
  autoResolvedAt: Date | null;
  responseDeadline: Date | null;
  closedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  booking: {
    id: string;
    status: string;
    startDate: Date;
    endDate: Date;
    clientId?: string;
    ownerId?: string;
  } | null;
  serviceBooking?: {
    id: string;
    status: string;
    scheduledFor: Date | null;
    clientId?: string;
    providerId?: string;
  } | null;
  payment: {
    id: string;
    status: string;
    totalCharged: unknown;
    receiptNumber: string;
    refundAmount?: unknown;
    rentalAmount?: unknown;
    depositAmount?: unknown;
    depositStatus?: string;
  };
  opener: {
    id: string;
    name: string;
    avatarUrl: string | null;
  };
};

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

/** Quem tem de responder: a parte da reserva que não abriu a disputa. */
function respondentIdOf(dispute: DisputeEntity): string | null {
  const clientId =
    dispute.booking?.clientId ?? dispute.serviceBooking?.clientId ?? null;
  const providerId =
    dispute.booking?.ownerId ?? dispute.serviceBooking?.providerId ?? null;

  return dispute.openedBy === clientId ? providerId : clientId;
}

export class DisputePresenter {
  /**
   * A disputa como a vêem as duas partes e o admin: o que foi dito de cada
   * lado, com as provas, os prazos e o dinheiro em causa.
   */
  static toListItem(dispute: DisputeEntity) {
    return {
      id: dispute.id,
      bookingId: dispute.bookingId,
      serviceBookingId: dispute.serviceBookingId ?? null,
      paymentId: dispute.paymentId,
      openedBy: dispute.openedBy,
      respondentId: respondentIdOf(dispute),
      type: dispute.type ?? 'PAYMENT',
      reason: dispute.reason,
      description: dispute.description,
      evidenceUrls: dispute.evidenceUrls ?? [],
      response: dispute.response,
      responseEvidenceUrls: dispute.responseEvidenceUrls ?? [],
      respondedAt: dispute.respondedAt ?? null,
      responseDeadline: dispute.responseDeadline,
      // Nomes antigos, mantidos para a app que já os lê.
      ownerResponse: dispute.response,
      ownerDeadline: dispute.responseDeadline,
      status: dispute.status,
      resolution: dispute.resolution,
      refundPercent: dispute.refundPercent,
      autoResolvedAt: dispute.autoResolvedAt,
      closedAt: dispute.closedAt ?? null,
      createdAt: dispute.createdAt,
      updatedAt: dispute.updatedAt,
      booking: dispute.booking
        ? {
            id: dispute.booking.id,
            status: dispute.booking.status,
            startDate: dispute.booking.startDate,
            endDate: dispute.booking.endDate,
            clientId: dispute.booking.clientId,
            ownerId: dispute.booking.ownerId,
          }
        : null,
      serviceBooking: dispute.serviceBooking
        ? {
            id: dispute.serviceBooking.id,
            status: dispute.serviceBooking.status,
            scheduledFor: dispute.serviceBooking.scheduledFor,
            clientId: dispute.serviceBooking.clientId,
            providerId: dispute.serviceBooking.providerId,
          }
        : null,
      payment: {
        id: dispute.payment.id,
        status: dispute.payment.status,
        totalCharged: Number(dispute.payment.totalCharged),
        receiptNumber: dispute.payment.receiptNumber,
        refundAmount: toNumber(dispute.payment.refundAmount),
        rentalAmount: toNumber(dispute.payment.rentalAmount),
        depositAmount: toNumber(dispute.payment.depositAmount),
        depositStatus: dispute.payment.depositStatus ?? null,
      },
      opener: {
        id: dispute.opener.id,
        name: dispute.opener.name,
        avatarUrl: dispute.opener.avatarUrl,
      },
    };
  }

  static toDetails(dispute: DisputeEntity) {
    return this.toListItem(dispute);
  }
}
