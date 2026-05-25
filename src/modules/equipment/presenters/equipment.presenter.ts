type EquipmentListEntity = {
  id: string;
  title: string;
  description: string;
  location: string;
  pricePerDay: unknown;
  deliveryIncluded: boolean;
  operatorAvailable: boolean;
  isAvailable: boolean;
  condition: string;
  status: string;
  category: {
    id: string;
    name: string;
    slug: string;
  };
  owner: {
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

type EquipmentDetailsEntity = EquipmentListEntity & {
  createdAt: Date;
  updatedAt: Date;
  pricePerWeek?: unknown;
  pricePerMonth?: unknown;
  depositAmount?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  totalRating?: unknown;
  totalReviews?: number;
  totalBookings?: number;
  owner: {
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

export class EquipmentPresenter {
  static toListItem(equipment: EquipmentListEntity) {
    return {
      id: equipment.id,
      title: equipment.title,
      description: equipment.description,
      location: equipment.location,
      pricePerDay: Number(equipment.pricePerDay),
      isAvailable: equipment.isAvailable,
      deliveryIncluded: equipment.deliveryIncluded,
      operatorAvailable: equipment.operatorAvailable,
      condition: equipment.condition,
      status: equipment.status,
      totalRating: null,
      totalReviews: 0,
      totalBookings: 0,
      category: {
        id: equipment.category.id,
        name: equipment.category.name,
        slug: equipment.category.slug,
      },
      owner: {
        id: equipment.owner.id,
        name: equipment.owner.name,
        avatarUrl: equipment.owner.avatarUrl,
      },
      photos: (equipment.photos ?? []).map((photo) => ({
        url: photo.url,
        isPrimary: photo.isPrimary,
        order: photo.order,
      })),
    };
  }

  static toDetails(equipment: EquipmentDetailsEntity) {
    return {
      id: equipment.id,
      title: equipment.title,
      description: equipment.description,
      location: equipment.location,
      pricePerDay: Number(equipment.pricePerDay),
      pricePerWeek: toNumber(equipment.pricePerWeek),
      pricePerMonth: toNumber(equipment.pricePerMonth),
      depositAmount: toNumber(equipment.depositAmount),
      latitude: toNumber(equipment.latitude),
      longitude: toNumber(equipment.longitude),
      isAvailable: equipment.isAvailable,
      deliveryIncluded: equipment.deliveryIncluded,
      operatorAvailable: equipment.operatorAvailable,
      condition: equipment.condition,
      status: equipment.status,
      totalRating: toNumber(equipment.totalRating),
      totalReviews: equipment.totalReviews ?? 0,
      totalBookings: equipment.totalBookings ?? 0,
      createdAt: equipment.createdAt,
      updatedAt: equipment.updatedAt,
      category: {
        id: equipment.category.id,
        name: equipment.category.name,
        slug: equipment.category.slug,
      },
      owner: {
        id: equipment.owner.id,
        name: equipment.owner.name,
        avatarUrl: equipment.owner.avatarUrl,
        bio: equipment.owner.bio ?? null,
        totalRating: toNumber(equipment.owner.totalRating),
        totalReviews: equipment.owner.totalReviews ?? 0,
      },
      photos: (equipment.photos ?? []).map((photo) => ({
        url: photo.url,
        isPrimary: photo.isPrimary,
        order: photo.order,
      })),
    };
  }

  static toOwnerListingItem(
    equipment: EquipmentListEntity & {
      status: string;
      pricePerWeek?: unknown;
      pricePerMonth?: unknown;
      depositAmount?: unknown;
      isPremium?: boolean;
      totalRating?: unknown;
      totalReviews?: number;
      totalBookings?: number;
    },
  ) {
    return {
      id: equipment.id,
      title: equipment.title,
      description: equipment.description,
      location: equipment.location,
      pricePerDay: Number(equipment.pricePerDay),
      pricePerWeek: toNumber(equipment.pricePerWeek),
      pricePerMonth: toNumber(equipment.pricePerMonth),
      depositAmount: toNumber(equipment.depositAmount),
      isAvailable: equipment.isAvailable,
      deliveryIncluded: equipment.deliveryIncluded,
      operatorAvailable: equipment.operatorAvailable,
      condition: equipment.condition,
      status: equipment.status,
      isPremium: equipment.isPremium ?? false,
      totalRating: toNumber(equipment.totalRating),
      totalReviews: equipment.totalReviews ?? 0,
      totalBookings: equipment.totalBookings ?? 0,
      category: {
        id: equipment.category.id,
        name: equipment.category.name,
        slug: equipment.category.slug,
      },
      owner: {
        id: equipment.owner.id,
        name: equipment.owner.name,
        avatarUrl: equipment.owner.avatarUrl,
      },
      photos: (equipment.photos ?? []).map((photo) => ({
        url: photo.url,
        isPrimary: photo.isPrimary,
        order: photo.order,
      })),
    };
  }
}