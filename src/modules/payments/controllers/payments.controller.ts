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
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { Idempotent } from '../../../common/idempotency/idempotent.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { CollectPaymentDto } from '../dto/collect-payment.dto';
import { InitiatePaymentDto } from '../dto/initiate-payment.dto';
import { MarkPaymentHeldDto } from '../dto/mark-payment-held.dto';
import { VoidHoldDto } from '../dto/void-hold.dto';
import { DeclarePaymentDto } from '../dto/declare-payment.dto';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { FindPaymentsQueryDto } from '../dto/find-payments-query.dto';
import { CollectionsService } from '../services/collections.service';
import { PaymentDeclarationsService } from '../services/payment-declarations.service';
import { PaymentsService } from '../services/payments.service';
import { HoldVoidService } from '../services/hold-void.service';
import { ReconciliationService } from '../services/reconciliation.service';

@ApiTags('Payments')
@Controller('payments')
@UseGuards(JwtAuthGuard)
export class PaymentsController {
  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly declarations: PaymentDeclarationsService,
    private readonly reconciliation: ReconciliationService,
    private readonly holdVoids: HoldVoidService,
    private readonly collections: CollectionsService,
  ) {}

  @Post('booking/:bookingId/initiate')
  @UseGuards(RolesGuard)
  @Roles(UserRole.CLIENT, UserRole.PROVIDER, UserRole.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Iniciar pagamento de uma reserva' })
  @ApiParam({ name: 'bookingId', description: 'ID da reserva' })
  @ApiBody({ type: InitiatePaymentDto })
  @ApiResponse({ status: 201, description: 'Pagamento iniciado com sucesso.' })
  @ApiResponse({ status: 400, description: 'Operação inválida.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Reserva não encontrada.' })
  initiate(
    @CurrentUser() user: { id: string },
    @Param('bookingId') bookingId: string,
    @Body() dto: InitiatePaymentDto,
  ) {
    return this.paymentsService.initiate(user.id, bookingId, dto);
  }

  @Get('me')
  @UseGuards(RolesGuard)
  @Roles(UserRole.CLIENT, UserRole.PROVIDER, UserRole.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Listar pagamentos do utilizador autenticado' })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 10 })
  @ApiQuery({ name: 'status', required: false, example: 'PENDING' })
  @ApiResponse({ status: 200, description: 'Pagamentos obtidos com sucesso.' })
  findMyPayments(
    @CurrentUser() user: { id: string },
    @Query() query: FindPaymentsQueryDto,
  ) {
    return this.paymentsService.findMyPayments(user.id, query);
  }

  @Get('admin/declared')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: '[ADMIN] Pagamentos declarados por confirmar',
    description:
      'Pagamentos que o cliente declarou ter feito e que ainda não foram confirmados no extracto, do mais antigo para o mais recente.',
  })
  @ApiResponse({ status: 200, description: 'Fila obtida com sucesso.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  findDeclared(@Query() query: PaginationQueryDto) {
    return this.declarations.findAwaitingConfirmation(query);
  }

  @Get('admin/reconciliation')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: '[ADMIN] Conferir se o dinheiro bate certo',
    description:
      'Compara o ledger, o estado de cada pagamento, os payouts e as reservas. Devolve quanto está retido, quanto falta pagar e cada divergência encontrada. Só lê: não corrige nada.',
  })
  @ApiResponse({ status: 200, description: 'Reconciliação concluída.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  async reconcile() {
    return {
      message: 'Reconciliação concluída.',
      data: await this.reconciliation.run(),
    };
  }

  @Get('instructions')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Como pagar',
    description:
      'Diz à app como se paga agora. Em mode=automatic, a app pede a cobrança no telemóvel do cliente (POST /payments/:id/collect). Em mode=manual, o cliente paga para o número em receiver e declara a referência (PATCH /payments/:id/declare).',
  })
  @ApiResponse({ status: 200, description: 'Instruções de pagamento.' })
  instructions() {
    return {
      message: 'Instruções de pagamento.',
      data: this.collections.instructions(),
    };
  }

  @Get(':id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.CLIENT, UserRole.PROVIDER, UserRole.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Obter pagamento por ID' })
  @ApiParam({ name: 'id', description: 'ID do pagamento' })
  @ApiResponse({ status: 200, description: 'Pagamento obtido com sucesso.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Pagamento não encontrado.' })
  findOne(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.paymentsService.findOne(user.id, id);
  }

  @Post(':id/collect')
  @Throttle({ global: { ttl: 60_000, limit: 10 } })
  @Idempotent()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Pedir o pagamento no telemóvel',
    description:
      'Quem fez a reserva pede ao fornecedor que cobre o total no número indicado, e confirma no telemóvel com o PIN. Só há uma cobrança em curso por pagamento, e uma cobrança sem resposta nunca se repete: o estado sai em GET /payments/:id, no campo collection.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'UUID único por tentativa de cobrança (TTL 24h).',
  })
  @ApiParam({ name: 'id', description: 'ID do pagamento' })
  @ApiBody({ type: CollectPaymentDto })
  @ApiResponse({ status: 201, description: 'Pedido enviado ao fornecedor.' })
  @ApiResponse({
    status: 400,
    description:
      'Cobrança automática desligada (PAYMENT_COLLECTION_UNAVAILABLE), pagamento já fechado ou Idempotency-Key ausente.',
  })
  @ApiResponse({ status: 403, description: 'Não é quem fez a reserva.' })
  @ApiResponse({ status: 404, description: 'Pagamento não encontrado.' })
  @ApiResponse({
    status: 409,
    description:
      'Já há uma cobrança em curso (PAYMENT_COLLECTION_IN_PROGRESS).',
  })
  collect(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body() dto: CollectPaymentDto,
  ) {
    return this.collections.request(user.id, id, dto.msisdn);
  }

  @Patch(':id/declare')
  @Throttle({ global: { ttl: 60_000, limit: 5 } })
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Declarar que o pagamento foi feito',
    description:
      'Quem fez a reserva indica a referência M-Pesa e o número de onde pagou. A reserva deixa de expirar por falta de pagamento e fica à espera da confirmação do admin. Não move dinheiro.',
  })
  @ApiParam({ name: 'id', description: 'ID do pagamento' })
  @ApiBody({ type: DeclarePaymentDto })
  @ApiResponse({ status: 200, description: 'Pagamento declarado.' })
  @ApiResponse({
    status: 400,
    description: 'Pagamento já confirmado ou reserva fora de prazo.',
  })
  @ApiResponse({ status: 403, description: 'Não é quem fez a reserva.' })
  @ApiResponse({ status: 404, description: 'Pagamento não encontrado.' })
  declare(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body() dto: DeclarePaymentDto,
  ) {
    return this.declarations.declare(user.id, id, dto);
  }

  @Patch(':id/void-hold')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Anular uma confirmação de entrada dada por engano',
    description:
      'Só para confirmações feitas à mão, com o pagamento ainda retido, sem disputa aberta e sem entrega confirmada. Tem de ser outro admin a anular. O pagamento volta a estar por pagar, com prazo novo, e a referência M-Pesa fica livre.',
  })
  @ApiParam({ name: 'id', description: 'ID do pagamento' })
  @ApiBody({ type: VoidHoldDto })
  @ApiResponse({ status: 200, description: 'Confirmação anulada.' })
  @ApiResponse({ status: 400, description: 'A confirmação já não se anula.' })
  @ApiResponse({
    status: 403,
    description: 'Quem confirmou a entrada, ou é parte da reserva, não anula.',
  })
  @ApiResponse({ status: 404, description: 'Pagamento não encontrado.' })
  voidHold(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body() dto: VoidHoldDto,
  ) {
    return this.holdVoids.voidHold(user.id, id, dto.reason);
  }

  @Patch(':id/mark-held')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Marcar pagamento como retido',
    description:
      'O admin confirma a entrada do dinheiro com a referência M-Pesa, o valor recebido e o número pagador. O valor tem de ser o total do pagamento e a referência não pode já ter sido usada.',
  })
  @ApiParam({ name: 'id', description: 'ID do pagamento' })
  @ApiBody({ type: MarkPaymentHeldDto })
  @ApiResponse({
    status: 200,
    description: 'Pagamento marcado como retido com sucesso.',
  })
  @ApiResponse({ status: 400, description: 'Operação inválida.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Pagamento não encontrado.' })
  @ApiResponse({
    status: 409,
    description: 'Referência M-Pesa já registada noutro pagamento.',
  })
  markHeld(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body() dto: MarkPaymentHeldDto,
  ) {
    return this.paymentsService.markHeld(user.id, id, dto);
  }

  @Patch(':id/release')
  @UseGuards(RolesGuard)
  @Roles(UserRole.CLIENT, UserRole.PROVIDER, UserRole.ADMIN)
  @Throttle({ global: { ttl: 60_000, limit: 5 } })
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Liberar pagamento retido',
    description:
      'Só quem fez a reserva (o cliente daquele pagamento) ou um ADMIN pode liberar, seja qual for o papel da conta. ' +
      'Quem recebe o pagamento nunca o pode liberar: isso quebraria a garantia central do cofre digital.',
  })
  @ApiParam({ name: 'id', description: 'ID do pagamento' })
  @ApiResponse({ status: 200, description: 'Pagamento liberado com sucesso.' })
  @ApiResponse({ status: 400, description: 'Operação inválida.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Pagamento não encontrado.' })
  release(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.paymentsService.release(user.id, id);
  }

  @Patch(':id/refund')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Reembolsar pagamento' })
  @ApiParam({ name: 'id', description: 'ID do pagamento' })
  @ApiResponse({
    status: 200,
    description: 'Pagamento reembolsado com sucesso.',
  })
  @ApiResponse({ status: 400, description: 'Operação inválida.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Pagamento não encontrado.' })
  refund(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.paymentsService.refund(user.id, id);
  }

  @Post('booking/:bookingId/mock-pay')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Simular pagamento M-Pesa (mock)' })
  @ApiParam({ name: 'bookingId' })
  initiateMock(
    @CurrentUser() user: { id: string },
    @Param('bookingId') bookingId: string,
  ) {
    return this.paymentsService.initiateMock(user.id, bookingId);
  }
}
