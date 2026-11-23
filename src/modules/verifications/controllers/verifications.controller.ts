import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UserRole } from '@prisma/client';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { MAX_IMAGE_BYTES } from '../../../shared/cloudinary/cloudinary.service';
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

  // Utilizador autenticado

  @UseGuards(JwtAuthGuard)
  @Post('users/me/verification/documents')
  // Três fotos por submissão, com folga para repetir. Cada uma custa armazenamento.
  @Throttle({ global: { ttl: 3_600_000, limit: 12 } })
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Carregar a foto de um documento KYC',
    description:
      'Guarda a foto em privado e devolve o identificador a enviar na submissão. Chama-se uma vez por foto: frente, verso e selfie.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { photo: { type: 'string', format: 'binary' } },
    },
  })
  @UseInterceptors(
    FileInterceptor('photo', { limits: { fileSize: MAX_IMAGE_BYTES } }),
  )
  @ApiResponse({ status: 201, description: 'Documento carregado.' })
  @ApiResponse({ status: 400, description: 'Já verificado ou já pendente.' })
  uploadDocument(
    @CurrentUser() user: { id: string },
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.verifications.uploadDocument(user.id, file);
  }

  @UseGuards(JwtAuthGuard)
  @Post('users/me/verification')
  @Throttle({ global: { ttl: 60_000, limit: 3 } })
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Submeter documentos KYC',
    description:
      'Recebe os identificadores das fotos carregadas em POST /users/me/verification/documents. Depois de uma rejeição pode submeter-se de novo.',
  })
  @ApiBody({ type: SubmitVerificationDto })
  @ApiResponse({
    status: 201,
    description: 'Documentos submetidos. Em revisão.',
  })
  @ApiResponse({ status: 400, description: 'Já verificado ou já pendente.' })
  submit(
    @CurrentUser() user: { id: string },
    @Body() dto: SubmitVerificationDto,
  ) {
    return this.verifications.submit(user.id, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Get('users/me/verification')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Estado da minha verificação KYC' })
  @ApiResponse({
    status: 200,
    description: 'Estado obtido com sucesso (pode ser null).',
  })
  getMyStatus(@CurrentUser() user: { id: string }) {
    return this.verifications.getMyStatus(user.id);
  }

  // Admin

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
  @Get('verifications/:id/documents')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: '[ADMIN] Abrir os documentos de uma verificação KYC',
    description:
      'Devolve endereços que expiram em poucos minutos. Cada consulta fica em auditoria.',
  })
  @ApiParam({ name: 'id', description: 'ID da verificação' })
  @ApiResponse({ status: 200, description: 'Endereços dos documentos.' })
  @ApiResponse({ status: 404, description: 'Verificação não encontrada.' })
  viewDocuments(@CurrentUser() admin: { id: string }, @Param('id') id: string) {
    return this.verifications.viewDocuments(admin.id, id);
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
