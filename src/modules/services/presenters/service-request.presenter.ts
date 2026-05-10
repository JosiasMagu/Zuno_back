type ServiceRequestEntity = {
  id: string;
  clientId: string;
  serviceId: string;
  description: string;
  preferredDate: Date | null;
  isUrgent: boolean;
  address: string;
  latitude: unknown;
  longitude: unknown;
  status: string;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  service?: {
    id: string;
    title: string;
    providerId: string;
    basePrice: unknown;
    urgentSurcharge: unknown;
    acceptsUrgent: boolean;
  };
  client?: {
    id: string;
    name: string;
    avatarUrl: string | null;
  };
};

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

export class ServiceRequestPresenter {
  static toItem(request: ServiceRequestEntity) {
    return {
      id: request.id,
      clientId: request.clientId,
      serviceId: request.serviceId,
      description: request.description,
      preferredDate: request.preferredDate,
      isUrgent: request.isUrgent,
      address: request.address,
      latitude: toNumber(request.latitude),
      longitude: toNumber(request.longitude),
      status: request.status,
      expiresAt: request.expiresAt,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
      service: request.service
        ? {
            id: request.service.id,
            title: request.service.title,
            providerId: request.service.providerId,
            basePrice: Number(request.service.basePrice),
            urgentSurcharge: toNumber(request.service.urgentSurcharge),
            acceptsUrgent: request.service.acceptsUrgent,
          }
        : undefined,
      client: request.client
        ? {
            id: request.client.id,
            name: request.client.name,
            avatarUrl: request.client.avatarUrl,
          }
        : undefined,
    };
  }
}
