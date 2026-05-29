import {
  Body, Controller, Get, Param, Patch, Post, Query, UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags,
} from '@nestjs/swagger';

import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CreateServiceRequestDto } from '../dto/create-service-request.dto';
import { FindServiceRequestsQueryDto } from '../dto/find-service-requests-query.dto';
import { ServiceRequestsService } from '../services/service-requests.service';

@ApiTags('Service Requests')
@Controller('service-requests')
@UseGuards(JwtAuthGuard)
export class ServiceRequestsController {
  constructor(private readonly requestsService: ServiceRequestsService) {}

  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Criar pedido de serviço' })
  @ApiBody({ type: CreateServiceRequestDto })
  @ApiResponse({ status: 201, description: 'Pedido criado com sucesso.' })
  @ApiResponse({ status: 404, description: 'Serviço não encontrado.' })
  create(@CurrentUser() user: { id: string }, @Body() dto: CreateServiceRequestDto) {
    return this.requestsService.create(user.id, dto);
  }

  @Get('me')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Listar os meus pedidos (cliente)' })
  @ApiResponse({ status: 200, description: 'Pedidos obtidos com sucesso.' })
  findMine(@CurrentUser() user: { id: string }, @Query() query: FindServiceRequestsQueryDto) {
    return this.requestsService.findMine(user.id, query);
  }

  @Get('for-provider')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Pedidos recebidos nos meus serviços (provider)' })
  @ApiResponse({ status: 200, description: 'Pedidos obtidos com sucesso.' })
  findForProvider(@CurrentUser() user: { id: string }, @Query() query: FindServiceRequestsQueryDto) {
    return this.requestsService.findForProvider(user.id, query);
  }

  @Get(':id')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Obter pedido por ID' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Pedido obtido com sucesso.' })
  @ApiResponse({ status: 404, description: 'Pedido não encontrado.' })
  findOne(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.requestsService.findOne(user.id, id);
  }

  @Patch(':id/cancel')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Cancelar pedido' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Pedido cancelado com sucesso.' })
  cancel(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.requestsService.cancel(user.id, id);
  }
}