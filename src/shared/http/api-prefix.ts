import { INestApplication, RequestMethod } from '@nestjs/common';

export const API_PREFIX = 'api/v1';

/**
 * Põe a API debaixo de `/api/v1`. O health, o readiness e as métricas ficam
 * na raiz, por convenção dos orquestradores e dos scrapers.
 *
 * O `main.ts` e os testes E2E usam esta função, para os testes exercitarem
 * as mesmas rotas que a aplicação serve.
 */
export function applyApiPrefix(app: INestApplication): void {
  app.setGlobalPrefix(API_PREFIX, {
    exclude: [
      { path: 'health', method: RequestMethod.GET },
      { path: 'ready', method: RequestMethod.GET },
      { path: 'metrics', method: RequestMethod.GET },
    ],
  });
}
