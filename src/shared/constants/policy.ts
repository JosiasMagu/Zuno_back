// Política financeira e temporal da plataforma (Decisões D1/D2 — ver DECISOES-FASE-0.md).
// Para alterar qualquer regra de negócio destas, mudar APENAS neste ficheiro.

/** Janela em que o cliente pode cancelar sem penalização (horas antes do startDate). */
export const CANCELLATION_FREE_WINDOW_HOURS = 48;

/** Percentagem do rental retida para o provider em cancelamento tardio do cliente. */
export const LATE_CANCELLATION_RETENTION_PERCENT = 30;

/** Janela após o endDate em que o provider pode reclamar o depósito (horas). */
export const DEPOSIT_CLAIM_WINDOW_HOURS = 48;

/**
 * Dias após o startDate em que, sem confirmação de entrega nem disputa,
 * o sistema liberta automaticamente o pagamento ao provider.
 */
export const DELIVERY_AUTO_RELEASE_DAYS = 3;

/** Strikes de provider que resultam em suspensão de listagens. */
export const PROVIDER_STRIKE_LIMIT = 3;

/** Janela deslizante em que os strikes contam (dias). */
export const PROVIDER_STRIKE_WINDOW_DAYS = 90;

/** Duração da suspensão de listagens após atingir o limite de strikes (dias). */
export const PROVIDER_LISTINGS_SUSPENSION_DAYS = 30;

/** Arredondamento canónico de valores monetários (MZN, 2 casas). */
export function roundMoney(value: number): number {
  return Number(value.toFixed(2));
}
