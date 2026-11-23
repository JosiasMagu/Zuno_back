import {
  BookingStatus,
  DisputeType,
  ServiceBookingStatus,
} from '@prisma/client';

import { isProjectMediaUrl } from '../../shared/cloudinary/project-media-url';
import { DISPUTE_RESPONSE_WINDOW_DAYS } from '../../shared/constants/policy';

const DAY_MS = 24 * 60 * 60 * 1000;

/** As duas partes de uma reserva, de aluguer ou de serviço. */
export interface DisputeParties {
  clientId: string;
  providerId: string;
}

/**
 * Quem tem de responder a uma disputa: a parte que não a abriu. É o provider
 * quando o cliente abre, e o cliente quando abre o provider, como acontece
 * sempre na reclamação do depósito.
 */
export function respondentOf(
  parties: DisputeParties,
  openedBy: string,
): string {
  return parties.clientId === openedBy ? parties.providerId : parties.clientId;
}

/** Até quando a outra parte pode responder a uma disputa aberta em `openedAt`. */
export function responseDeadline(openedAt: Date): Date {
  return new Date(openedAt.getTime() + DISPUTE_RESPONSE_WINDOW_DAYS * DAY_MS);
}

/**
 * O estado a que um aluguer volta quando a disputa é retirada. Uma disputa de
 * pagamento só se abre com a reserva confirmada e à espera da entrega. Uma de
 * depósito só se abre com o equipamento entregue.
 */
export function rentalStatusBeforeDispute(type: DisputeType): BookingStatus {
  return type === DisputeType.DEPOSIT
    ? BookingStatus.ACTIVE
    : BookingStatus.CONFIRMED;
}

/**
 * O estado a que um serviço volta quando a disputa é retirada, lido das datas
 * que a reserva guarda: concluído, em execução ou ainda por começar.
 */
export function serviceStatusBeforeDispute(booking: {
  startedAt: Date | null;
  completedAt: Date | null;
}): ServiceBookingStatus {
  if (booking.completedAt) return ServiceBookingStatus.COMPLETED;
  if (booking.startedAt) return ServiceBookingStatus.IN_PROGRESS;
  return ServiceBookingStatus.PENDING;
}

/**
 * Uma prova só vale se for uma foto que o próprio utilizador carregou em
 * POST /disputes/upload-evidence: no Cloudinary do projecto, na pasta dele.
 * Assim nenhum link de fora chega ao ecrã de quem decide a disputa.
 */
export function isOwnEvidence(
  url: string,
  owner: { cloudName: string; userId: string },
): boolean {
  return (
    isProjectMediaUrl(url, owner.cloudName) &&
    new URL(url).pathname.includes(`/zuno/disputes/${owner.userId}/`)
  );
}
