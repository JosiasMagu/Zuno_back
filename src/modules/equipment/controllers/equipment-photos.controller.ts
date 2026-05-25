import {
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import type { Express } from 'express';
import { UserRole } from '@prisma/client';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { EquipmentPhotosService } from '../services/equipment-photos.service';

@ApiTags('Equipment Photos')
@Controller('equipment/:equipmentId/photos')
@UseGuards(JwtAuthGuard)
export class EquipmentPhotosController {
  constructor(private readonly photosService: EquipmentPhotosService) {}

  // Listar fotos (público)

  @Get()
  @ApiOperation({ summary: 'Listar fotos de um equipamento' })
  @ApiParam({ name: 'equipmentId', description: 'ID do equipamento' })
  @ApiResponse({ status: 200, description: 'Fotos obtidas com sucesso.' })
  @ApiResponse({ status: 404, description: 'Equipamento não encontrado.' })
  listPhotos(@Param('equipmentId') equipmentId: string) {
    return this.photosService.listPhotos(equipmentId);
  }

  // Upload de uma foto — qualquer utilizador autenticado

  @Post('upload')
  @UseInterceptors(
    FileInterceptor('photo', {
      storage: undefined,
      limits: { fileSize: 5 * 1024 * 1024 },
    }),
  )
  @ApiBearerAuth('access-token')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload de uma foto',
    description:
      'Faz upload de uma foto para o Cloudinary. ' +
      'Campo do formulário: "photo". Máximo 5MB. Formatos: JPEG, PNG, WEBP.',
  })
  @ApiParam({ name: 'equipmentId', description: 'ID do equipamento' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        photo: {
          type: 'string',
          format: 'binary',
          description: 'Ficheiro de imagem (JPEG, PNG ou WEBP, máx. 5MB)',
        },
      },
      required: ['photo'],
    },
  })
  @ApiResponse({ status: 201, description: 'Foto adicionada com sucesso.' })
  @ApiResponse({ status: 400, description: 'Ficheiro inválido ou limite atingido.' })
  @ApiResponse({ status: 401, description: 'Não autenticado.' })
  @ApiResponse({ status: 404, description: 'Equipamento não encontrado.' })
  uploadOne(
    @CurrentUser() user: { id: string },
    @Param('equipmentId') equipmentId: string,
    @UploadedFile() file: any[],
  ) {
    return this.photosService.uploadPhoto(user.id, equipmentId, file);
  }

  // Upload múltiplo (até 5 fotos) — qualquer utilizador autenticado

  @Post('upload-multiple')
  @UseInterceptors(
    FilesInterceptor('photos', 5, {
      storage: undefined,
      limits: { fileSize: 5 * 1024 * 1024 },
    }),
  )
  @ApiBearerAuth('access-token')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload de múltiplas fotos (até 5 por vez)',
    description:
      'Faz upload de até 5 fotos de uma vez. Campo do formulário: "photos" (array).',
  })
  @ApiParam({ name: 'equipmentId', description: 'ID do equipamento' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        photos: {
          type: 'array',
          items: { type: 'string', format: 'binary' },
          description: 'Ficheiros de imagem (máx. 5 por upload)',
        },
      },
      required: ['photos'],
    },
  })
  @ApiResponse({ status: 201, description: 'Fotos adicionadas com sucesso.' })
  @ApiResponse({ status: 400, description: 'Ficheiros inválidos ou limite atingido.' })
  @ApiResponse({ status: 401, description: 'Não autenticado.' })
  @ApiResponse({ status: 404, description: 'Equipamento não encontrado.' })
  uploadMultiple(
    @CurrentUser() user: { id: string },
    @Param('equipmentId') equipmentId: string,
    @UploadedFiles() files: any[],
  ) {
    return this.photosService.uploadMultiplePhotos(user.id, equipmentId, files);
  }

  // Definir foto primária — qualquer autenticado, service valida ownership

  @Patch(':photoId/set-primary')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Definir foto como principal',
    description: 'A foto principal aparece como capa do equipamento no catálogo.',
  })
  @ApiParam({ name: 'equipmentId', description: 'ID do equipamento' })
  @ApiParam({ name: 'photoId', description: 'ID da foto' })
  @ApiResponse({ status: 200, description: 'Foto principal definida com sucesso.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Foto ou equipamento não encontrado.' })
  setPrimary(
    @CurrentUser() user: { id: string },
    @Param('equipmentId') equipmentId: string,
    @Param('photoId') photoId: string,
  ) {
    return this.photosService.setPrimary(user.id, equipmentId, photoId);
  }

  // Apagar foto — qualquer autenticado, service valida ownership

  @Delete(':photoId')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Apagar foto',
    description:
      'Remove a foto do Cloudinary e da base de dados. ' +
      'Se era a foto principal, a próxima na ordem torna-se principal automaticamente.',
  })
  @ApiParam({ name: 'equipmentId', description: 'ID do equipamento' })
  @ApiParam({ name: 'photoId', description: 'ID da foto' })
  @ApiResponse({ status: 200, description: 'Foto removida com sucesso.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Foto ou equipamento não encontrado.' })
  deletePhoto(
    @CurrentUser() user: { id: string },
    @Param('equipmentId') equipmentId: string,
    @Param('photoId') photoId: string,
  ) {
    return this.photosService.deletePhoto(user.id, equipmentId, photoId);
  }
}