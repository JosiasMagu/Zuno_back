import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { MetricsService } from './metrics.service';

/** Etiqueta dos pedidos que não chegam a nenhuma rota (404 do router). */
export const UNMATCHED_ROUTE = 'unmatched';

/**
 * A etiqueta de rota é sempre o padrão (`/api/v1/equipment/:id`) e nunca o
 * URL pedido. Com o URL, cada id e cada endereço inventado por um scanner
 * criava uma série nova, sem tecto.
 */
function routeOf(request: Request): string {
  const path = (request as { route?: { path?: unknown } }).route?.path;

  // Quando nenhum controller responde, o Express deixa no pedido o padrão
  // deste próprio middleware, que apanha tudo. Não é uma rota da API.
  if (typeof path !== 'string' || path.includes('*')) {
    return UNMATCHED_ROUTE;
  }

  return path;
}

/**
 * Conta e cronometra cada pedido HTTP quando a resposta acaba de sair.
 *
 * É nesse momento que o estado é o que o cliente recebeu. Um interceptor lê
 * o estado antes de o filtro de erros o mudar (um 404 contava como 200) e
 * nem chega a correr quando um guard recusa o pedido, por isso os 401, 403 e
 * 429 ficavam de fora.
 */
@Injectable()
export class MetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: MetricsService) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const start = process.hrtime.bigint();

    response.once('finish', () => {
      const labels = {
        method: request.method,
        route: routeOf(request),
        status: String(response.statusCode),
      };

      this.metrics.httpRequestsTotal.inc(labels);
      this.metrics.httpRequestDurationSeconds.observe(
        labels,
        Number(process.hrtime.bigint() - start) / 1e9,
      );
    });

    next();
  }
}
