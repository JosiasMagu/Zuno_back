import { approximateCoordinate } from '../../../shared/geo/approximate-location';

type ServiceListEntity = {
  id: string;
  title: string;
  description: string;
  location: string;
  basePrice: unknown;
  pricingType: string;
  estimatedHours: number | null;
  acceptsUrgent: boolean;
  urgentSurcharge: unknown;
  isActive: boolean;
  status: string;
  totalRating?: unknown;
  totalReviews?: number;
  /** Trabalhos do serviço que chegaram ao fim. */
  _count?: { bookings: number };
  category: {
    id: string;
    name: string;
    slug: string;
  };
  provider: {
    id: string;
    name: string;
    avatarUrl: string | null;
  };
  photos: Array<{
    url: string;
    isPrimary: boolean;
    order: number;
  }>;
};

type ServiceDetailsEntity = ServiceListEntity & {
  createdAt: Date;
  updatedAt: Date;
  latitude?: unknown;
  longitude?: unknown;
  rejectionReason?: string | null;
  rejectedAt?: Date | null;
  provider: {
    id: string;
    name: string;
    avatarUrl: string | null;
    bio?: string | null;
    providerRating?: unknown;
    providerReviews?: number;
  };
};

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

/** O motivo da rejeição só interessa enquanto o anúncio está rejeitado. */
function rejectionOf(service: {
  status: string;
  rejectionReason?: string | null;
}): string | null {
  return service.status === 'REJECTED'
    ? (service.rejectionReason ?? null)
    : null;
}

export class ServicePresenter {
  static toListItem(service: ServiceListEntity) {
    return {
      id: service.id,
      title: service.title,
      category: service.category.name,
      location: service.location,
      basePrice: Number(service.basePrice),
      pricingType: service.pricingType,
      image: service.photos?.[0]?.url ?? null,
      provider: service.provider.name,
      description: service.description,
      acceptsUrgent: service.acceptsUrgent,
      urgentSurcharge: toNumber(service.urgentSurcharge),
      availableNow: service.isActive,
      totalRating: toNumber(service.totalRating),
      totalReviews: service.totalReviews ?? 0,
      totalCompleted: service._count?.bookings ?? 0,
    };
  }

  static toDetails(service: ServiceDetailsEntity) {
    return {
      id: service.id,
      title: service.title,
      description: service.description,
      category: {
        id: service.category.id,
        name: service.category.name,
        slug: service.category.slug,
      },
      location: service.location,
      basePrice: Number(service.basePrice),
      pricingType: service.pricingType,
      estimatedHours: service.estimatedHours ?? null,
      // O detalhe é público: a localização sai aproximada, à zona.
      latitude: approximateCoordinate(service.latitude),
      longitude: approximateCoordinate(service.longitude),
      acceptsUrgent: service.acceptsUrgent,
      urgentSurcharge: toNumber(service.urgentSurcharge),
      availableNow: service.isActive,
      status: service.status,
      totalRating: toNumber(service.totalRating),
      totalReviews: service.totalReviews ?? 0,
      totalCompleted: service._count?.bookings ?? 0,
      photos: service.photos.map((photo) => ({
        url: photo.url,
        isPrimary: photo.isPrimary,
        order: photo.order,
      })),
      provider: {
        id: service.provider.id,
        name: service.provider.name,
        avatarUrl: service.provider.avatarUrl,
        bio: service.provider.bio ?? null,
        totalRating: toNumber(service.provider.providerRating),
        totalReviews: service.provider.providerReviews ?? 0,
      },
      createdAt: service.createdAt,
      updatedAt: service.updatedAt,
    };
  }

  /**
   * O detalhe como o provider o vê ao editar: com a localização exacta que
   * ele próprio indicou e, num anúncio rejeitado, o motivo.
   */
  static toProviderDetails(service: ServiceDetailsEntity) {
    return {
      ...this.toDetails(service),
      latitude: toNumber(service.latitude),
      longitude: toNumber(service.longitude),
      rejectionReason: rejectionOf(service),
      rejectedAt: service.rejectedAt ?? null,
    };
  }

  static toProviderListingItem(
    service: ServiceListEntity & {
      rejectionReason?: string | null;
      latitude?: unknown;
      longitude?: unknown;
      estimatedHours?: number | null;
    },
  ) {
    return {
      id: service.id,
      title: service.title,
      category: {
        id: service.category.id,
        name: service.category.name,
        slug: service.category.slug,
      },
      location: service.location,
      basePrice: Number(service.basePrice),
      pricingType: service.pricingType,
      estimatedHours: service.estimatedHours ?? null,
      image: service.photos?.[0]?.url ?? null,
      description: service.description,
      acceptsUrgent: service.acceptsUrgent,
      urgentSurcharge: toNumber(service.urgentSurcharge),
      availableNow: service.isActive,
      status: service.status,
      rejectionReason: rejectionOf(service),
      totalRating: toNumber(service.totalRating),
      totalReviews: service.totalReviews ?? 0,
      totalCompleted: service._count?.bookings ?? 0,
      provider: {
        id: service.provider.id,
        name: service.provider.name,
        avatarUrl: service.provider.avatarUrl,
      },
    };
  }
}
