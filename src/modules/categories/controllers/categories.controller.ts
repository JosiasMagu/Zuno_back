import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseEnumPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CategoryKind, UserRole } from '@prisma/client';
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
import { CreateCategoryDto } from '../dto/create-category.dto';
import { UpdateCategoryDto } from '../dto/update-category.dto';
import { CategoriesService } from '../services/categories.service';

/**
 * Lê o filtro `kind` da lista pública. Um valor desconhecido responde 400 em
 * vez de ser tratado como se fosse BOTH.
 */
const KIND_FILTER = new ParseEnumPipe(CategoryKind, {
  optional: true,
  exceptionFactory: () =>
    new BadRequestException('kind tem de ser EQUIPMENT, SERVICE ou BOTH.'),
});

@ApiTags('Categories')
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Criar categoria' })
  @ApiBody({ type: CreateCategoryDto })
  @ApiResponse({ status: 201, description: 'Categoria criada com sucesso.' })
  @ApiResponse({ status: 400, description: 'Dados inválidos.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  create(@CurrentUser() admin: { id: string }, @Body() dto: CreateCategoryDto) {
    return this.categoriesService.create(admin.id, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Listar categorias ativas' })
  @ApiQuery({
    name: 'kind',
    required: false,
    enum: CategoryKind,
    description:
      'Filtra por tipo. EQUIPMENT inclui EQUIPMENT+BOTH; SERVICE inclui SERVICE+BOTH.',
  })
  @ApiResponse({ status: 200, description: 'Categorias obtidas com sucesso.' })
  findAll(@Query('kind', KIND_FILTER) kind?: CategoryKind) {
    return this.categoriesService.findAll({ kind });
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Get('admin/all')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: '[ADMIN] Listar todas as categorias',
    description:
      'Traz também as categorias desactivadas, que a lista pública esconde. É daqui que o painel as mostra para se poderem reactivar.',
  })
  @ApiResponse({ status: 200, description: 'Categorias obtidas com sucesso.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  findAllForAdmin() {
    return this.categoriesService.findAllForAdmin();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obter categoria ativa por ID' })
  @ApiParam({ name: 'id', description: 'ID da categoria' })
  @ApiResponse({ status: 200, description: 'Categoria obtida com sucesso.' })
  @ApiResponse({ status: 404, description: 'Categoria não encontrada.' })
  findOne(@Param('id') id: string) {
    return this.categoriesService.findOne(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Patch(':id')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Atualizar categoria',
    description:
      'Muda o nome, o ícone, a categoria pai, o tipo e se está activa. null em iconUrl ou parentId tira o valor. Uma categoria não pode ficar debaixo de uma das suas subcategorias.',
  })
  @ApiParam({ name: 'id', description: 'ID da categoria' })
  @ApiBody({ type: UpdateCategoryDto })
  @ApiResponse({
    status: 200,
    description: 'Categoria atualizada com sucesso.',
  })
  @ApiResponse({ status: 400, description: 'Dados inválidos.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Categoria não encontrada.' })
  update(
    @CurrentUser() admin: { id: string },
    @Param('id') id: string,
    @Body() dto: UpdateCategoryDto,
  ) {
    return this.categoriesService.update(admin.id, id, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Delete(':id')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Remover categoria (desativação lógica)' })
  @ApiParam({ name: 'id', description: 'ID da categoria' })
  @ApiResponse({ status: 200, description: 'Categoria removida com sucesso.' })
  @ApiResponse({ status: 400, description: 'Operação inválida.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Categoria não encontrada.' })
  remove(@CurrentUser() admin: { id: string }, @Param('id') id: string) {
    return this.categoriesService.remove(admin.id, id);
  }
}
