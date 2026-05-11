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
  totalRating?: unknown;
  totalReviews?: number;
  totalCompleted?: number;
  provider: {
    id: string;
    name: string;
    avatarUrl: string | null;
    bio?: string | null;
    totalRating?: unknown;
    totalReviews?: number;
  };
};

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
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
      latitude: toNumber(service.latitude),
      longitude: toNumber(service.longitude),
      acceptsUrgent: service.acceptsUrgent,
      urgentSurcharge: toNumber(service.urgentSurcharge),
      availableNow: service.isActive,
      status: service.status,
      totalRating: toNumber(service.totalRating),
      totalReviews: service.totalReviews ?? 0,
      totalCompleted: service.totalCompleted ?? 0,
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
        totalRating: toNumber(service.provider.totalRating),
        totalReviews: service.provider.totalReviews ?? 0,
      },
      createdAt: service.createdAt,
      updatedAt: service.updatedAt,
    };
  }

  static toProviderListingItem(
    service: ServiceListEntity & {
      latitude?: unknown;
      longitude?: unknown;
      estimatedHours?: number | null;
      totalRating?: unknown;
      totalReviews?: number;
      totalCompleted?: number;
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
      totalRating: toNumber(service.totalRating),
      totalReviews: service.totalReviews ?? 0,
      totalCompleted: service.totalCompleted ?? 0,
      provider: {
        id: service.provider.id,
        name: service.provider.name,
        avatarUrl: service.provider.avatarUrl,
      },
    };
  }
}
