import {
  CallHandler,
  ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';

import { MetricsService } from './metrics.service';

/**
 * Interceptor global que mede a duração de cada request HTTP e incrementa
 * o counter total. A label `route` usa o template do Express (ex.: `/api/v1/equipment/:id`)
 * para evitar explosão de cardinalidade com IDs únicos.
 */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const start = process.hrtime.bigint();
    const request = ctx.switchToHttp().getRequest<Request>();
    const response = ctx.switchToHttp().getResponse<Response>();

    const finalize = () => {
      const elapsedNs = Number(process.hrtime.bigint() - start);
      const elapsedSec = elapsedNs / 1e9;
      const method = request.method;
      const route =
        (request as any).route?.path ??
        // Fallback: usa a URL sem query string para evitar cardinalidade
        request.url.split('?')[0];
      const status = String(response.statusCode);

      this.metrics.httpRequestsTotal.inc({ method, route, status });
      this.metrics.httpRequestDurationSeconds.observe(
        { method, route, status },
        elapsedSec,
      );
    };

    return next.handle().pipe(
      tap({
        next: () => finalize(),
        error: () => finalize(),
      }),
    );
  }
}
