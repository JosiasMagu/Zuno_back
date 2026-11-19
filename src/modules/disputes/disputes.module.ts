import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { CloudinaryModule } from '../../shared/cloudinary/cloudinary.module';
import { PaymentsModule } from '../payments/payments.module';
import { DisputesController } from './controllers/disputes.controller';
import { DisputesScheduler } from './schedulers/disputes.scheduler';
import { DisputeNotifier } from './services/dispute-notifier.service';
import { DisputesService } from './services/disputes.service';

@Module({
  imports: [AuthModule, CloudinaryModule, PaymentsModule],
  controllers: [DisputesController],
  providers: [DisputesService, DisputeNotifier, DisputesScheduler],
  exports: [DisputesService],
})
export class DisputesModule {}
