import {
  Body,
  Controller,
  Get,
  HttpCode,
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
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import {
  FindUnallocatedQueryDto,
  MarkUnallocatedReturnedDto,
  RegisterUnallocatedDto,
} from '../dto/unallocated-funds.dto';
import { UnallocatedFundsService } from '../services/unallocated-funds.service';

/**
 * Dinheiro que entrou na conta da plataforma sem fechar nenhum pagamento:
 * valor diferente do cobrado, excesso, chegada depois de a reserva expirar ou
 * referência desconhecida. Fica registado até ser devolvido a quem pagou.
 */
@ApiTags('Payments')
@Controller('payments/admin/unallocated')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@ApiBearerAuth('access-token')
export class UnallocatedFundsController {
  constructor(private readonly unallocated: UnallocatedFundsService) {}

  @Get()
  @ApiOperation({
    summary: '[ADMIN] Dinheiro por atribuir',
    description: 'Do mais antigo para o mais recente. Filtra por status.',
  })
  @ApiResponse({ status: 200, description: 'Lista obtida.' })
  list(
    @CurrentUser() user: { id: string },
    @Query() query: FindUnallocatedQueryDto,
  ) {
    return this.unallocated.list(user.id, query);
  }

  @Post()
  @Throttle({ global: { ttl: 60_000, limit: 20 } })
  @ApiOperation({
    summary: '[ADMIN] Registar uma entrada do extracto que não fecha pagamento',
    description:
      'Por exemplo, um cliente que pagou menos do que o total. Recusa uma referência que já fecha um pagamento ou que já está registada.',
  })
  @ApiBody({ type: RegisterUnallocatedDto })
  @ApiResponse({ status: 201, description: 'Registado.' })
  @ApiResponse({ status: 409, description: 'Referência já registada.' })
  register(
    @CurrentUser() user: { id: string },
    @Body() dto: RegisterUnallocatedDto,
  ) {
    return this.unallocated.registerFromStatement(user.id, dto);
  }

  @Patch(':id/returned')
  @Throttle({ global: { ttl: 60_000, limit: 20 } })
  @ApiOperation({
    summary: '[ADMIN] Registar a devolução feita à mão',
    description: 'Com a referência M-Pesa da transferência de volta.',
  })
  @ApiParam({ name: 'id' })
  @ApiBody({ type: MarkUnallocatedReturnedDto })
  @ApiResponse({ status: 200, description: 'Devolução registada.' })
  @ApiResponse({ status: 400, description: 'Já devolvido ou em devolução.' })
  @ApiResponse({ status: 409, description: 'Referência já usada.' })
  markReturned(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body() dto: MarkUnallocatedReturnedDto,
  ) {
    return this.unallocated.markReturned(user.id, id, dto);
  }

  @Post(':id/return')
  @HttpCode(200)
  @Throttle({ global: { ttl: 60_000, limit: 20 } })
  @ApiOperation({
    summary: '[ADMIN] Devolver pelo fornecedor',
    description:
      'Envia o valor de volta ao número que pagou. Só com um fornecedor que envia dinheiro (PAYOUT_TRANSFER_UNAVAILABLE no modo manual).',
  })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Devolução enviada ou pedida.' })
  @ApiResponse({ status: 400, description: 'Envio desligado ou já tratado.' })
  returnViaProvider(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
  ) {
    return this.unallocated.returnViaProvider(user.id, id);
  }
}
