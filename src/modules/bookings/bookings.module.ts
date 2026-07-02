import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PaymentsModule } from '../payments/payments.module';
import { BookingsController } from './controllers/bookings.controller';
import { BookingsScheduler } from './schedulers/bookings.scheduler';
import { BookingsService } from './services/bookings.service';

@Module({
  imports: [AuthModule, PaymentsModule],
  controllers: [BookingsController],
  providers: [BookingsService, BookingsScheduler],
  exports: [BookingsService],
})
export class BookingsModule {}
