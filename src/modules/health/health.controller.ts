import {
  Controller,
  Get,
  HttpCode,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

import { PrismaService } from '../../shared/db/prisma.service';

@ApiTags('Health')
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Verifica o estado do servico e da base de dados',
  })
  @ApiResponse({ status: 200, description: 'Servico operacional.' })
  @ApiResponse({
    status: 503,
    description: 'Servico ou base de dados indisponivel.',
  })
  async check() {
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
