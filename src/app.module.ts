import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

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
  providers: [],
})
export class AppModule {}