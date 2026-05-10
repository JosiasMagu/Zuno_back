type ServiceQuoteEntity = {
  id: string;
  requestId: string;
  providerId: string;
  amount: unknown;
  urgentSurcharge: unknown;
  totalAmount: unknown;
  estimatedDays: number;
  message: string | null;
  status: string;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  provider?: {
    id: string;
    name: string;
    avatarUrl: string | null;
  };
  request?: {
    id: string;
    clientId: string;
    description: string;
    isUrgent: boolean;
    status: string;
    serviceId: string;
  };
};

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

export class ServiceQuotePresenter {
  static toItem(quote: ServiceQuoteEntity) {
    return {
      id: quote.id,
      requestId: quote.requestId,
      providerId: quote.providerId,
      amount: Number(quote.amount),
      urgentSurcharge: toNumber(quote.urgentSurcharge),
      totalAmount: Number(quote.totalAmount),
      estimatedDays: quote.estimatedDays,
      message: quote.message,
      status: quote.status,
      expiresAt: quote.expiresAt,
      createdAt: quote.createdAt,
      updatedAt: quote.updatedAt,
      provider: quote.provider
        ? {
            id: quote.provider.id,
            name: quote.provider.name,
            avatarUrl: quote.provider.avatarUrl,
          }
        : undefined,
      request: quote.request
        ? {
            id: quote.request.id,
            clientId: quote.request.clientId,
            description: quote.request.description,
            isUrgent: quote.request.isUrgent,
            status: quote.request.status,
            serviceId: quote.request.serviceId,
          }
        : undefined,
    };
  }
}
