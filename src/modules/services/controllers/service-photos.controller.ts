import {
  Body,
  Controller,
  Delete,
  Param,
  Patch,
  Post,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
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
import { Roles } from '../../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { UploadServicePhotoDto } from '../dto/upload-service-photo.dto';
import { UploadServicePhotosBatchDto } from '../dto/upload-service-photos-batch.dto';
import { ServicePhotosService } from '../services/service-photos.service';

@ApiTags('Service Photos')
@Controller('service-photos')
@UseGuards(JwtAuthGuard)
export class ServicePhotosController {
  constructor(private readonly photosService: ServicePhotosService) {}

  @Post('upload')
  @UseGuards(RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.ADMIN)
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
      'Campos: "photo" (ficheiro), "serviceId" (uuid), "isPrimary" (opcional).',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        photo: { type: 'string', format: 'binary' },
        serviceId: { type: 'string', format: 'uuid' },
        isPrimary: { type: 'boolean' },
      },
      required: ['photo', 'serviceId'],
    },
  })
  @ApiResponse({ status: 201, description: 'Foto adicionada com sucesso.' })
  @ApiResponse({
    status: 400,
    description: 'Ficheiro inválido ou limite atingido.',
  })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Serviço não encontrado.' })
  uploadOne(
    @CurrentUser() user: { id: string },
    @Body() dto: UploadServicePhotoDto,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.photosService.uploadPhoto(
      user.id,
      dto.serviceId,
      file,
      dto.isPrimary ?? false,
    );
  }

  @Post('upload-multiple')
  @UseGuards(RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.ADMIN)
  @UseInterceptors(
    FilesInterceptor('photos', 5, {
      storage: undefined,
      limits: { fileSize: 5 * 1024 * 1024 },
    }),
  )
  @ApiBearerAuth('access-token')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload de múltiplas fotos (até 5 por vez)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        photos: {
          type: 'array',
          items: { type: 'string', format: 'binary' },
        },
        serviceId: { type: 'string', format: 'uuid' },
      },
      required: ['photos', 'serviceId'],
    },
  })
  @ApiResponse({ status: 201, description: 'Fotos adicionadas com sucesso.' })
  @ApiResponse({ status: 400, description: 'Ficheiros inválidos.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Serviço não encontrado.' })
  uploadMultiple(
    @CurrentUser() user: { id: string },
    @Body() dto: UploadServicePhotosBatchDto,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    return this.photosService.uploadMultiplePhotos(
      user.id,
      dto.serviceId,
      files,
    );
  }

  @Patch(':photoId/set-primary')
  @UseGuards(RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Definir foto como principal' })
  @ApiParam({ name: 'photoId' })
  @ApiResponse({
    status: 200,
    description: 'Foto principal definida com sucesso.',
  })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Foto não encontrada.' })
  setPrimary(
    @CurrentUser() user: { id: string },
    @Param('photoId') photoId: string,
  ) {
    return this.photosService.setPrimary(user.id, photoId);
  }

  @Delete(':photoId')
  @UseGuards(RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Apagar foto' })
  @ApiParam({ name: 'photoId' })
  @ApiResponse({ status: 200, description: 'Foto removida com sucesso.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Foto não encontrada.' })
  deletePhoto(
    @CurrentUser() user: { id: string },
    @Param('photoId') photoId: string,
  ) {
    return this.photosService.deletePhoto(user.id, photoId);
  }
}
