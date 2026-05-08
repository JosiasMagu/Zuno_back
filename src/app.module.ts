import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';

import { AuthModule } from './modules/auth/auth.module';
import { BookingsModule } from './modules/bookings/bookings.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { ChatModule } from './modules/chat/chat.module';
import { DisputesModule } from './modules/disputes/disputes.module';
import { EquipmentModule } from './modules/equipment/equipment.module';
import { HealthModule } from './modules/health/health.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { ReviewsModule } from './modules/reviews/reviews.module';
import { UsersModule } from './modules/users/users.module';
import { AuditModule } from './shared/audit/audit.module';
import { DatabaseModule } from './shared/db/database.module';
import { LoggerModule } from './shared/logger/logger.module';
import { NotificationsModule } from './shared/notifications/notifications.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    LoggerModule,
    ThrottlerModule.forRoot([
      {
        name: 'global',
        ttl: 60_000,
        limit: 100,
      },
    ]),
    DatabaseModule,
    AuditModule,
    NotificationsModule,
    HealthModule,
    AuthModule,
    UsersModule,
    CategoriesModule,
    EquipmentModule,
    BookingsModule,
    PaymentsModule,
    DisputesModule,
    ReviewsModule,
    ChatModule,
  ],
  controllers: [],
  providers: [
    {
      provide: APP_GUARD,
      useClass:
        process.env.NODE_ENV === 'test'
          ? class NoopThrottlerGuard {
              canActivate() {
                return true;
              }
            }
          : ThrottlerGuard,
    },
  ],
})
export class AppModule {}
