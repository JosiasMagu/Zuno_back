import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
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
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { CloudinaryService } from '../../../shared/cloudinary/cloudinary.service';
import { ClaimDepositDto } from '../dto/claim-deposit.dto';
import { CreateDisputeDto } from '../dto/create-dispute.dto';
import { FindDisputesQueryDto } from '../dto/find-disputes-query.dto';
import { ResolvePartialDto } from '../dto/resolve-partial.dto';
import { RespondDisputeDto } from '../dto/respond-dispute.dto';
import { WithdrawDisputeDto } from '../dto/withdraw-dispute.dto';
import { DisputesService } from '../services/disputes.service';

@ApiTags('Disputes')
@Controller('disputes')
@UseGuards(JwtAuthGuard)
export class DisputesController {
  constructor(
    private readonly disputesService: DisputesService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  @Post('upload-evidence')
  // Cada foto custa armazenamento, por isso há um tecto por hora.
  @Throttle({ global: { ttl: 3_600_000, limit: 30 } })
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Upload de foto de evidência para disputa' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { photo: { type: 'string', format: 'binary' } },
    },
  })
  @UseInterceptors(
    FileInterceptor('photo', { limits: { fileSize: 5 * 1024 * 1024 } }),
  )
  async uploadEvidence(
    @CurrentUser() user: { id: string },
    @UploadedFile() file: Express.Multer.File,
  ) {
    const result = await this.cloudinary.uploadDisputeEvidence(file, user.id);
    return {
      message: 'Foto carregada com sucesso.',
      data: { url: result.url, publicId: result.publicId },
    };
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles(UserRole.CLIENT, UserRole.PROVIDER, UserRole.ADMIN)
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

  @Post('deposit-claim')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Reclamar o depósito de uma reserva (provider)',
    description:
      'O provider abre uma disputa sobre o depósito quando o equipamento é devolvido danificado. Só possível com a reserva ativa, pagamento liberado e dentro da janela de reclamação após o fim do aluguer. O cliente tem prazo para responder e a decisão é do admin.',
  })
  @ApiBody({ type: ClaimDepositDto })
  @ApiResponse({
    status: 201,
    description: 'Reclamação do depósito registada.',
  })
  @ApiResponse({ status: 400, description: 'Operação inválida.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Reserva não encontrada.' })
  claimDeposit(
    @CurrentUser() user: { id: string },
    @Body() dto: ClaimDepositDto,
  ) {
    return this.disputesService.claimDeposit(user.id, dto);
  }

  @Get('me')
  @UseGuards(RolesGuard)
  @Roles(UserRole.CLIENT, UserRole.PROVIDER, UserRole.ADMIN)
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
  @Roles(UserRole.CLIENT, UserRole.PROVIDER, UserRole.ADMIN)
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
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Responder a uma disputa',
    description:
      'Responde a outra parte da reserva, a que não abriu a disputa, com a sua versão e as suas provas. Um admin pode registar a resposta por ela. Depois da resposta a disputa segue para análise.',
  })
  @ApiParam({ name: 'id', description: 'ID da disputa' })
  @ApiBody({ type: RespondDisputeDto })
  @ApiResponse({
    status: 200,
    description: 'Resposta registada. A disputa segue para análise.',
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

  @Patch(':id/withdraw')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Retirar uma disputa',
    description:
      'Quem abriu a disputa pode retirá-la enquanto não for decidida, e um admin pode arquivá-la. Não move dinheiro: a reserva volta ao estado em que estava.',
  })
  @ApiParam({ name: 'id', description: 'ID da disputa' })
  @ApiBody({ type: WithdrawDisputeDto })
  @ApiResponse({ status: 200, description: 'Disputa retirada.' })
  @ApiResponse({ status: 400, description: 'A disputa já foi decidida.' })
  @ApiResponse({ status: 403, description: 'Não é quem abriu a disputa.' })
  @ApiResponse({ status: 404, description: 'Disputa não encontrada.' })
  withdraw(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body() dto: WithdrawDisputeDto,
  ) {
    return this.disputesService.withdraw(user.id, id, dto);
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
