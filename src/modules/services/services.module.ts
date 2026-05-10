import { Module } from '@nestjs/common';

import { CloudinaryModule } from '../../shared/cloudinary/cloudinary.module';
import { AuthModule } from '../auth/auth.module';
import { ServicePhotosController } from './controllers/service-photos.controller';
import { ServicesController } from './controllers/services.controller';
import { ServicePhotosService } from './services/service-photos.service';
import { ServicesService } from './services/services.service';

@Module({
  imports: [AuthModule, CloudinaryModule],
  controllers: [ServicesController, ServicePhotosController],
  providers: [ServicesService, ServicePhotosService],
  exports: [ServicesService],
})
export class ServicesModule {}
