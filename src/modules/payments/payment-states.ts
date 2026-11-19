import { PaymentStatus } from '@prisma/client';

/**
 * Estados do pagamento em que o aluguer já foi pago ao provider, por inteiro
 * ou em parte (resolução parcial de uma disputa). A partir daí só o depósito
 * pode continuar retido, à espera da devolução do equipamento.
 */
export const RENTAL_PAID_OUT_STATUSES: PaymentStatus[] = [
  PaymentStatus.RELEASED,
  PaymentStatus.PARTIALLY_REFUNDED,
];
