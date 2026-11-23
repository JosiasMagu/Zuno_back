// Política financeira e temporal da plataforma. As decisões que lhe deram
// origem (D1 e D2) estão em docs/DECISOES-FASE-0.md.
// Para alterar qualquer regra de negócio destas, mudar apenas neste ficheiro.

import { Prisma } from '@prisma/client';

/** Janela em que o cliente pode cancelar sem penalização (horas antes do startDate). */
export const CANCELLATION_FREE_WINDOW_HOURS = 48;

/** Percentagem do rental retida para o provider em cancelamento tardio do cliente. */
export const LATE_CANCELLATION_RETENTION_PERCENT = 30;

/**
 * Horas em que o provider pode reclamar o depósito. Contam do fim do aluguer
 * ou da entrega do equipamento, o que for mais tarde.
 */
export const DEPOSIT_CLAIM_WINDOW_HOURS = 48;

/**
 * Dias ao fim dos quais, sem confirmação de entrega nem disputa, o sistema
 * liberta o pagamento ao provider. Contam do início do aluguer ou da entrada
 * do dinheiro no escrow, o que for mais tarde.
 */
export const DELIVERY_AUTO_RELEASE_DAYS = 3;

/** Horas que uma reserva tem para ser paga, contadas da criação (D5). */
export const BOOKING_PAYMENT_WINDOW_HOURS = 24;

/** Uma reserva por pagar expira estas horas antes do início do aluguer, se isso for mais cedo (D5). */
export const BOOKING_PAYMENT_CUTOFF_HOURS_BEFORE_START = 2;

/** Horas que qualquer reserva tem para ser paga, mesmo quando é feita em cima do início. */
export const BOOKING_PAYMENT_MIN_WINDOW_HOURS = 2;

/** Duração máxima de uma reserva, em dias. */
export const BOOKING_MAX_DAYS = 90;

/**
 * Tectos do que um cliente pode ter reservado sem pagar: o número de reservas
 * no total e os dias no mesmo anúncio. Uma reserva por pagar ocupa as datas
 * sem custo, e sem tecto uma conta fechava o calendário de um concorrente o
 * ano inteiro. Dois fins-de-semana ou duas unidades na mesma semana cabem
 * folgados nos dias de um anúncio.
 */
export const UNPAID_BOOKINGS_PER_CLIENT = 5;
export const UNPAID_DAYS_PER_LISTING = BOOKING_MAX_DAYS;

/**
 * Horas que o admin tem para confirmar no extracto um pagamento que o cliente
 * declarou. Enquanto correm, a reserva não expira: o prazo de pagamento mede
 * o que o cliente fez, e não a demora de quem confirma.
 */
export const PAYMENT_CONFIRMATION_WINDOW_HOURS = 48;

/** Horas que uma reserva de serviço tem para ser paga, contadas da aceitação do orçamento. */
export const SERVICE_PAYMENT_WINDOW_HOURS = 24;

/**
 * Dias ao fim dos quais, depois de o provider dar o serviço por concluído e
 * sem o cliente o confirmar nem abrir disputa, o sistema liberta o pagamento.
 */
export const SERVICE_AUTO_RELEASE_DAYS = 3;

/**
 * Dias que a outra parte tem para responder a uma disputa. Passado o prazo,
 * a disputa segue para análise sem a resposta. Ninguém ganha por falta de
 * comparência: quem decide é sempre um admin.
 */
export const DISPUTE_RESPONSE_WINDOW_DAYS = 3;

/**
 * Disputas de cada tipo que a mesma pessoa abre sobre um pagamento. A segunda
 * serve a quem retirou a primeira de boa-fé e voltou a ser enganado. Sem
 * tecto, abrir e retirar adiava sem fim a libertação automática do dinheiro.
 */
export const DISPUTES_PER_OPENER = 2;

/** Strikes de provider que resultam em suspensão de listagens. */
export const PROVIDER_STRIKE_LIMIT = 3;

/** Janela deslizante em que os strikes contam (dias). */
export const PROVIDER_STRIKE_WINDOW_DAYS = 90;

/** Duração da suspensão de listagens após atingir o limite de strikes (dias). */
export const PROVIDER_LISTINGS_SUSPENSION_DAYS = 30;

/**
 * Fuso em que se contam os dias de uma reserva: o de Moçambique, duas horas à
 * frente de UTC e sem hora de Verão. Fica fixo no código para o dia de uma
 * reserva não depender do fuso do servidor, que num contentor é UTC.
 */
export const BUSINESS_UTC_OFFSET_HOURS = 2;

/**
 * Arredondamento canónico de valores monetários (MZN, 2 casas), com o meio
 * cêntimo a subir. Faz-se em decimal: `(1.005).toFixed(2)` dá 1.00, porque
 * em vírgula flutuante 1.005 é na verdade 1.00499999.
 */
export function roundMoney(value: number): number {
  return new Prisma.Decimal(value)
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
    .toNumber();
}

/**
 * Uma percentagem de um valor, já arredondada a cêntimos. A conta faz-se toda
 * em decimal: em vírgula flutuante, 10% de 1.15 dá 0.11499999 e arredondava
 * para 0.11 em vez de 0.12.
 */
export function percentOf(amount: number, percent: number): number {
  return new Prisma.Decimal(amount)
    .mul(percent)
    .div(100)
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
    .toNumber();
}

/**
 * Tectos dos valores de um anúncio. Ficam muito acima de qualquer aluguer
 * real. Existem para o total de uma reserva (preço por dia vezes
 * BOOKING_MAX_DAYS, mais a taxa e o depósito) caber sempre nas colunas da
 * base, em vez de rebentar com um erro 500.
 */
export const MAX_LISTING_PRICE = 10_000_000;
export const MAX_DEPOSIT_AMOUNT = 100_000_000;

/** Unidades que um anúncio de equipamento pode ter. */
export const MAX_EQUIPMENT_UNITS = 1000;

/**
 * Mensagens de chat que uma conta pode enviar por minuto, pelo REST e pelo
 * socket juntos. Chega para uma conversa a sério e trava um script.
 */
export const CHAT_MESSAGES_PER_MINUTE = 30;

/**
 * Conversas novas que uma conta pode abrir por dia. Sem tecto, um script
 * percorria o catálogo e escrevia a todos os providers.
 */
export const CHAT_NEW_CONVERSATIONS_PER_DAY = 20;

/**
 * Valor até ao qual um payout sai sozinho pelo fornecedor de pagamentos.
 * Acima disso precisa da aprovação de um admin. Sobrepõe-se com a variável
 * de ambiente PAYOUT_AUTO_MAX_AMOUNT. Proposta à espera de confirmação.
 */
export const PAYOUT_AUTO_MAX_AMOUNT = 5000;

/** Horas ao fim das quais um payout por executar aparece como atrasado. */
export const PAYOUT_STALE_HOURS = 48;

/** Horas antes da libertação automática em que o cliente é avisado. */
export const AUTO_RELEASE_REMINDER_HOURS = 24;

/**
 * Segundos sem resposta ao fim dos quais se pergunta ao fornecedor pelo
 * estado de uma operação.
 */
export const PROVIDER_STATUS_CHECK_AFTER_SECONDS = 30;

/** Horas sem resposta ao fim das quais uma operação aparece como presa. */
export const PROVIDER_OPERATION_STUCK_HOURS = 6;

/** Horas ao fim das quais dinheiro por atribuir ainda por devolver é alerta. */
export const UNALLOCATED_FUNDS_ALERT_HOURS = 48;
