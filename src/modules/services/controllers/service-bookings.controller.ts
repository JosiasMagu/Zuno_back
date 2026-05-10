import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CancelServiceBookingDto } from '../dto/cancel-service-booking.dto';
import { FindServiceBookingsQueryDto } from '../dto/find-service-bookings-query.dto';
import { ServiceBookingsService } from '../services/service-bookings.service';

@ApiTags('Service Bookings')
@Controller('service-bookings')
@UseGuards(JwtAuthGuard)
export class ServiceBookingsController {
  constructor(private readonly bookingsService: ServiceBookingsService) {}

  @Get('me')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Reservas do cliente autenticado' })
  @ApiResponse({ status: 200, description: 'Reservas obtidas com sucesso.' })
  findMine(
    @CurrentUser() user: { id: string },
    @Query() query: FindServiceBookingsQueryDto,
  ) {
    return this.bookingsService.findMine(user.id, query);
  }

  @Get('provider')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Reservas onde o utilizador é provider' })
  @ApiResponse({ status: 200, description: 'Reservas obtidas com sucesso.' })
  findForProvider(
    @CurrentUser() user: { id: string },
    @Query() query: FindServiceBookingsQueryDto,
  ) {
    return this.bookingsService.findForProvider(user.id, query);
  }

  @Get(':id')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Detalhe de uma reserva' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Reserva obtida com sucesso.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Reserva não encontrada.' })
  findOne(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.bookingsService.findOne(user.id, id);
  }

  @Patch(':id/start')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Iniciar execução (provider)',
    description: 'Requer Payment.status === HELD.',
  })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Execução iniciada com sucesso.' })
  @ApiResponse({ status: 400, description: 'Operação inválida.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Reserva não encontrada.' })
  start(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.bookingsService.start(user.id, id);
  }

  @Patch(':id/complete')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Concluir execução (provider)',
    description:
      'Marca como COMPLETED. Cliente deve então libertar o escrow via /payments/:id/release.',
  })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Execução concluída.' })
  @ApiResponse({ status: 400, description: 'Operação inválida.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Reserva não encontrada.' })
  complete(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.bookingsService.complete(user.id, id);
  }

  @Patch(':id/cancel')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Cancelar reserva',
    description:
      'CLIENT ou PROVIDER cancelam consoante o estado. ADMIN pode forçar.',
  })
  @ApiParam({ name: 'id' })
  @ApiBody({ type: CancelServiceBookingDto })
  @ApiResponse({ status: 200, description: 'Reserva cancelada com sucesso.' })
  @ApiResponse({ status: 400, description: 'Operação inválida.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Reserva não encontrada.' })
  cancel(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body() dto: CancelServiceBookingDto,
  ) {
    return this.bookingsService.cancel(user.id, id, dto);
  }
}
