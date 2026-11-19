import { EquipmentStatus, Prisma, ServiceStatus } from '@prisma/client';

import {
  PROVIDER_LISTINGS_SUSPENSION_DAYS,
  PROVIDER_STRIKE_LIMIT,
  PROVIDER_STRIKE_WINDOW_DAYS,
} from '../constants/policy';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ProviderStrikeInput {
  providerId: string;
  /** A reserva de equipamento que o provider cancelou. */
  bookingId?: string;
  /** A reserva de serviço que o provider cancelou. */
  serviceBookingId?: string;
  reason: string;
}

/**
 * Regista um strike do provider, dentro da transacção que cancela a reserva.
 *
 * Ao atingir o limite dentro da janela, os anúncios do provider ficam
 * suspensos: os equipamentos e os serviços activos passam a estar em pausa e
 * só voltam quando a suspensão acabar e ele os reabrir.
 *
 * Devolve até quando dura a suspensão, ou null se o limite não foi atingido.
 */
export async function issueProviderStrike(
  tx: Prisma.TransactionClient,
  strike: ProviderStrikeInput,
): Promise<Date | null> {
  await tx.providerStrike.create({
    data: {
      userId: strike.providerId,
      bookingId: strike.bookingId ?? null,
      serviceBookingId: strike.serviceBookingId ?? null,
      reason: strike.reason,
    },
  });

  const now = Date.now();
  const windowStart = new Date(now - PROVIDER_STRIKE_WINDOW_DAYS * DAY_MS);

  const strikeCount = await tx.providerStrike.count({
    where: { userId: strike.providerId, createdAt: { gte: windowStart } },
  });
  if (strikeCount < PROVIDER_STRIKE_LIMIT) {
    return null;
  }

  const suspendedUntil = new Date(
    now + PROVIDER_LISTINGS_SUSPENSION_DAYS * DAY_MS,
  );

  await tx.user.update({
    where: { id: strike.providerId },
    data: { listingsSuspendedUntil: suspendedUntil },
  });
  await tx.equipment.updateMany({
    where: { ownerId: strike.providerId, status: EquipmentStatus.ACTIVE },
    data: { isAvailable: false },
  });
  await tx.service.updateMany({
    where: { providerId: strike.providerId, status: ServiceStatus.ACTIVE },
    data: { isActive: false },
  });

  return suspendedUntil;
}
