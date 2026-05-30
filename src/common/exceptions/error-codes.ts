/**
 * Códigos de erro estáveis da API Zuno.
 *
 * Cada resposta de erro inclui um `errorCode` que o frontend pode usar
 * para tratamento programático (em vez de comparar strings da mensagem,
 * que mudam com a língua e a redacção).
 *
 * Convenções:
 *  - SCREAMING_SNAKE_CASE
 *  - Prefixo do domínio (AUTH_, EQUIPMENT_, BOOKING_, etc.)
 *  - Os códigos genéricos (BAD_REQUEST, NOT_FOUND, ...) são usados como
 *    fallback quando nenhuma `ApiException` específica é lançada.
 */
export enum ErrorCode {
  // ─── Genéricos (mapeados a partir do HTTP status) ─────────────────────────
  BAD_REQUEST = 'BAD_REQUEST',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  TOO_MANY_REQUESTS = 'TOO_MANY_REQUESTS',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',

  // ─── Auth ─────────────────────────────────────────────────────────────────
  AUTH_INVALID_CREDENTIALS = 'AUTH_INVALID_CREDENTIALS',
  AUTH_TOKEN_EXPIRED = 'AUTH_TOKEN_EXPIRED',
  AUTH_TOKEN_INVALID = 'AUTH_TOKEN_INVALID',
  AUTH_USER_NOT_FOUND = 'AUTH_USER_NOT_FOUND',
  AUTH_PHONE_ALREADY_REGISTERED = 'AUTH_PHONE_ALREADY_REGISTERED',
  AUTH_EMAIL_ALREADY_REGISTERED = 'AUTH_EMAIL_ALREADY_REGISTERED',

  // ─── Equipment ────────────────────────────────────────────────────────────
  EQUIPMENT_NOT_FOUND = 'EQUIPMENT_NOT_FOUND',
  EQUIPMENT_NOT_AVAILABLE = 'EQUIPMENT_NOT_AVAILABLE',
  EQUIPMENT_NOT_ACTIVE = 'EQUIPMENT_NOT_ACTIVE',
  EQUIPMENT_ALREADY_APPROVED = 'EQUIPMENT_ALREADY_APPROVED',
  EQUIPMENT_ALREADY_REJECTED = 'EQUIPMENT_ALREADY_REJECTED',
  EQUIPMENT_DELETED = 'EQUIPMENT_DELETED',

  // ─── Booking ──────────────────────────────────────────────────────────────
  BOOKING_NOT_FOUND = 'BOOKING_NOT_FOUND',
  BOOKING_OVERLAP = 'BOOKING_OVERLAP',
  BOOKING_INVALID_STATUS_TRANSITION = 'BOOKING_INVALID_STATUS_TRANSITION',
  BOOKING_INVALID_DATES = 'BOOKING_INVALID_DATES',
  BOOKING_SELF_RESERVE = 'BOOKING_SELF_RESERVE',

  // ─── Payment / Escrow ─────────────────────────────────────────────────────
  PAYMENT_NOT_FOUND = 'PAYMENT_NOT_FOUND',
  PAYMENT_INVALID_STATE = 'PAYMENT_INVALID_STATE',
  PAYMENT_RELEASE_FORBIDDEN = 'PAYMENT_RELEASE_FORBIDDEN',

  // ─── Category ─────────────────────────────────────────────────────────────
  CATEGORY_NOT_FOUND = 'CATEGORY_NOT_FOUND',
  CATEGORY_INACTIVE = 'CATEGORY_INACTIVE',

  // ─── Service / ServiceBooking ─────────────────────────────────────────────
  SERVICE_NOT_FOUND = 'SERVICE_NOT_FOUND',
  SERVICE_QUOTE_EXPIRED = 'SERVICE_QUOTE_EXPIRED',
  SERVICE_REQUEST_NOT_OPEN = 'SERVICE_REQUEST_NOT_OPEN',

  // ─── Idempotency ──────────────────────────────────────────────────────────
  IDEMPOTENCY_KEY_REUSED = 'IDEMPOTENCY_KEY_REUSED',
  IDEMPOTENCY_KEY_MISMATCH = 'IDEMPOTENCY_KEY_MISMATCH',

  // ─── Outros ───────────────────────────────────────────────────────────────
  CORS_NOT_ALLOWED = 'CORS_NOT_ALLOWED',
}

/**
 * Mapeia um HTTP status para um `ErrorCode` genérico, usado como fallback
 * quando o exception não traz código próprio.
 */
export function inferErrorCode(status: number): ErrorCode {
  switch (status) {
    case 400:
      return ErrorCode.BAD_REQUEST;
    case 401:
      return ErrorCode.UNAUTHORIZED;
    case 403:
      return ErrorCode.FORBIDDEN;
    case 404:
      return ErrorCode.NOT_FOUND;
    case 409:
      return ErrorCode.CONFLICT;
    case 422:
      return ErrorCode.VALIDATION_ERROR;
    case 429:
      return ErrorCode.TOO_MANY_REQUESTS;
    case 503:
      return ErrorCode.SERVICE_UNAVAILABLE;
    default:
      return ErrorCode.INTERNAL_ERROR;
  }
}
