import { Controller, Get, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';

import { MetricsService } from './metrics.service';

/**
 * Endpoint público (no path raiz, fora de /api/v1, sem auth) que serve
 * métricas em formato Prometheus. Para scrape pelo Prometheus / Grafana
 * Cloud / VictoriaMetrics / etc.
 *
 * Em produção considera proteger com IP allowlist no reverse proxy se
 * não quiseres expor os internos publicamente.
 */
@ApiTags('Metrics')
@SkipThrottle()
@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('metrics')
  @ApiOperation({
    summary: 'Métricas Prometheus (text exposition)',
    description:
      'Output em formato Prometheus 0.0.4. Inclui métricas padrão do Node (heap, GC, event loop), counters de HTTP e counters de eventos de negócio.',
  })
  @ApiResponse({ status: 200, description: 'Métricas exportadas.' })
  async metricsEndpoint(@Res() res: Response): Promise<void> {
    const body = await this.metrics.exportMetrics();
    res
      .header('Content-Type', this.metrics.contentType())
      .status(200)
      .send(body);
  }
}
