import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
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
import { UpdateUserDto } from '../dto/update-user.dto';
import { SavePushTokenDto } from '../dto/save-push-token.dto';
import { SuspendUserDto } from '../dto/suspend-user.dto';
import { UsersService } from '../services/users.service';

@ApiTags('Users')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @UseGuards(JwtAuthGuard)
  @Get('me')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Obter perfil do utilizador autenticado' })
  @ApiResponse({ status: 200, description: 'Perfil obtido com sucesso.' })
  @ApiResponse({ status: 401, description: 'Não autenticado.' })
  getMe(@CurrentUser() user: { id: string }) {
    return this.usersService.getMe(user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('me')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Atualizar perfil do utilizador autenticado' })
  @ApiBody({ type: UpdateUserDto })
  @ApiResponse({ status: 200, description: 'Perfil atualizado com sucesso.' })
  @ApiResponse({ status: 400, description: 'Dados inválidos.' })
  @ApiResponse({ status: 401, description: 'Não autenticado.' })
  updateMe(@CurrentUser() user: { id: string }, @Body() dto: UpdateUserDto) {
    return this.usersService.updateMe(user.id, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Post('push-token')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Guardar token push do dispositivo' })
  @ApiBody({ type: SavePushTokenDto })
  @ApiResponse({ status: 201, description: 'Token guardado com sucesso.' })
  @ApiResponse({ status: 401, description: 'Não autenticado.' })
  savePushToken(
    @CurrentUser() user: { id: string },
    @Body() dto: SavePushTokenDto,
  ) {
    return (this.usersService as any).savePushToken(user.id, dto.token);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obter perfil público de um utilizador por ID' })
  @ApiParam({ name: 'id', description: 'ID do utilizador' })
  @ApiResponse({ status: 200, description: 'Perfil público obtido com sucesso.' })
  @ApiResponse({ status: 404, description: 'Utilizador não encontrado.' })
  getPublicProfile(@Param('id') id: string) {
    return this.usersService.getPublicProfile(id);
  }

  // ─── Moderação de utilizadores (ADMIN) ────────────────────────────────────

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Patch(':id/suspend')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: '[ADMIN] Suspender utilizador',
    description:
      'Define isActive=false. O utilizador deixa de poder autenticar e a sua sessão actual é invalidada nas próximas operações. Suspender ADMINs por esta via não é permitido.',
  })
  @ApiParam({ name: 'id', description: 'ID do utilizador a suspender' })
  @ApiBody({ type: SuspendUserDto })
  @ApiResponse({ status: 200, description: 'Utilizador suspenso com sucesso.' })
  @ApiResponse({ status: 400, description: 'Já suspenso, conta admin, ou auto-suspensão.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Utilizador não encontrado.' })
  suspend(
    @CurrentUser() admin: { id: string },
    @Param('id') id: string,
    @Body() dto: SuspendUserDto,
  ) {
    return this.usersService.suspend(admin.id, id, dto.reason);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Patch(':id/reactivate')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: '[ADMIN] Reactivar utilizador suspenso',
    description: 'Restaura isActive=true.',
  })
  @ApiParam({ name: 'id', description: 'ID do utilizador a reactivar' })
  @ApiResponse({ status: 200, description: 'Utilizador reactivado com sucesso.' })
  @ApiResponse({ status: 400, description: 'Utilizador já está activo.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Utilizador não encontrado.' })
  reactivate(@CurrentUser() admin: { id: string }, @Param('id') id: string) {
    return this.usersService.reactivate(admin.id, id);
  }
}