import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { BookingsController } from './controllers/bookings.controller';
import { BookingsService } from './services/bookings.service';

@Module({
  imports: [AuthModule],
  controllers: [BookingsController],
  providers: [BookingsService],
  exports: [BookingsService],
})
export class BookingsModule {}