type OriginCallback = (error: Error | null, allow?: boolean) => void;

/**
 * Quem pode chamar a API a partir de um browser.
 *
 * Um pedido sem Origin (app nativa, curl) passa sempre. Uma origem fora da
 * lista fica sem os cabeçalhos CORS e é o browser que a bloqueia: responder
 * com um erro dava 500 e enchia os logs e o Sentry com um pedido que qualquer
 * página consegue fazer.
 */
export function corsOrigin(allowedOrigins: string[]) {
  return (origin: string | undefined, callback: OriginCallback) =>
    callback(null, !origin || allowedOrigins.includes(origin));
}
