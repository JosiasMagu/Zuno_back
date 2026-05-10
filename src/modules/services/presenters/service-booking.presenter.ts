type ServiceBookingEntity = {
  id: string;
  clientId: string;
  providerId: string;
  serviceId: string;
  requestId: string;
  quoteId: string;
  scheduledFor: Date | null;
  isUrgent: boolean;
  serviceAmount: unknown;
  platformFee: unknown;
  totalAmount: unknown;
  status: string;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  service?: {
    id: string;
    title: string;
  };
  client?: {
    id: string;
    name: string;
    avatarUrl: string | null;
  };
  provider?: {
    id: string;
    name: string;
    avatarUrl: string | null;
  };
  payment?: {
    id: string;
    status: string;
    receiptNumber: string;
  } | null;
};

export class ServiceBookingPresenter {
  static toItem(booking: ServiceBookingEntity) {
    return {
      id: booking.id,
      clientId: booking.clientId,
      providerId: booking.providerId,
      serviceId: booking.serviceId,
      requestId: booking.requestId,
      quoteId: booking.quoteId,
      scheduledFor: booking.scheduledFor,
      isUrgent: booking.isUrgent,
      serviceAmount: Number(booking.serviceAmount),
      platformFee: Number(booking.platformFee),
      totalAmount: Number(booking.totalAmount),
      status: booking.status,
      startedAt: booking.startedAt,
      completedAt: booking.completedAt,
      cancelledAt: booking.cancelledAt,
      cancellationReason: booking.cancellationReason,
      createdAt: booking.createdAt,
      updatedAt: booking.updatedAt,
      service: booking.service
        ? { id: booking.service.id, title: booking.service.title }
        : undefined,
      client: booking.client
        ? {
            id: booking.client.id,
            name: booking.client.name,
            avatarUrl: booking.client.avatarUrl,
          }
        : undefined,
      provider: booking.provider
        ? {
            id: booking.provider.id,
            name: booking.provider.name,
            avatarUrl: booking.provider.avatarUrl,
          }
        : undefined,
      payment: booking.payment
        ? {
            id: booking.payment.id,
            status: booking.payment.status,
            receiptNumber: booking.payment.receiptNumber,
          }
        : null,
    };
  }
}
