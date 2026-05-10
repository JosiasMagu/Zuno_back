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
import { ServicePhotosService } from '../services/service-photos.service';

@ApiTags('Service Photos')
@Controller('services/:serviceId/photos')
@UseGuards(JwtAuthGuard)
export class ServicePhotosController {
  constructor(private readonly photosService: ServicePhotosService) {}

  @Get()
  @ApiOperation({ summary: 'Listar fotos de um serviço' })
  @ApiParam({ name: 'serviceId' })
  @ApiResponse({ status: 200, description: 'Fotos obtidas com sucesso.' })
  @ApiResponse({ status: 404, description: 'Serviço não encontrado.' })
  listPhotos(@Param('serviceId') serviceId: string) {
    return this.photosService.listPhotos(serviceId);
  }

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
      'Campo do formulário: "photo". Máximo 5MB. Formatos: JPEG, PNG, WEBP.',
  })
  @ApiParam({ name: 'serviceId' })
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
  @ApiResponse({
    status: 400,
    description: 'Ficheiro inválido ou limite atingido.',
  })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Serviço não encontrado.' })
  uploadOne(
    @CurrentUser() user: { id: string },
    @Param('serviceId') serviceId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.photosService.uploadPhoto(user.id, serviceId, file);
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
  @ApiParam({ name: 'serviceId' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        photos: {
          type: 'array',
          items: { type: 'string', format: 'binary' },
        },
      },
      required: ['photos'],
    },
  })
  @ApiResponse({ status: 201, description: 'Fotos adicionadas com sucesso.' })
  @ApiResponse({ status: 400, description: 'Ficheiros inválidos.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Serviço não encontrado.' })
  uploadMultiple(
    @CurrentUser() user: { id: string },
    @Param('serviceId') serviceId: string,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    return this.photosService.uploadMultiplePhotos(user.id, serviceId, files);
  }

  @Patch(':photoId/set-primary')
  @UseGuards(RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Definir foto como principal' })
  @ApiParam({ name: 'serviceId' })
  @ApiParam({ name: 'photoId' })
  @ApiResponse({
    status: 200,
    description: 'Foto principal definida com sucesso.',
  })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Foto ou serviço não encontrado.' })
  setPrimary(
    @CurrentUser() user: { id: string },
    @Param('serviceId') serviceId: string,
    @Param('photoId') photoId: string,
  ) {
    return this.photosService.setPrimary(user.id, serviceId, photoId);
  }

  @Delete(':photoId')
  @UseGuards(RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Apagar foto' })
  @ApiParam({ name: 'serviceId' })
  @ApiParam({ name: 'photoId' })
  @ApiResponse({ status: 200, description: 'Foto removida com sucesso.' })
  @ApiResponse({ status: 403, description: 'Sem permissão.' })
  @ApiResponse({ status: 404, description: 'Foto ou serviço não encontrado.' })
  deletePhoto(
    @CurrentUser() user: { id: string },
    @Param('serviceId') serviceId: string,
    @Param('photoId') photoId: string,
  ) {
    return this.photosService.deletePhoto(user.id, serviceId, photoId);
  }
}
