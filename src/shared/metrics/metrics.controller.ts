import {
  Controller,
  Get,
  Headers,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { timingSafeEqual } from 'crypto';
import type { Response } from 'express';

import { MetricsService } from './metrics.service';

/**
 * Métricas em formato Prometheus, na raiz (fora de /api/v1), para o scraper.
 *
 * Mostram o mapa de rotas, os números do negócio e quanto dinheiro está no
 * escrow. Com METRICS_TOKEN definido só respondem a quem o envia como
 * Bearer, e em produção a aplicação não arranca sem ele.
 */
@ApiTags('Metrics')
@SkipThrottle()
@Controller()
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly config: ConfigService,
  ) {}

  @Get('metrics')
  @ApiOperation({
    summary: 'Métricas Prometheus (text exposition)',
    description:
      'Output em formato Prometheus 0.0.4. Inclui métricas padrão do Node (heap, GC, event loop), counters de HTTP e counters de eventos de negócio.',
  })
  @ApiResponse({ status: 200, description: 'Métricas exportadas.' })
  @ApiResponse({ status: 401, description: 'Token em falta ou inválido.' })
  async metricsEndpoint(
    @Headers('authorization') authorization: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    this.assertMayScrape(authorization);

    const body = await this.metrics.exportMetrics();
    res
      .header('Content-Type', this.metrics.contentType())
      .status(200)
      .send(body);
  }

  /** Sem METRICS_TOKEN (desenvolvimento e testes), as métricas ficam abertas. */
  private assertMayScrape(authorization: string | undefined): void {
    const token = this.config.get<string>('METRICS_TOKEN');
    if (!token) {
      return;
    }

    const sent = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : '';
    const expected = Buffer.from(token);
    const received = Buffer.from(sent);

    // Comparação em tempo constante, para o tempo de resposta não revelar
    // quantos caracteres do token estavam certos.
    if (
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    ) {
      throw new UnauthorizedException(
        'Token de métricas em falta ou inválido.',
      );
    }
  }
}
