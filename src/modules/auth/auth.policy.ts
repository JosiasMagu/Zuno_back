// Regras de segurança das contas. Para mudar uma, muda-se só aqui.

/** Tamanho mínimo de uma password nova. Não há regras de composição. */
export const PASSWORD_MIN_LENGTH = 8;

/** O bcrypt só lê os primeiros 72 bytes: o resto de uma password maior seria ignorado. */
export const PASSWORD_MAX_BYTES = 72;

/** Custo do bcrypt quando PASSWORD_HASH_ROUNDS não está definido. */
export const DEFAULT_PASSWORD_HASH_ROUNDS = 12;

/** Falhas de login no mesmo número, dentro da janela, que o bloqueiam. */
export const LOGIN_MAX_FAILED_ATTEMPTS = 5;

/** Minutos durante os quais as falhas de login se somam. */
export const LOGIN_FAILURE_WINDOW_MINUTES = 15;

/** Minutos que o número fica bloqueado depois de atingir o limite de falhas. */
export const LOGIN_LOCK_MINUTES = 15;

/** Minutos de validade de um código de verificação. */
export const VERIFICATION_CODE_TTL_MINUTES = 15;

/** Segundos de espera entre dois envios de código à mesma conta, para o mesmo fim. */
export const VERIFICATION_CODE_RESEND_SECONDS = 60;

/** Minutos da janela em que se contam os envios e os códigos errados de uma conta. */
export const VERIFICATION_CODE_WINDOW_MINUTES = 60;

/** Envios de código por conta e por fim, dentro da janela. */
export const VERIFICATION_CODE_MAX_SENDS = 5;

/** Códigos errados por conta e por fim, dentro da janela, antes de recusar mais. */
export const VERIFICATION_CODE_MAX_WRONG_ATTEMPTS = 5;
