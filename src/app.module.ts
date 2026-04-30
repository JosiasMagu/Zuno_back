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
import { PaymentsModule } from './modules/payments/payments.module';
import { ReviewsModule } from './modules/reviews/reviews.module';
import { UsersModule } from './modules/users/users.module';
import { DatabaseModule } from './shared/db/database.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ThrottlerModule.forRoot([
      {
        name: 'global',
        ttl: 60_000, 
        limit: 100,  
      },
    ]),
    DatabaseModule,
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
    // Aplica o ThrottlerGuard globalmente a todas as rotas
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}