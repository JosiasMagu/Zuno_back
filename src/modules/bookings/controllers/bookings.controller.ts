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
import { CreateBookingDto } from '../dto/create-booking.dto';
import { FindBookingsQueryDto } from '../dto/find-bookings-query.dto';
import { UpdateBookingStatusDto } from '../dto/update-booking-status.dto';
import { BookingsService } from '../services/bookings.service';

@ApiTags('Bookings')
@Controller('bookings')
@UseGuards(JwtAuthGuard)
export class BookingsController {
  constructor(private readonly bookingsService: BookingsService) {}

  @Post()
  @UseGuards(RolesGuard)
  @Roles(UserRole.CLIENT, UserRole.PROVIDER, UserRole.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Criar reserva' })
  @ApiBody({ type: CreateBookingDto })
  @ApiResponse({ status: 201, description: 'Reserva criada com sucesso.' })
  @ApiResponse({ status: 400, description: 'Dados inválidos.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Equipamento não encontrado.' })
  create(@CurrentUser() user: { id: string }, @Body() dto: CreateBookingDto) {
    return this.bookingsService.create(user.id, dto);
  }

  @Get('me')
  @UseGuards(RolesGuard)
  @Roles(UserRole.CLIENT, UserRole.PROVIDER, UserRole.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Listar reservas do utilizador autenticado como cliente',
  })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 10 })
  @ApiQuery({ name: 'status', required: false, example: 'PENDING' })
  @ApiResponse({ status: 200, description: 'Reservas obtidas com sucesso.' })
  findMyBookings(
    @CurrentUser() user: { id: string },
    @Query() query: FindBookingsQueryDto,
  ) {
    return this.bookingsService.findMyBookings(user.id, query);
  }

  @Get('owner')
  @UseGuards(RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Listar reservas como proprietário' })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 10 })
  @ApiQuery({ name: 'status', required: false, example: 'CONFIRMED' })
  @ApiResponse({
    status: 200,
    description: 'Reservas do proprietário obtidas com sucesso.',
  })
  findOwnerBookings(
    @CurrentUser() user: { id: string },
    @Query() query: FindBookingsQueryDto,
  ) {
    return this.bookingsService.findOwnerBookings(user.id, query);
  }

  @Get(':id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.CLIENT, UserRole.PROVIDER, UserRole.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Obter reserva por ID' })
  @ApiParam({ name: 'id', description: 'ID da reserva' })
  @ApiResponse({ status: 200, description: 'Reserva obtida com sucesso.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Reserva não encontrada.' })
  findOne(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.bookingsService.findOne(user.id, id);
  }

  @Patch(':id/confirm')
  @UseGuards(RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Confirmar reserva' })
  @ApiParam({ name: 'id', description: 'ID da reserva' })
  @ApiResponse({ status: 200, description: 'Reserva confirmada com sucesso.' })
  @ApiResponse({ status: 400, description: 'Operação inválida.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Reserva não encontrada.' })
  confirm(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.bookingsService.confirm(user.id, id);
  }

  @Patch(':id/cancel')
  @UseGuards(RolesGuard)
  @Roles(UserRole.CLIENT, UserRole.PROVIDER, UserRole.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Cancelar reserva' })
  @ApiParam({ name: 'id', description: 'ID da reserva' })
  @ApiBody({ type: UpdateBookingStatusDto })
  @ApiResponse({ status: 200, description: 'Reserva cancelada com sucesso.' })
  @ApiResponse({ status: 400, description: 'Operação inválida.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Reserva não encontrada.' })
  cancel(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body() dto: UpdateBookingStatusDto,
  ) {
    return this.bookingsService.cancel(user.id, id, dto);
  }
}
