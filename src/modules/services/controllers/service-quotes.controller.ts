import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { CreateServiceQuoteDto } from '../dto/create-service-quote.dto';
import { ServiceQuotesService } from '../services/service-quotes.service';

@ApiTags('Service Quotes')
@Controller()
@UseGuards(JwtAuthGuard)
export class ServiceQuotesController {
  constructor(private readonly quotesService: ServiceQuotesService) {}

  @Post('service-requests/:id/quotes')
  @UseGuards(RolesGuard)
  @Roles(UserRole.PROVIDER)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Enviar orçamento para um pedido',
    description:
      'Provider envia o orçamento. Só pode fazê-lo se for o provider do serviço associado.',
  })
  @ApiParam({ name: 'id', description: 'ID do pedido' })
  @ApiBody({ type: CreateServiceQuoteDto })
  @ApiResponse({ status: 201, description: 'Orçamento enviado com sucesso.' })
  @ApiResponse({ status: 400, description: 'Dados inválidos.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Pedido não encontrado.' })
  createQuote(
    @CurrentUser() user: { id: string },
    @Param('id') requestId: string,
    @Body() dto: CreateServiceQuoteDto,
  ) {
    return this.quotesService.create(user.id, requestId, dto);
  }

  @Get('service-quotes/received')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Orçamentos recebidos (cliente)',
    description: 'Orçamentos para os pedidos do cliente autenticado.',
  })
  @ApiResponse({ status: 200, description: 'Orçamentos obtidos com sucesso.' })
  findReceived(@CurrentUser() user: { id: string }) {
    return this.quotesService.findReceived(user.id);
  }

  @Get('service-quotes/sent')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Orçamentos enviados (provider)',
    description: 'Orçamentos enviados pelo provider autenticado.',
  })
  @ApiResponse({ status: 200, description: 'Orçamentos obtidos com sucesso.' })
  findSent(@CurrentUser() user: { id: string }) {
    return this.quotesService.findSent(user.id);
  }

  @Patch('service-quotes/:id/accept')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Aceitar orçamento (cliente)',
    description:
      'Aceita atomicamente o orçamento, rejeita os restantes, marca o pedido como ACCEPTED, cria ServiceBooking e Payment(PENDING).',
  })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Orçamento aceite com sucesso.' })
  @ApiResponse({ status: 400, description: 'Operação inválida.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Orçamento não encontrado.' })
  accept(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.quotesService.accept(user.id, id);
  }

  @Patch('service-quotes/:id/reject')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Rejeitar orçamento (cliente)' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Orçamento rejeitado.' })
  @ApiResponse({ status: 400, description: 'Operação inválida.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Orçamento não encontrado.' })
  reject(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.quotesService.reject(user.id, id);
  }

  @Patch('service-quotes/:id/withdraw')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Retirar orçamento (provider)' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Orçamento retirado.' })
  @ApiResponse({ status: 400, description: 'Operação inválida.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Orçamento não encontrado.' })
  withdraw(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.quotesService.withdraw(user.id, id);
  }
}
