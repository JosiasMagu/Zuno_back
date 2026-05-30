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
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { RejectVerificationDto } from '../dto/reject-verification.dto';
import { SubmitVerificationDto } from '../dto/submit-verification.dto';
import { VerificationsService } from '../services/verifications.service';

@ApiTags('Verifications')
@Controller()
export class VerificationsController {
  constructor(private readonly verifications: VerificationsService) {}

  // ─── Utilizador autenticado ───────────────────────────────────────────────

  @UseGuards(JwtAuthGuard)
  @Post('users/me/verification')
  @Throttle({ global: { ttl: 60_000, limit: 3 } })
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Submeter documentos KYC',
    description:
      'Faz upload prévio dos documentos para o Cloudinary (mesmo flow das fotos de equipment) e submete aqui as URLs resultantes. Reset após rejeição é permitido.',
  })
  @ApiBody({ type: SubmitVerificationDto })
  @ApiResponse({ status: 201, description: 'Documentos submetidos. Em revisão.' })
  @ApiResponse({ status: 400, description: 'Já verificado ou já pendente.' })
  submit(@CurrentUser() user: { id: string }, @Body() dto: SubmitVerificationDto) {
    return this.verifications.submit(user.id, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Get('users/me/verification')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Estado da minha verificação KYC' })
  @ApiResponse({ status: 200, description: 'Estado obtido com sucesso (pode ser null).' })
  getMyStatus(@CurrentUser() user: { id: string }) {
    return this.verifications.getMyStatus(user.id);
  }

  // ─── Admin ────────────────────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Get('admin/verifications/pending')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: '[ADMIN] Listar verificações KYC pendentes' })
  @ApiResponse({ status: 200, description: 'Pendentes obtidas com sucesso.' })
  findPending() {
    return this.verifications.findPending();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Patch('verifications/:id/approve')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: '[ADMIN] Aprovar verificação KYC' })
  @ApiParam({ name: 'id', description: 'ID da verificação' })
  @ApiResponse({ status: 200, description: 'Aprovada com sucesso.' })
  @ApiResponse({ status: 400, description: 'Já aprovada.' })
  @ApiResponse({ status: 404, description: 'Verificação não encontrada.' })
  approve(@CurrentUser() admin: { id: string }, @Param('id') id: string) {
    return this.verifications.approve(admin.id, id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Patch('verifications/:id/reject')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: '[ADMIN] Rejeitar verificação KYC' })
  @ApiParam({ name: 'id', description: 'ID da verificação' })
  @ApiBody({ type: RejectVerificationDto })
  @ApiResponse({ status: 200, description: 'Rejeitada com motivo registado.' })
  @ApiResponse({ status: 400, description: 'Já rejeitada.' })
  @ApiResponse({ status: 404, description: 'Verificação não encontrada.' })
  reject(
    @CurrentUser() admin: { id: string },
    @Param('id') id: string,
    @Body() dto: RejectVerificationDto,
  ) {
    return this.verifications.reject(admin.id, id, dto.reason);
  }
}
