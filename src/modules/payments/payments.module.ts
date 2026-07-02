import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PaymentsController } from './controllers/payments.controller';
import { PayoutsController } from './controllers/payouts.controller';
import { LedgerService } from './services/ledger.service';
import { PaymentsService } from './services/payments.service';
import { PayoutsService } from './services/payouts.service';

@Module({
  imports: [AuthModule],
  controllers: [PaymentsController, PayoutsController],
  providers: [PaymentsService, LedgerService, PayoutsService],
  exports: [PaymentsService, LedgerService, PayoutsService],
})
export class PaymentsModule {}
