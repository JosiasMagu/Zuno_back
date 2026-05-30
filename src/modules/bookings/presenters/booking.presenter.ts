type BookingBaseEntity = {
  id: string;
  clientId: string;
  /** Renomeado em código a partir de ownerId (coluna DB ainda é "ownerId"). */
  providerId: string;
  equipmentId: string;
  startDate: Date;
  endDate: Date;
  totalDays: number;
  rentalAmount: unknown;
  depositAmount: unknown;
  platformFee: unknown;
  totalAmount: unknown;
  status: string;
  deliveryAddress: string | null;
  clientNote: string | null;
  confirmedAt: Date | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type BookingListEntity = BookingBaseEntity & {
  equipment: {
    id: string;
    title: string;
    location: string;
    status: string;
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
};

type BookingDetailsEntity = BookingBaseEntity & {
  equipment: {
    id: string;
    title: string;
    description?: string | null;
    location: string;
    status: string;
    pricePerDay?: unknown;
    depositAmount?: unknown;
  };
  client: {
    id: string;
    name: string;
    avatarUrl: string | null;
  };
  provider: {
    id: string;
    name: string;
    avatarUrl: string | null;
  };
  payment?: {
    id: string;
    status: string;
    totalCharged: unknown;
    mpesaReference: string | null;
    receiptNumber: string;
    heldAt: Date | null;
    releasedAt: Date | null;
  } | null;
};

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

/**
 * Presenters expõem AMBOS `owner`/`ownerId` (legacy) e `provider`/`providerId`
 * (novo) no payload da API. Permite migrar o frontend para o nome semantico
 * sem quebrar clientes antigos. Quando todos os consumidores migrarem,
 * remover os campos legacy num PR isolado.
 */
export class BookingPresenter {
  static toListItem(booking: BookingListEntity) {
    const providerPayload = booking.provider
      ? {
          id: booking.provider.id,
          name: booking.provider.name,
          avatarUrl: booking.provider.avatarUrl,
        }
      : undefined;

    return {
      id: booking.id,
      startDate: booking.startDate,
      endDate: booking.endDate,
      totalDays: booking.totalDays,
      rentalAmount: Number(booking.rentalAmount),
      depositAmount: Number(booking.depositAmount),
      platformFee: Number(booking.platformFee),
      totalAmount: Number(booking.totalAmount),
      status: booking.status,
      deliveryAddress: booking.deliveryAddress,
      clientNote: booking.clientNote,
      confirmedAt: booking.confirmedAt,
      cancelledAt: booking.cancelledAt,
      cancellationReason: booking.cancellationReason,
      createdAt: booking.createdAt,
      updatedAt: booking.updatedAt,
      equipment: {
        id: booking.equipment.id,
        title: booking.equipment.title,
        location: booking.equipment.location,
        status: booking.equipment.status,
      },
      client: booking.client
        ? {
            id: booking.client.id,
            name: booking.client.name,
            avatarUrl: booking.client.avatarUrl,
          }
        : undefined,
      // Backward compat: expõe ambos
      owner: providerPayload,
      provider: providerPayload,
      ownerId: booking.providerId,
      providerId: booking.providerId,
    };
  }

  static toDetails(booking: BookingDetailsEntity) {
    const providerPayload = {
      id: booking.provider.id,
      name: booking.provider.name,
      avatarUrl: booking.provider.avatarUrl,
    };

    return {
      id: booking.id,
      startDate: booking.startDate,
      endDate: booking.endDate,
      totalDays: booking.totalDays,
      rentalAmount: Number(booking.rentalAmount),
      depositAmount: Number(booking.depositAmount),
      platformFee: Number(booking.platformFee),
      totalAmount: Number(booking.totalAmount),
      status: booking.status,
      deliveryAddress: booking.deliveryAddress,
      clientNote: booking.clientNote,
      confirmedAt: booking.confirmedAt,
      cancelledAt: booking.cancelledAt,
      cancellationReason: booking.cancellationReason,
      createdAt: booking.createdAt,
      updatedAt: booking.updatedAt,
      equipment: {
        id: booking.equipment.id,
        title: booking.equipment.title,
        description: booking.equipment.description ?? null,
        location: booking.equipment.location,
        status: booking.equipment.status,
        pricePerDay: toNumber(booking.equipment.pricePerDay),
        depositAmount: toNumber(booking.equipment.depositAmount),
      },
      client: {
        id: booking.client.id,
        name: booking.client.name,
        avatarUrl: booking.client.avatarUrl,
      },
      // Backward compat: expõe ambos
      owner: providerPayload,
      provider: providerPayload,
      ownerId: booking.providerId,
      providerId: booking.providerId,
      payment: booking.payment ? {
        id: booking.payment.id,
        status: booking.payment.status,
        totalCharged: Number(booking.payment.totalCharged),
        mpesaReference: booking.payment.mpesaReference,
        receiptNumber: booking.payment.receiptNumber,
        heldAt: booking.payment.heldAt,
        releasedAt: booking.payment.releasedAt,
      } : null,
    };
  }
}
