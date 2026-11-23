import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
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
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { ExecutePayoutDto } from '../dto/execute-payout.dto';
import { FailPayoutDto } from '../dto/fail-payout.dto';
import { FindPayoutsQueryDto } from '../dto/find-payouts-query.dto';
import { PayoutDispatcher } from '../services/payout-dispatcher.service';
import { PayoutsService } from '../services/payouts.service';

@ApiTags('Payouts')
@Controller('payouts')
@UseGuards(JwtAuthGuard)
export class PayoutsController {
  constructor(
    private readonly payoutsService: PayoutsService,
    private readonly dispatcher: PayoutDispatcher,
  ) {}

  @Get()
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Fila de payouts (ADMIN)',
    description:
      'Lista as transferências para fora do escrow, ordenadas da mais antiga para a mais recente. Usa status=PENDING para a fila de execução.',
  })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 10 })
  @ApiQuery({ name: 'status', required: false, example: 'PENDING' })
  @ApiResponse({ status: 200, description: 'Payouts obtidos com sucesso.' })
  findAll(
    @CurrentUser() user: { id: string },
    @Query() query: FindPayoutsQueryDto,
  ) {
    return this.payoutsService.findAll(user.id, query);
  }

  @Get('me')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Payouts do utilizador autenticado' })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 10 })
  @ApiQuery({ name: 'status', required: false, example: 'PENDING' })
  @ApiResponse({ status: 200, description: 'Payouts obtidos com sucesso.' })
  findMine(
    @CurrentUser() user: { id: string },
    @Query() query: FindPayoutsQueryDto,
  ) {
    return this.payoutsService.findMine(user.id, query);
  }

  @Patch(':id/approve')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @Throttle({ global: { ttl: 60_000, limit: 20 } })
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Aprovar um payout que espera por aprovação (ADMIN)',
    description:
      'Um payout só sai depois de aprovado quando passa PAYOUT_AUTO_MAX_AMOUNT ou, com MONEY_FOUR_EYES ligado, quando a entrada do dinheiro foi confirmada à mão. Com o fornecedor a enviar, sai logo; no modo manual fica aprovado para ser executado. O admin não aprova um payout para si próprio e, com MONEY_FOUR_EYES ligado, quem confirmou a entrada do dinheiro também não.',
  })
  @ApiParam({ name: 'id', description: 'ID do payout' })
  @ApiResponse({ status: 200, description: 'Payout aprovado.' })
  @ApiResponse({
    status: 400,
    description: 'Payout não pendente ou já aprovado.',
  })
  @ApiResponse({ status: 403, description: 'Controlo de dinheiro recusou.' })
  @ApiResponse({ status: 404, description: 'Payout não encontrado.' })
  approve(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.dispatcher.approve(user.id, id);
  }

  @Patch(':id/execute')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @Throttle({ global: { ttl: 60_000, limit: 20 } })
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Marcar payout como executado (ADMIN)',
    description:
      'Regista a execução manual da transferência M-Pesa com a referência real. Recusa um payout que o fornecedor está a enviar (SENDING), um payout para o próprio admin e, com MONEY_FOUR_EYES ligado, um payout cujo dinheiro foi confirmado por este admin.',
  })
  @ApiParam({ name: 'id', description: 'ID do payout' })
  @ApiBody({ type: ExecutePayoutDto })
  @ApiResponse({ status: 200, description: 'Payout marcado como executado.' })
  @ApiResponse({ status: 400, description: 'Operação inválida.' })
  @ApiResponse({ status: 404, description: 'Payout não encontrado.' })
  execute(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body() dto: ExecutePayoutDto,
  ) {
    return this.payoutsService.execute(user.id, id, dto);
  }

  @Patch(':id/fail')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Marcar payout como falhado (ADMIN)' })
  @ApiParam({ name: 'id', description: 'ID do payout' })
  @ApiBody({ type: FailPayoutDto })
  @ApiResponse({ status: 200, description: 'Payout marcado como falhado.' })
  fail(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body() dto: FailPayoutDto,
  ) {
    return this.payoutsService.fail(user.id, id, dto);
  }

  @Patch(':id/retry')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Recolocar payout falhado na fila (ADMIN)' })
  @ApiParam({ name: 'id', description: 'ID do payout' })
  @ApiResponse({ status: 200, description: 'Payout recolocado na fila.' })
  retry(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.dispatcher.retry(user.id, id);
  }
}
