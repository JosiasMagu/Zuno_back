import { Module } from '@nestjs/common';

import { AuditModule } from '../../shared/audit/audit.module';
import { CloudinaryModule } from '../../shared/cloudinary/cloudinary.module';
import { AuthModule } from '../auth/auth.module';
import { PaymentsModule } from '../payments/payments.module';
import { VerificationsModule } from '../verifications/verifications.module';
import { ServiceBookingsController } from './controllers/service-bookings.controller';
import { ServicePhotosController } from './controllers/service-photos.controller';
import { ServiceQuotesController } from './controllers/service-quotes.controller';
import { ServiceRequestsController } from './controllers/service-requests.controller';
import { ServicesController } from './controllers/services.controller';
import { ServicesScheduler } from './schedulers/services.scheduler';
import { ServiceBookingNotifier } from './services/service-booking-notifier.service';
import { ServiceBookingsService } from './services/service-bookings.service';
import { ServicePhotosService } from './services/service-photos.service';
import { ServiceQuotesService } from './services/service-quotes.service';
import { ServiceRequestsService } from './services/service-requests.service';
import { ServicesService } from './services/services.service';

@Module({
  imports: [
    AuthModule,
    CloudinaryModule,
    AuditModule,
    PaymentsModule,
    VerificationsModule,
  ],
  controllers: [
    ServicesController,
    ServicePhotosController,
    ServiceRequestsController,
    ServiceQuotesController,
    ServiceBookingsController,
  ],
  providers: [
    ServicesService,
    ServicePhotosService,
    ServiceRequestsService,
    ServiceQuotesService,
    ServiceBookingsService,
    ServiceBookingNotifier,
    ServicesScheduler,
  ],
  exports: [ServicesService, ServiceBookingsService],
})
export class ServicesModule {}
