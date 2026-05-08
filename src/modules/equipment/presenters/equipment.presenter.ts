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

// Mapeia os valores do enum Prisma (maiusculas) para o formato
// esperado pelo frontend (capitalizado: "New", "Good", etc.)
const CONDITION_MAP: Record<string, string> = {
  NEW: 'New',
  EXCELLENT: 'Excellent',
  GOOD: 'Good',
  USED: 'Used',
};

function toConditionLabel(condition: string): string {
  return CONDITION_MAP[condition] ?? condition;
}

export class EquipmentPresenter {
  static toListItem(equipment: EquipmentListEntity) {
    return {
      id: equipment.id,
      title: equipment.title,
      category: equipment.category.name,
      location: equipment.location,
      pricePerDay: Number(equipment.pricePerDay),
      image: equipment.photos?.[0]?.url ?? null,
      owner: equipment.owner.name,
      description: equipment.description,
      deliveryAvailable: equipment.deliveryIncluded,
      operatorAvailable: equipment.operatorAvailable,
      availableNow: equipment.isAvailable,
      condition: toConditionLabel(equipment.condition),
    };
  }

  static toDetails(equipment: EquipmentDetailsEntity) {
    return {
      id: equipment.id,
      title: equipment.title,
      description: equipment.description,
      category: {
        id: equipment.category.id,
        name: equipment.category.name,
        slug: equipment.category.slug,
      },
      location: equipment.location,
      pricePerDay: Number(equipment.pricePerDay),
      pricePerWeek: toNumber(equipment.pricePerWeek),
      pricePerMonth: toNumber(equipment.pricePerMonth),
      depositAmount: toNumber(equipment.depositAmount),
      latitude: toNumber(equipment.latitude),
      longitude: toNumber(equipment.longitude),
      deliveryAvailable: equipment.deliveryIncluded,
      operatorAvailable: equipment.operatorAvailable,
      availableNow: equipment.isAvailable,
      condition: toConditionLabel(equipment.condition),
      status: equipment.status,
      totalRating: toNumber(equipment.totalRating),
      totalReviews: equipment.totalReviews ?? 0,
      totalBookings: equipment.totalBookings ?? 0,
      photos: equipment.photos.map((photo) => ({
        url: photo.url,
        isPrimary: photo.isPrimary,
        order: photo.order,
      })),
      owner: {
        id: equipment.owner.id,
        name: equipment.owner.name,
        avatarUrl: equipment.owner.avatarUrl,
        bio: equipment.owner.bio ?? null,
        totalRating: toNumber(equipment.owner.totalRating),
        totalReviews: equipment.owner.totalReviews ?? 0,
      },
      createdAt: equipment.createdAt,
      updatedAt: equipment.updatedAt,
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
      category: {
        id: equipment.category.id,
        name: equipment.category.name,
        slug: equipment.category.slug,
      },
      location: equipment.location,
      pricePerDay: Number(equipment.pricePerDay),
      pricePerWeek: toNumber(equipment.pricePerWeek),
      pricePerMonth: toNumber(equipment.pricePerMonth),
      depositAmount: toNumber(equipment.depositAmount),
      image: equipment.photos?.[0]?.url ?? null,
      description: equipment.description,
      deliveryAvailable: equipment.deliveryIncluded,
      operatorAvailable: equipment.operatorAvailable,
      availableNow: equipment.isAvailable,
      condition: toConditionLabel(equipment.condition),
      status: equipment.status,
      isPremium: equipment.isPremium ?? false,
      totalRating: toNumber(equipment.totalRating),
      totalReviews: equipment.totalReviews ?? 0,
      totalBookings: equipment.totalBookings ?? 0,
      owner: {
        id: equipment.owner.id,
        name: equipment.owner.name,
        avatarUrl: equipment.owner.avatarUrl,
      },
    };
  }
}
