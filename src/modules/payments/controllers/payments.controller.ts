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
import { InitiatePaymentDto } from '../dto/initiate-payment.dto';
import { FindPaymentsQueryDto } from '../dto/find-payments-query.dto';
import { PaymentsService } from '../services/payments.service';

@ApiTags('Payments')
@Controller('payments')
@UseGuards(JwtAuthGuard)
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

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

  @Patch(':id/mark-held')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Marcar pagamento como retido' })
  @ApiParam({ name: 'id', description: 'ID do pagamento' })
  @ApiResponse({
    status: 200,
    description: 'Pagamento marcado como retido com sucesso.',
  })
  @ApiResponse({ status: 400, description: 'Operação inválida.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Pagamento não encontrado.' })
  markHeld(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.paymentsService.markHeld(user.id, id);
  }

  @Patch(':id/release')
  @UseGuards(RolesGuard)
  @Roles(UserRole.CLIENT, UserRole.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Liberar pagamento retido',
    description:
      'Só o CLIENT (confirma recepção do equipamento) ou ADMIN pode liberar. ' +
      'O OWNER nunca pode liberar o seu próprio pagamento — ' +
      'isso quebraria a garantia central do cofre digital.',
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
}
