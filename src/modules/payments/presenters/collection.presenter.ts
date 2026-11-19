import { Prisma, ProviderOperationStatus } from '@prisma/client';

const IN_PROGRESS: ProviderOperationStatus[] = [
  ProviderOperationStatus.REQUESTED,
  ProviderOperationStatus.PENDING,
  ProviderOperationStatus.UNKNOWN,
];

type CollectionEntity = {
  id: string;
  provider: string;
  status: ProviderOperationStatus;
  amount: Prisma.Decimal;
  msisdn: string | null;
  failureCode: string | null;
  failureReason: string | null;
  createdAt: Date;
  confirmedAt: Date | null;
};

/**
 * Uma cobrança como a app a mostra: se ainda está em curso (à espera da
 * confirmação no telemóvel), se passou, ou porque falhou.
 */
export class CollectionPresenter {
  static toItem(operation: CollectionEntity) {
    return {
      id: operation.id,
      provider: operation.provider,
      status: operation.status,
      inProgress: IN_PROGRESS.includes(operation.status),
      amount: Number(operation.amount),
      msisdn: operation.msisdn,
      failureCode: operation.failureCode,
      failureReason: operation.failureReason,
      requestedAt: operation.createdAt,
      confirmedAt: operation.confirmedAt,
    };
  }
}
