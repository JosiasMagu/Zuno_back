/** Motivo que fica na reserva que expirou sem ninguém dizer que a pagou. */
export const UNPAID_REASON =
  'A reserva expirou porque não foi paga dentro do prazo.';

/**
 * Motivo que fica na reserva cujo pagamento o cliente declarou e o admin não
 * confirmou dentro da janela. Distingue-se do anterior porque aqui pode haver
 * dinheiro por reconciliar.
 */
export const UNCONFIRMED_REASON =
  'A reserva expirou porque o pagamento declarado não foi confirmado a tempo.';

/** O motivo de expiração de uma reserva, conforme o pagamento foi ou não declarado. */
export function expiryReason(
  payment: { declaredAt: Date | null } | null | undefined,
): string {
  return payment?.declaredAt ? UNCONFIRMED_REASON : UNPAID_REASON;
}
