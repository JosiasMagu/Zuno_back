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
import { UpdateEquipmentDto } from '../dto/update-equipment.dto';
import { RejectEquipmentDto } from '../dto/reject-equipment.dto';
import { EquipmentService } from '../services/equipment.service';

@ApiTags('Equipment')
@Controller('equipment')
export class EquipmentController {
  constructor(private readonly equipmentService: EquipmentService) {}

  // ─── Criar equipamento (OWNER / ADMIN) ────────────────────────────────────

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Criar equipamento',
    description: 'Cria um novo equipamento. Fica em PENDING_REVIEW até o ADMIN aprovar.',
  })
  @ApiBody({ type: CreateEquipmentDto })
  @ApiResponse({ status: 201, description: 'Equipamento criado com sucesso.' })
  @ApiResponse({ status: 400, description: 'Dados inválidos.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  create(
    @CurrentUser() user: { id: string },
    @Body() dto: CreateEquipmentDto,
  ) {
    return this.equipmentService.create(user.id, dto);
  }

  // ─── Listar equipamentos activos (público) ────────────────────────────────

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

  // ─── Listings do utilizador autenticado (OWNER / ADMIN) ──────────────────

  @Get('me/listings')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Listar os meus equipamentos',
    description: 'OWNER vê os seus equipamentos em todos os estados. ADMIN vê todos.',
  })
  @ApiResponse({ status: 200, description: 'Equipamentos obtidos com sucesso.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  findMyListings(@CurrentUser() user: { id: string }) {
    return this.equipmentService.findMyListings(user.id);
  }

  // ─── Equipamentos pendentes de revisão (ADMIN) ────────────────────────────

  @Get('admin/pending')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: '[ADMIN] Listar equipamentos pendentes de aprovação',
    description: 'Devolve todos os equipamentos em PENDING_REVIEW, por ordem de criação (FIFO).',
  })
  @ApiResponse({ status: 200, description: 'Equipamentos pendentes obtidos com sucesso.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  findPending(@CurrentUser() user: { id: string }) {
    return this.equipmentService.findPending(user.id);
  }

  // ─── Detalhe público (só ACTIVE) ─────────────────────────────────────────

  @Get(':id')
  @ApiOperation({
    summary: 'Obter equipamento por ID',
    description: 'Devolve detalhe completo. Apenas equipamentos ACTIVE.',
  })
  @ApiParam({ name: 'id', description: 'ID do equipamento' })
  @ApiResponse({ status: 200, description: 'Equipamento obtido com sucesso.' })
  @ApiResponse({ status: 404, description: 'Equipamento não encontrado.' })
  findOne(@Param('id') id: string) {
    return this.equipmentService.findOne(id);
  }

  // ─── Aprovar equipamento (ADMIN) ──────────────────────────────────────────

  @Patch(':id/approve')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: '[ADMIN] Aprovar equipamento',
    description: 'Muda o status para ACTIVE e torna o equipamento visível no catálogo.',
  })
  @ApiParam({ name: 'id', description: 'ID do equipamento' })
  @ApiResponse({ status: 200, description: 'Equipamento aprovado com sucesso.' })
  @ApiResponse({ status: 400, description: 'Operação inválida.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Equipamento não encontrado.' })
  approve(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.equipmentService.approve(user.id, id);
  }

  // ─── Rejeitar equipamento (ADMIN) ─────────────────────────────────────────

  @Patch(':id/reject')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: '[ADMIN] Rejeitar equipamento',
    description: 'Muda o status para REJECTED com motivo opcional.',
  })
  @ApiParam({ name: 'id', description: 'ID do equipamento' })
  @ApiBody({ type: RejectEquipmentDto })
  @ApiResponse({ status: 200, description: 'Equipamento rejeitado.' })
  @ApiResponse({ status: 400, description: 'Operação inválida.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Equipamento não encontrado.' })
  reject(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body() dto: RejectEquipmentDto,
  ) {
    return this.equipmentService.reject(user.id, id, dto.reason);
  }

  // ─── Alternar disponibilidade (OWNER / ADMIN) ─────────────────────────────

  @Patch(':id/toggle-availability')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Alternar disponibilidade do equipamento',
    description:
      'Alterna isAvailable entre true e false. Apenas equipamentos ACTIVE. ' +
      'Útil para o owner pausar temporariamente um equipamento.',
  })
  @ApiParam({ name: 'id', description: 'ID do equipamento' })
  @ApiResponse({ status: 200, description: 'Disponibilidade alterada com sucesso.' })
  @ApiResponse({ status: 400, description: 'Operação inválida.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Equipamento não encontrado.' })
  toggleAvailability(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
  ) {
    return this.equipmentService.toggleAvailability(user.id, id);
  }

  // ─── Actualizar equipamento (OWNER / ADMIN) ───────────────────────────────

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  @Patch(':id')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Actualizar equipamento' })
  @ApiParam({ name: 'id', description: 'ID do equipamento' })
  @ApiBody({ type: UpdateEquipmentDto })
  @ApiResponse({ status: 200, description: 'Equipamento atualizado com sucesso.' })
  @ApiResponse({ status: 400, description: 'Dados inválidos.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Equipamento não encontrado.' })
  update(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body() dto: UpdateEquipmentDto,
  ) {
    return this.equipmentService.update(user.id, id, dto);
  }

  // ─── Soft delete (OWNER / ADMIN) ──────────────────────────────────────────

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  @Delete(':id')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Remover equipamento (soft delete)' })
  @ApiParam({ name: 'id', description: 'ID do equipamento' })
  @ApiResponse({ status: 200, description: 'Equipamento removido com sucesso.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Equipamento não encontrado.' })
  remove(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
  ) {
    return this.equipmentService.remove(user.id, id);
  }
}
