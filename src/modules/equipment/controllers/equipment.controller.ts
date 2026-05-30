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
import { CreateEquipmentDto } from '../dto/create-equipment.dto';
import {
  EquipmentSortBy,
  FindEquipmentQueryDto,
} from '../dto/find-equipment-query.dto';
import { FindMyListingsQueryDto } from '../dto/find-my-listings-query.dto';
import { UpdateEquipmentDto } from '../dto/update-equipment.dto';
import { RejectEquipmentDto } from '../dto/reject-equipment.dto';
import { EquipmentService } from '../services/equipment.service';

@ApiTags('Equipment')
@Controller('equipment')
export class EquipmentController {
  constructor(private readonly equipmentService: EquipmentService) {}

  // Criar equipamento — qualquer utilizador autenticado

  @UseGuards(JwtAuthGuard)
  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Criar equipamento',
    description:
      'Cria um novo equipamento. Fica em PENDING_REVIEW até o ADMIN aprovar. ' +
      'CLIENT é promovido automaticamente a PROVIDER.',
  })
  @ApiBody({ type: CreateEquipmentDto })
  @ApiResponse({ status: 201, description: 'Equipamento criado com sucesso.' })
  @ApiResponse({ status: 400, description: 'Dados inválidos.' })
  @ApiResponse({ status: 401, description: 'Não autenticado.' })
  create(@CurrentUser() user: { id: string }, @Body() dto: CreateEquipmentDto) {
    return this.equipmentService.create(user.id, dto);
  }

  // Listar equipamentos activos (público)

  @Get()
  @ApiOperation({
    summary: 'Listar equipamentos com filtros',
    description: 'Devolve apenas equipamentos com status ACTIVE. Público.',
  })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 10 })
  @ApiQuery({ name: 'search', required: false, example: 'gerador' })
  @ApiQuery({ name: 'categoryId', required: false })
  @ApiQuery({ name: 'categorySlug', required: false, example: 'geradores' })
  @ApiQuery({ name: 'location', required: false, example: 'Maputo' })
  @ApiQuery({ name: 'minPrice', required: false, example: 1000 })
  @ApiQuery({ name: 'maxPrice', required: false, example: 5000 })
  @ApiQuery({ name: 'deliveryAvailable', required: false, example: true })
  @ApiQuery({ name: 'operatorAvailable', required: false, example: false })
  @ApiQuery({ name: 'onlyAvailableNow', required: false, example: true })
  @ApiQuery({ name: 'condition', required: false, example: 'GOOD' })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: EquipmentSortBy,
    example: EquipmentSortBy.NEWEST,
  })
  @ApiResponse({ status: 200, description: 'Equipamentos obtidos com sucesso.' })
  findAll(@Query() query: FindEquipmentQueryDto) {
    return this.equipmentService.findAll(query);
  }

  // Listings do utilizador autenticado — qualquer autenticado

  @Get('me/listings')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Listar os meus equipamentos',
    description:
      'PROVIDER vê os seus, ADMIN vê todos. Paginado: defaults page=1, limit=50 (máx 100).',
  })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiResponse({ status: 200, description: 'Equipamentos obtidos com sucesso.' })
  @ApiResponse({ status: 401, description: 'Não autenticado.' })
  findMyListings(
    @CurrentUser() user: { id: string },
    @Query() query: FindMyListingsQueryDto,
  ) {
    return this.equipmentService.findMyListings(user.id, query);
  }

  // Equipamentos pendentes de revisão (ADMIN)

  @Get('admin/pending')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: '[ADMIN] Listar equipamentos pendentes de aprovação',
  })
  @ApiResponse({ status: 200, description: 'Equipamentos pendentes obtidos com sucesso.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  findPending(@CurrentUser() user: { id: string }) {
    return this.equipmentService.findPending(user.id);
  }

  // Detalhe público (só ACTIVE)

  @Get(':id')
  @ApiOperation({ summary: 'Obter equipamento por ID' })
  @ApiParam({ name: 'id', description: 'ID do equipamento' })
  @ApiResponse({ status: 200, description: 'Equipamento obtido com sucesso.' })
  @ApiResponse({ status: 404, description: 'Equipamento não encontrado.' })
  findOne(@Param('id') id: string) {
    return this.equipmentService.findOne(id);
  }

  // Aprovar equipamento (ADMIN)

  @Patch(':id/approve')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: '[ADMIN] Aprovar equipamento' })
  @ApiParam({ name: 'id', description: 'ID do equipamento' })
  @ApiResponse({ status: 200, description: 'Equipamento aprovado com sucesso.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Equipamento não encontrado.' })
  approve(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.equipmentService.approve(user.id, id);
  }

  // Rejeitar equipamento (ADMIN)

  @Patch(':id/reject')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: '[ADMIN] Rejeitar equipamento' })
  @ApiParam({ name: 'id', description: 'ID do equipamento' })
  @ApiBody({ type: RejectEquipmentDto })
  @ApiResponse({ status: 200, description: 'Equipamento rejeitado.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Equipamento não encontrado.' })
  reject(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body() dto: RejectEquipmentDto,
  ) {
    return this.equipmentService.reject(user.id, id, dto.reason);
  }

  // Alternar disponibilidade — qualquer autenticado, service valida ownership

  @Patch(':id/toggle-availability')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Alternar disponibilidade do equipamento' })
  @ApiParam({ name: 'id', description: 'ID do equipamento' })
  @ApiResponse({ status: 200, description: 'Disponibilidade alterada com sucesso.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Equipamento não encontrado.' })
  toggleAvailability(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
  ) {
    return this.equipmentService.toggleAvailability(user.id, id);
  }

  // Actualizar equipamento — qualquer autenticado, service valida ownership

  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Actualizar equipamento' })
  @ApiParam({ name: 'id', description: 'ID do equipamento' })
  @ApiBody({ type: UpdateEquipmentDto })
  @ApiResponse({ status: 200, description: 'Equipamento atualizado com sucesso.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Equipamento não encontrado.' })
  update(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body() dto: UpdateEquipmentDto,
  ) {
    return this.equipmentService.update(user.id, id, dto);
  }

  // Soft delete — qualquer autenticado, service valida ownership

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Remover equipamento (soft delete)' })
  @ApiParam({ name: 'id', description: 'ID do equipamento' })
  @ApiResponse({ status: 200, description: 'Equipamento removido com sucesso.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Equipamento não encontrado.' })
  remove(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.equipmentService.remove(user.id, id);
  }
}