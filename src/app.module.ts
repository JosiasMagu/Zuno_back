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
    // Rate limiting global — 100 requests por 60 segundos por IP.
    // Rotas sensíveis (login, register) têm limites mais apertados
    // via @Throttle() aplicado directamente no controller.
    ThrottlerModule.forRoot([
      {
        name: 'global',
        ttl: 60_000, // janela de 60 segundos
        limit: 100, // máximo 100 requests por IP por janela
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
    {
      provide: APP_GUARD,
      useClass:
        process.env.THROTTLER_DISABLED === 'true'
          ? class NoopGuard {
              canActivate() {
                return true;
              }
            }
          : ThrottlerGuard,
    },
  ],
})
export class AppModule {}
