import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { CreateServiceDto } from '../dto/create-service.dto';
import {
  FindServicesQueryDto,
  ServiceSortBy,
} from '../dto/find-services-query.dto';
import { RejectServiceDto } from '../dto/reject-service.dto';
import { UpdateServiceDto } from '../dto/update-service.dto';
import { ServicesService } from '../services/services.service';

@ApiTags('Services')
@Controller('services')
export class ServicesController {
  constructor(private readonly servicesService: ServicesService) {}

  // Criar serviço — qualquer utilizador autenticado

  @UseGuards(JwtAuthGuard)
  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Criar serviço',
    description: 'Cria um serviço. Fica em PENDING_REVIEW até o ADMIN aprovar.',
  })
  @ApiBody({ type: CreateServiceDto })
  @ApiResponse({ status: 201, description: 'Serviço criado com sucesso.' })
  @ApiResponse({ status: 400, description: 'Dados inválidos.' })
  @ApiResponse({ status: 401, description: 'Não autenticado.' })
  create(@CurrentUser() user: { id: string }, @Body() dto: CreateServiceDto) {
    return this.servicesService.create(user.id, dto);
  }

  // Listar serviços activos (público)

  @Get()
  @ApiOperation({
    summary: 'Listar serviços com filtros',
    description: 'Devolve apenas serviços com status ACTIVE. Público.',
  })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 10 })
  @ApiQuery({ name: 'search', required: false, example: 'electricista' })
  @ApiQuery({ name: 'categoryId', required: false })
  @ApiQuery({ name: 'categorySlug', required: false, example: 'electricidade' })
  @ApiQuery({ name: 'location', required: false, example: 'Maputo' })
  @ApiQuery({ name: 'minPrice', required: false, example: 500 })
  @ApiQuery({ name: 'maxPrice', required: false, example: 10000 })
  @ApiQuery({ name: 'isUrgent', required: false, example: true })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: ServiceSortBy,
    example: ServiceSortBy.NEWEST,
  })
  @ApiResponse({ status: 200, description: 'Serviços obtidos com sucesso.' })
  findAll(@Query() query: FindServicesQueryDto) {
    return this.servicesService.findAll(query);
  }

  // Listings do utilizador autenticado — qualquer autenticado

  @Get('me/listings')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Listar os meus serviços',
    description: 'PROVIDER vê os seus serviços em todos os estados. ADMIN vê todos.',
  })
  @ApiResponse({ status: 200, description: 'Serviços obtidos com sucesso.' })
  @ApiResponse({ status: 401, description: 'Não autenticado.' })
  findMyListings(@CurrentUser() user: { id: string }) {
    return this.servicesService.findMyListings(user.id);
  }

  // Serviços pendentes de revisão (ADMIN)

  @Get('admin/pending')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: '[ADMIN] Listar serviços pendentes de aprovação',
  })
  @ApiResponse({ status: 200, description: 'Serviços pendentes obtidos com sucesso.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  findPending(@CurrentUser() user: { id: string }) {
    return this.servicesService.findPending(user.id);
  }

  // Detalhe público (só ACTIVE)

  @Get(':id')
  @ApiOperation({
    summary: 'Obter serviço por ID',
    description: 'Detalhe completo. Apenas serviços ACTIVE.',
  })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Serviço obtido com sucesso.' })
  @ApiResponse({ status: 404, description: 'Serviço não encontrado.' })
  findOne(@Param('id') id: string) {
    return this.servicesService.findOne(id);
  }

  // Aprovar serviço (ADMIN)

  @Patch(':id/approve')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: '[ADMIN] Aprovar serviço' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Serviço aprovado com sucesso.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Serviço não encontrado.' })
  approve(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.servicesService.approve(user.id, id);
  }

  // Rejeitar serviço (ADMIN)

  @Patch(':id/reject')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: '[ADMIN] Rejeitar serviço' })
  @ApiParam({ name: 'id' })
  @ApiBody({ type: RejectServiceDto })
  @ApiResponse({ status: 200, description: 'Serviço rejeitado.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Serviço não encontrado.' })
  reject(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body() dto: RejectServiceDto,
  ) {
    return this.servicesService.reject(user.id, id, dto.reason);
  }

  // Alternar disponibilidade — qualquer autenticado, service valida ownership

  @Patch(':id/toggle-availability')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Alternar disponibilidade do serviço' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Disponibilidade alterada com sucesso.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Serviço não encontrado.' })
  toggleAvailability(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
  ) {
    return this.servicesService.toggleAvailability(user.id, id);
  }

  // Actualizar serviço — qualquer autenticado, service valida ownership

  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Actualizar serviço' })
  @ApiParam({ name: 'id' })
  @ApiBody({ type: UpdateServiceDto })
  @ApiResponse({ status: 200, description: 'Serviço atualizado com sucesso.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Serviço não encontrado.' })
  update(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body() dto: UpdateServiceDto,
  ) {
    return this.servicesService.update(user.id, id, dto);
  }

  // Soft delete — qualquer autenticado, service valida ownership

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Remover serviço (soft delete)' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Serviço removido com sucesso.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Serviço não encontrado.' })
  remove(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.servicesService.remove(user.id, id);
  }
}