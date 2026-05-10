import { Module } from '@nestjs/common';

import { AuditModule } from '../../shared/audit/audit.module';
import { CloudinaryModule } from '../../shared/cloudinary/cloudinary.module';
import { AuthModule } from '../auth/auth.module';
import { ServicePhotosController } from './controllers/service-photos.controller';
import { ServiceRequestsController } from './controllers/service-requests.controller';
import { ServicesController } from './controllers/services.controller';
import { ServicePhotosService } from './services/service-photos.service';
import { ServiceRequestsService } from './services/service-requests.service';
import { ServicesService } from './services/services.service';

@Module({
  imports: [AuthModule, CloudinaryModule, AuditModule],
  controllers: [
    ServicesController,
    ServicePhotosController,
    ServiceRequestsController,
  ],
  providers: [ServicesService, ServicePhotosService, ServiceRequestsService],
  exports: [ServicesService],
})
export class ServicesModule {}
