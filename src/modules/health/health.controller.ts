import {
  Controller,
  Get,
  HttpCode,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

import { PrismaService } from '../../shared/db/prisma.service';

/**
 * Endpoints de observabilidade do processo. Por convenção:
 *
 *  - `/health` (liveness): o processo Node está vivo? Não toca em dependências
 *    externas. Falhar aqui significa "reinicia o container".
 *  - `/ready` (readiness): podemos servir tráfego? Verifica conexões críticas
 *    (BD, etc.). Falhar aqui significa "tira-me do load balancer até estar OK".
 *
 * Estes endpoints ficam fora do prefixo `/api/v1` (excluídos no `main.ts`)
 * para casarem com as convenções de Kubernetes / Railway / Render / Fly.
 */
@ApiTags('Health')
@SkipThrottle()
@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Liveness ──────────────────────────────────────────────────────────────
  @Get('health')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Liveness probe — verifica apenas se o processo está vivo',
  })
  @ApiResponse({ status: 200, description: 'Processo operacional.' })
  liveness() {
    return {
      status: 'ok',
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }

  // ─── Readiness ─────────────────────────────────────────────────────────────
  @Get('ready')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Readiness probe — verifica se o serviço consegue servir tráfego',
  })
  @ApiResponse({ status: 200, description: 'Serviço pronto.' })
  @ApiResponse({
    status: 503,
    description: 'Dependência crítica indisponível (ex.: base de dados).',
  })
  async readiness() {
    const startedAt = Date.now();

    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException({
        status: 'error',
        database: 'down',
      });
    }

    return {
      status: 'ok',
      database: 'ok',
      uptimeSeconds: Math.floor(process.uptime()),
      latencyMs: Date.now() - startedAt,
    };
  }
}
