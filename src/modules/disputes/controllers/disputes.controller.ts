import {
  Body,
  Controller,
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
import { CreateDisputeDto } from '../dto/create-dispute.dto';
import { FindDisputesQueryDto } from '../dto/find-disputes-query.dto';
import { ResolvePartialDto } from '../dto/resolve-partial.dto';
import { RespondDisputeDto } from '../dto/respond-dispute.dto';
import { DisputesService } from '../services/disputes.service';

@ApiTags('Disputes')
@Controller('disputes')
@UseGuards(JwtAuthGuard)
export class DisputesController {
  constructor(private readonly disputesService: DisputesService) {}

  @Post()
  @UseGuards(RolesGuard)
  @Roles(UserRole.CLIENT, UserRole.OWNER, UserRole.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Criar disputa' })
  @ApiBody({ type: CreateDisputeDto })
  @ApiResponse({ status: 201, description: 'Disputa criada com sucesso.' })
  @ApiResponse({ status: 400, description: 'Operação inválida.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Reserva não encontrada.' })
  create(@CurrentUser() user: { id: string }, @Body() dto: CreateDisputeDto) {
    return this.disputesService.create(user.id, dto);
  }

  @Get('me')
  @UseGuards(RolesGuard)
  @Roles(UserRole.CLIENT, UserRole.OWNER, UserRole.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Listar disputas do utilizador autenticado' })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 10 })
  @ApiQuery({ name: 'status', required: false, example: 'AWAITING_OWNER' })
  @ApiResponse({ status: 200, description: 'Disputas obtidas com sucesso.' })
  findMyDisputes(
    @CurrentUser() user: { id: string },
    @Query() query: FindDisputesQueryDto,
  ) {
    return this.disputesService.findMyDisputes(user.id, query);
  }

  @Get(':id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.CLIENT, UserRole.OWNER, UserRole.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Obter disputa por ID' })
  @ApiParam({ name: 'id', description: 'ID da disputa' })
  @ApiResponse({ status: 200, description: 'Disputa obtida com sucesso.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Disputa não encontrada.' })
  findOne(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.disputesService.findOne(user.id, id);
  }

  @Patch(':id/respond')
  @UseGuards(RolesGuard)
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Responder disputa como owner' })
  @ApiParam({ name: 'id', description: 'ID da disputa' })
  @ApiBody({ type: RespondDisputeDto })
  @ApiResponse({
    status: 200,
    description: 'Resposta da disputa registrada com sucesso.',
  })
  @ApiResponse({ status: 400, description: 'Operação inválida.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Disputa não encontrada.' })
  respond(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body() dto: RespondDisputeDto,
  ) {
    return this.disputesService.respond(user.id, id, dto);
  }

  @Patch(':id/resolve-client')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Resolver disputa a favor do cliente' })
  @ApiParam({ name: 'id', description: 'ID da disputa' })
  @ApiResponse({
    status: 200,
    description: 'Disputa resolvida a favor do cliente.',
  })
  @ApiResponse({ status: 400, description: 'Operação inválida.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Disputa não encontrada.' })
  resolveClient(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.disputesService.resolveClient(user.id, id);
  }

  @Patch(':id/resolve-owner')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Resolver disputa a favor do owner' })
  @ApiParam({ name: 'id', description: 'ID da disputa' })
  @ApiResponse({
    status: 200,
    description: 'Disputa resolvida a favor do owner.',
  })
  @ApiResponse({ status: 400, description: 'Operação inválida.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Disputa não encontrada.' })
  resolveOwner(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.disputesService.resolveOwner(user.id, id);
  }

  @Patch(':id/resolve-partial')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Resolver disputa parcialmente' })
  @ApiParam({ name: 'id', description: 'ID da disputa' })
  @ApiBody({ type: ResolvePartialDto })
  @ApiResponse({
    status: 200,
    description: 'Disputa resolvida parcialmente com sucesso.',
  })
  @ApiResponse({ status: 400, description: 'Operação inválida.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Disputa não encontrada.' })
  resolvePartial(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body() dto: ResolvePartialDto,
  ) {
    return this.disputesService.resolvePartial(user.id, id, dto);
  }
}
