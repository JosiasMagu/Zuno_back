import { SERVICE_AUTO_RELEASE_DAYS } from '../../../shared/constants/policy';

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
  /** Até quando a reserva pode ser paga. Null depois de o pagamento entrar. */
  expiresAt?: Date | null;
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
    /** Quando o cliente declarou que pagou. */
    declaredAt?: Date | null;
  } | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Quando o pagamento é libertado sozinho, se o cliente não o confirmar nem
 * abrir disputa. Só existe com o serviço concluído e o dinheiro ainda retido.
 */
function autoReleaseAt(booking: ServiceBookingEntity): Date | null {
  const awaitsClient =
    booking.status === 'COMPLETED' && booking.payment?.status === 'HELD';

  if (!awaitsClient || !booking.completedAt) {
    return null;
  }

  return new Date(
    booking.completedAt.getTime() + SERVICE_AUTO_RELEASE_DAYS * DAY_MS,
  );
}

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
      expiresAt: booking.expiresAt ?? null,
      autoReleaseAt: autoReleaseAt(booking),
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
            declaredAt: booking.payment.declaredAt ?? null,
          }
        : null,
    };
  }
}
