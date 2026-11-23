import { payoutNeedsApproval } from '../money-controls';
import type { PayoutControls } from '../money-controls';

type PayoutEntity = {
  id: string;
  paymentId: string;
  recipientId: string;
  kind: string;
  amount: unknown;
  msisdn: string | null;
  status: string;
  mpesaReference: string | null;
  executedById: string | null;
  executedAt: Date | null;
  failReason: string | null;
  approvedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  recipient?: {
    id: string;
    name: string;
    phone: string;
    payoutMsisdn: string | null;
  };
  payment?: {
    id: string;
    receiptNumber: string;
    heldById?: string | null;
    bookingId: string | null;
    serviceBookingId: string | null;
  };
};

export class PayoutPresenter {
  /**
   * Com os controlos (listagem do admin), diz também se o payout espera por
   * aprovação para sair pelo fornecedor.
   */
  static toListItem(payout: PayoutEntity, controls?: PayoutControls) {
    return {
      id: payout.id,
      paymentId: payout.paymentId,
      recipientId: payout.recipientId,
      kind: payout.kind,
      amount: Number(payout.amount),
      msisdn: payout.msisdn,
      status: payout.status,
      mpesaReference: payout.mpesaReference,
      executedAt: payout.executedAt,
      failReason: payout.failReason,
      approvedAt: payout.approvedAt ?? null,
      ...(controls
        ? {
            needsApproval: payoutNeedsApproval(
              { ...payout, approvedAt: payout.approvedAt ?? null },
              controls,
            ),
          }
        : {}),
      createdAt: payout.createdAt,
      updatedAt: payout.updatedAt,
      recipient: payout.recipient
        ? {
            id: payout.recipient.id,
            name: payout.recipient.name,
            phone: payout.recipient.phone,
            payoutMsisdn: payout.recipient.payoutMsisdn,
          }
        : undefined,
      receiptNumber: payout.payment?.receiptNumber,
      bookingId: payout.payment?.bookingId ?? null,
      serviceBookingId: payout.payment?.serviceBookingId ?? null,
    };
  }
}
