import { Module } from '@nestjs/common';

import { VerificationsController } from './controllers/verifications.controller';
import { VerificationsService } from './services/verifications.service';

@Module({
  controllers: [VerificationsController],
  providers: [VerificationsService],
  // Exportado para o EquipmentService poder consultar isVerified()
  // sem ter que ir directamente à BD.
  exports: [VerificationsService],
})
export class VerificationsModule {}
