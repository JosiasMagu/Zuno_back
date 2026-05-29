import {
  Body, Controller, Get, Param, Patch, Post, UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags,
} from '@nestjs/swagger';

import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CreateServiceQuoteDto } from '../dto/create-service-quote.dto';
import { ServiceQuotesService } from '../services/service-quotes.service';

@ApiTags('Service Quotes')
@Controller()
@UseGuards(JwtAuthGuard)
export class ServiceQuotesController {
  constructor(private readonly quotesService: ServiceQuotesService) {}

  @Post('service-requests/:id/quotes')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Enviar orçamento para um pedido' })
  @ApiParam({ name: 'id', description: 'ID do pedido' })
  @ApiBody({ type: CreateServiceQuoteDto })
  @ApiResponse({ status: 201, description: 'Orçamento enviado com sucesso.' })
  createQuote(
    @CurrentUser() user: { id: string },
    @Param('id') requestId: string,
    @Body() dto: CreateServiceQuoteDto,
  ) {
    return this.quotesService.create(user.id, requestId, dto);
  }

  @Get('service-quotes/received')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Orçamentos recebidos (cliente)' })
  @ApiResponse({ status: 200, description: 'Orçamentos obtidos com sucesso.' })
  findReceived(@CurrentUser() user: { id: string }) {
    return this.quotesService.findReceived(user.id);
  }

  @Get('service-quotes/sent')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Orçamentos enviados (provider)' })
  @ApiResponse({ status: 200, description: 'Orçamentos obtidos com sucesso.' })
  findSent(@CurrentUser() user: { id: string }) {
    return this.quotesService.findSent(user.id);
  }

  @Patch('service-quotes/:id/accept')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Aceitar orçamento (cliente)' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Orçamento aceite com sucesso.' })
  accept(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.quotesService.accept(user.id, id);
  }

  @Patch('service-quotes/:id/reject')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Rejeitar orçamento (cliente)' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Orçamento rejeitado.' })
  reject(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.quotesService.reject(user.id, id);
  }

  @Patch('service-quotes/:id/withdraw')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Retirar orçamento (provider)' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Orçamento retirado.' })
  withdraw(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.quotesService.withdraw(user.id, id);
  }
}