import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { ProviderEventsService } from '../services/provider-events.service';

export const WEBHOOK_TOKEN_HEADER = 'x-zuno-webhook-token';

/**
 * Onde o fornecedor de pagamentos avisa do resultado de uma cobrança ou de um
 * envio. Não usa JWT: o fornecedor autentica-se com o segredo partilhado
 * PAYMENTS_WEBHOOK_SECRET. O aviso fica guardado antes de ser tratado e a
 * resposta é 200 mesmo para um aviso repetido, para o fornecedor não insistir.
 */
@ApiTags('Payments')
@Controller('payments/providers')
export class ProviderEventsController {
  constructor(private readonly events: ProviderEventsService) {}

  @Post(':provider/events')
  @HttpCode(200)
  @Throttle({ global: { ttl: 60_000, limit: 600 } })
  @ApiOperation({
    summary: 'Aviso do fornecedor de pagamentos (webhook)',
    description:
      'Só aceita avisos do fornecedor ligado em PAYMENTS_PROVIDER, com o segredo partilhado no cabeçalho. O formato do corpo é o do fornecedor; o adaptador traduz.',
  })
  @ApiParam({ name: 'provider', example: 'mpesa' })
  @ApiHeader({
    name: WEBHOOK_TOKEN_HEADER,
    required: true,
    description: 'O valor de PAYMENTS_WEBHOOK_SECRET.',
  })
  @ApiResponse({ status: 200, description: 'Aviso recebido.' })
  @ApiResponse({ status: 400, description: 'Aviso num formato que não se lê.' })
  @ApiResponse({ status: 401, description: 'Segredo em falta ou errado.' })
  @ApiResponse({ status: 404, description: 'Fornecedor não ligado.' })
  receive(
    @Param('provider') provider: string,
    @Headers(WEBHOOK_TOKEN_HEADER) token: string | undefined,
    @Body() payload: unknown,
  ) {
    return this.events.receive(provider, token, payload);
  }
}
