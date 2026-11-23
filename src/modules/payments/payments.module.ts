import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PaymentsController } from './controllers/payments.controller';
import { PayoutsController } from './controllers/payouts.controller';
import { ProviderEventsController } from './controllers/provider-events.controller';
import { UnallocatedFundsController } from './controllers/unallocated-funds.controller';
import { paymentProviderFactory } from './providers/provider.factory';
import { PaymentOperationsScheduler } from './schedulers/payment-operations.scheduler';
import { ReconciliationScheduler } from './schedulers/reconciliation.scheduler';
import { CollectionsService } from './services/collections.service';
import { EscrowRefundService } from './services/escrow-refund.service';
import { LedgerService } from './services/ledger.service';
import { PaymentDeclarationsService } from './services/payment-declarations.service';
import { PaymentNotifier } from './services/payment-notifier.service';
import { PaymentsService } from './services/payments.service';
import { PayoutDispatcher } from './services/payout-dispatcher.service';
import { PayoutsService } from './services/payouts.service';
import { ProviderEventsService } from './services/provider-events.service';
import { ProviderOperationsService } from './services/provider-operations.service';
import { HoldVoidService } from './services/hold-void.service';
import { ReconciliationService } from './services/reconciliation.service';
import { UnallocatedFundsService } from './services/unallocated-funds.service';

@Module({
  imports: [AuthModule],
  controllers: [
    PaymentsController,
    PayoutsController,
    ProviderEventsController,
    UnallocatedFundsController,
  ],
  providers: [
    paymentProviderFactory,
    PaymentsService,
    PaymentDeclarationsService,
    HoldVoidService,
    PaymentNotifier,
    LedgerService,
    PayoutsService,
    EscrowRefundService,
    ReconciliationService,
    ReconciliationScheduler,
    CollectionsService,
    UnallocatedFundsService,
    PayoutDispatcher,
    ProviderOperationsService,
    ProviderEventsService,
    PaymentOperationsScheduler,
  ],
  exports: [
    PaymentsService,
    LedgerService,
    PayoutsService,
    EscrowRefundService,
    ReconciliationService,
  ],
})
export class PaymentsModule {}
