import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
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
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CreateReviewDto } from '../dto/create-review.dto';
import { FindReviewsQueryDto } from '../dto/find-reviews-query.dto';
import { ReviewsService } from '../services/reviews.service';

@ApiTags('Reviews')
@Controller()
export class ReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  // Submeter avaliacao

  @Post('reviews')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Submeter avaliação',
    description:
      'CLIENT avalia o equipment e o owner. OWNER avalia o cliente. ' +
      'Apenas uma avaliação por booking por utilizador. ' +
      'Só permitido após a booking estar COMPLETED ou CANCELLED.',
  })
  @ApiBody({ type: CreateReviewDto })
  @ApiResponse({ status: 201, description: 'Avaliação submetida com sucesso.' })
  @ApiResponse({
    status: 400,
    description: 'Booking já avaliada ou status inválido.',
  })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Booking não encontrada.' })
  create(@CurrentUser() user: { id: string }, @Body() dto: CreateReviewDto) {
    return this.reviewsService.create(user.id, dto);
  }

  // Verificar se pode avaliar

  @Get('bookings/:bookingId/can-review')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Verificar se o utilizador pode avaliar uma booking',
    description:
      'Retorna { canReview: boolean, role?: ReviewAuthorRole, reason?: string }. ' +
      'O frontend usa este endpoint para mostrar ou esconder o botão de avaliação.',
  })
  @ApiParam({ name: 'bookingId', description: 'ID da booking' })
  @ApiResponse({ status: 200, description: 'Verificação concluída.' })
  @ApiResponse({ status: 404, description: 'Booking não encontrada.' })
  canReview(
    @CurrentUser() user: { id: string },
    @Param('bookingId') bookingId: string,
  ) {
    return this.reviewsService.canReview(user.id, bookingId);
  }

  // Avaliacoes de um equipment

  @Get('equipment/:equipmentId/reviews')
  @ApiOperation({
    summary: 'Listar avaliações de um equipamento',
    description:
      'Público. Mostra avaliações submetidas por CLIENTs sobre o equipment.',
  })
  @ApiParam({ name: 'equipmentId', description: 'ID do equipamento' })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 10 })
  @ApiResponse({ status: 200, description: 'Avaliações obtidas com sucesso.' })
  @ApiResponse({ status: 404, description: 'Equipamento não encontrado.' })
  findByEquipment(
    @Param('equipmentId') equipmentId: string,
    @Query() query: FindReviewsQueryDto,
  ) {
    return this.reviewsService.findByEquipment(equipmentId, query);
  }

  // Avaliacoes de um utilizador (como target)

  @Get('users/:userId/reviews')
  @ApiOperation({
    summary: 'Listar avaliações recebidas por um utilizador',
    description:
      'Público. Mostra avaliações recebidas pelo utilizador ' +
      '(como owner avaliado por clientes, ou como cliente avaliado por owners).',
  })
  @ApiParam({ name: 'userId', description: 'ID do utilizador' })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 10 })
  @ApiQuery({
    name: 'authorRole',
    required: false,
    description: 'Filtrar por tipo: CLIENT ou OWNER',
  })
  @ApiResponse({ status: 200, description: 'Avaliações obtidas com sucesso.' })
  @ApiResponse({ status: 404, description: 'Utilizador não encontrado.' })
  findByUser(
    @Param('userId') userId: string,
    @Query() query: FindReviewsQueryDto,
  ) {
    return this.reviewsService.findByUser(userId, query);
  }

  // As minhas avaliacoes submetidas

  @Get('reviews/me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Listar as minhas avaliações submetidas',
    description: 'Avaliações que o utilizador autenticado escreveu.',
  })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 10 })
  @ApiQuery({
    name: 'bookingId',
    required: false,
    description: 'Filtrar por booking específica',
  })
  @ApiResponse({ status: 200, description: 'Avaliações obtidas com sucesso.' })
  findMyReviews(
    @CurrentUser() user: { id: string },
    @Query() query: FindReviewsQueryDto,
  ) {
    return this.reviewsService.findMyReviews(user.id, query);
  }
}
