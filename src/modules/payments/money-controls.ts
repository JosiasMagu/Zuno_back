import type { ConfigService } from '@nestjs/config';

import { ApiErrors } from '../../common/exceptions/api.exception';
import { ErrorCode } from '../../common/exceptions/error-codes';
import { PAYOUT_AUTO_MAX_AMOUNT } from '../../shared/constants/policy';

/**
 * Controlos sobre quem mexe no dinheiro. Um admin sozinho conseguia dar como
 * recebido um pagamento que nunca entrou e mandar o payout dele a quem
 * quisesse. Estas regras tornam isso impossível ou, com quatro olhos, obrigam
 * a duas pessoas.
 */

type ConfigReader = Pick<ConfigService, 'get'>;

/** Com MONEY_FOUR_EYES=true, a entrada e a saída do dinheiro exigem duas pessoas. */
export function fourEyesEnabled(config: ConfigReader): boolean {
  return config.get<string>('MONEY_FOUR_EYES') === 'true';
}

/** O valor até ao qual um payout sai pelo fornecedor sem aprovação. */
export function payoutAutoMaxAmount(config: ConfigReader): number {
  const configured = config.get<number | string>('PAYOUT_AUTO_MAX_AMOUNT');
  return configured === undefined || configured === null || configured === ''
    ? PAYOUT_AUTO_MAX_AMOUNT
    : Number(configured);
}

/** Um payout pendente acima do valor automático espera por um admin. */
export function payoutNeedsApproval(
  payout: { status: string; amount: unknown; approvedAt: Date | null },
  autoMaxAmount: number,
): boolean {
  return (
    payout.status === 'PENDING' &&
    !payout.approvedAt &&
    Number(payout.amount) > autoMaxAmount
  );
}

/**
 * Um admin não confirma a entrada nem decide o reembolso do dinheiro de uma
 * reserva em que é parte.
 */
export function assertNotPartyToPayment(
  adminId: string,
  payment: { clientId: string; ownerId: string },
): void {
  if (adminId === payment.clientId || adminId === payment.ownerId) {
    throw ApiErrors.forbidden(
      ErrorCode.MONEY_CONTROL_VIOLATION,
      'Um admin não decide sobre o dinheiro de uma reserva em que é cliente ou dono. Pede a outro admin.',
    );
  }
}

/**
 * Quem recebe o pagamento nunca o libera. A regra já valia para o provider; o
 * role ADMIN não a contorna.
 */
export function assertNotPayee(
  userId: string,
  payment: { ownerId: string },
): void {
  if (userId === payment.ownerId) {
    throw ApiErrors.forbidden(
      ErrorCode.MONEY_CONTROL_VIOLATION,
      'Quem recebe este pagamento não o pode liberar, mesmo sendo admin.',
    );
  }
}

/** Um admin não aprova nem executa um payout para si próprio. */
export function assertNotOwnPayout(
  adminId: string,
  payout: { recipientId: string },
): void {
  if (adminId === payout.recipientId) {
    throw ApiErrors.forbidden(
      ErrorCode.MONEY_CONTROL_VIOLATION,
      'Um admin não aprova nem executa um payout para si próprio.',
    );
  }
}

/**
 * Com quatro olhos ligado, quem deu o dinheiro como entrado não aprova nem
 * executa as saídas desse pagamento: a entrada e a saída passam por duas
 * pessoas. Um pagamento confirmado pelo fornecedor ('system') não prende
 * ninguém.
 */
export function assertFourEyes(
  enabled: boolean,
  adminId: string,
  payment: { heldById: string | null },
): void {
  if (enabled && payment.heldById === adminId) {
    throw ApiErrors.forbidden(
      ErrorCode.MONEY_CONTROL_VIOLATION,
      'Quem confirmou a entrada deste dinheiro não pode aprovar nem executar a saída dele. Pede a outro admin.',
    );
  }
}
