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
import { PayoutsService } from '../services/payouts.service';

@ApiTags('Payouts')
@Controller('payouts')
@UseGuards(JwtAuthGuard)
export class PayoutsController {
  constructor(private readonly payoutsService: PayoutsService) {}

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

  @Patch(':id/execute')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @Throttle({ global: { ttl: 60_000, limit: 20 } })
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Marcar payout como executado (ADMIN)',
    description:
      'Regista a execução manual da transferência M-Pesa com a referência real.',
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
    return this.payoutsService.retry(user.id, id);
  }
}
