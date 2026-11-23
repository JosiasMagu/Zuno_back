import { Module } from '@nestjs/common';

import { CloudinaryModule } from '../../shared/cloudinary/cloudinary.module';
import { VerificationsController } from './controllers/verifications.controller';
import { VerificationsService } from './services/verifications.service';

@Module({
  imports: [CloudinaryModule],
  controllers: [VerificationsController],
  providers: [VerificationsService],
  // Exportado para os anúncios (equipamentos e serviços) consultarem
  // isVerified() sem irem directamente à BD.
  exports: [VerificationsService],
})
export class VerificationsModule {}
