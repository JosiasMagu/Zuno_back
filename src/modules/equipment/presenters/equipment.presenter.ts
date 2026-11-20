import { approximateCoordinate } from '../../../shared/geo/approximate-location';

type EquipmentListEntity = {
  id: string;
  title: string;
  description: string;
  location: string;
  pricePerDay: unknown;
  deliveryIncluded: boolean;
  operatorAvailable: boolean;
  isAvailable: boolean;
  quantity?: number;
  condition: string;
  status: string;
  totalRating?: unknown;
  totalReviews?: number;
  /** Alugueres do anúncio que chegaram ao fim. */
  _count?: { bookings: number };
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
  rejectionReason?: string | null;
  rejectedAt?: Date | null;
  owner: {
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
function rejectionOf(equipment: {
  status: string;
  rejectionReason?: string | null;
}): string | null {
  return equipment.status === 'REJECTED'
    ? (equipment.rejectionReason ?? null)
    : null;
}

/**
 * Em todos os formatos, `freeUnitsToday` são as unidades livres hoje,
 * calculadas a partir das reservas. Saem na API como `availableQuantity`.
 */
export class EquipmentPresenter {
  static toListItem(equipment: EquipmentListEntity, freeUnitsToday: number) {
    return {
      id: equipment.id,
      title: equipment.title,
      description: equipment.description,
      location: equipment.location,
      pricePerDay: Number(equipment.pricePerDay),
      isAvailable: equipment.isAvailable,
      quantity: equipment.quantity,
      availableQuantity: freeUnitsToday,
      deliveryIncluded: equipment.deliveryIncluded,
      operatorAvailable: equipment.operatorAvailable,
      condition: equipment.condition,
      status: equipment.status,
      totalRating: toNumber(equipment.totalRating),
      totalReviews: equipment.totalReviews ?? 0,
      totalBookings: equipment._count?.bookings ?? 0,
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

  static toDetails(equipment: EquipmentDetailsEntity, freeUnitsToday: number) {
    return {
      id: equipment.id,
      title: equipment.title,
      description: equipment.description,
      location: equipment.location,
      pricePerDay: Number(equipment.pricePerDay),
      pricePerWeek: toNumber(equipment.pricePerWeek),
      pricePerMonth: toNumber(equipment.pricePerMonth),
      depositAmount: toNumber(equipment.depositAmount),
      // O detalhe é público: a localização sai aproximada, à zona.
      latitude: approximateCoordinate(equipment.latitude),
      longitude: approximateCoordinate(equipment.longitude),
      isAvailable: equipment.isAvailable,
      quantity: equipment.quantity,
      availableQuantity: freeUnitsToday,
      deliveryIncluded: equipment.deliveryIncluded,
      operatorAvailable: equipment.operatorAvailable,
      condition: equipment.condition,
      status: equipment.status,
      totalRating: toNumber(equipment.totalRating),
      totalReviews: equipment.totalReviews ?? 0,
      totalBookings: equipment._count?.bookings ?? 0,
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
        totalRating: toNumber(equipment.owner.providerRating),
        totalReviews: equipment.owner.providerReviews ?? 0,
      },
      photos: (equipment.photos ?? []).map((photo) => ({
        url: photo.url,
        isPrimary: photo.isPrimary,
        order: photo.order,
      })),
    };
  }

  /**
   * O detalhe como o dono o vê ao editar: com a localização exacta que ele
   * próprio indicou e, num anúncio rejeitado, o motivo.
   */
  static toOwnerDetails(
    equipment: EquipmentDetailsEntity,
    freeUnitsToday: number,
  ) {
    return {
      ...this.toDetails(equipment, freeUnitsToday),
      latitude: toNumber(equipment.latitude),
      longitude: toNumber(equipment.longitude),
      rejectionReason: rejectionOf(equipment),
      rejectedAt: equipment.rejectedAt ?? null,
    };
  }

  static toOwnerListingItem(
    equipment: EquipmentListEntity & {
      status: string;
      rejectionReason?: string | null;
      pricePerWeek?: unknown;
      pricePerMonth?: unknown;
      depositAmount?: unknown;
      isPremium?: boolean;
      createdAt?: Date;
    },
    freeUnitsToday: number,
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
      quantity: equipment.quantity,
      availableQuantity: freeUnitsToday,
      deliveryIncluded: equipment.deliveryIncluded,
      operatorAvailable: equipment.operatorAvailable,
      condition: equipment.condition,
      status: equipment.status,
      rejectionReason: rejectionOf(equipment),
      isPremium: equipment.isPremium ?? false,
      totalRating: toNumber(equipment.totalRating),
      totalReviews: equipment.totalReviews ?? 0,
      totalBookings: equipment._count?.bookings ?? 0,
      createdAt: equipment.createdAt ?? null,
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
