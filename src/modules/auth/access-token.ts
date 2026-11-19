export const ACCESS_TOKEN_TYPE = 'access';

/** O que vai dentro do access token (JWT): quem é e a que sessão pertence. */
export interface AccessTokenPayload {
  sub: string;
  sid: string;
  typ: typeof ACCESS_TOKEN_TYPE;
}
