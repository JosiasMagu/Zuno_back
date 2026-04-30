import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { CloudinaryModule } from '../../shared/cloudinary/cloudinary.module';
import { EquipmentController } from './controllers/equipment.controller';
import { EquipmentPhotosController } from './controllers/equipment-photos.controller';
import { EquipmentService } from './services/equipment.service';
import { EquipmentPhotosService } from './services/equipment-photos.service';

@Module({
  imports: [AuthModule, CloudinaryModule],
  controllers: [EquipmentController, EquipmentPhotosController],
  providers: [EquipmentService, EquipmentPhotosService],
  exports: [EquipmentService],
})
export class EquipmentModule {}
