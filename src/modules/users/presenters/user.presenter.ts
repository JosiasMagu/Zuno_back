function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

type SafeUserEntity = {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  role: string;
  isVerified: boolean;
  isActive: boolean;
  avatarUrl: string | null;
  bio: string | null;
  totalRating?: unknown;
  totalReviews?: number;
  createdAt: Date;
  updatedAt?: Date;
};

type PublicUserEntity = {
  id: string;
  name: string;
  avatarUrl: string | null;
  bio: string | null;
  role: string;
  totalRating?: unknown;
  totalReviews?: number;
  createdAt: Date;
};

export class UserPresenter {
  static toMe(user: SafeUserEntity) {
    return {
      id: user.id,
      name: user.name,
      phone: user.phone,
      email: user.email,
      role: user.role,
      isVerified: user.isVerified,
      isActive: user.isActive,
      avatarUrl: user.avatarUrl,
      bio: user.bio,
      totalRating: toNumber(user.totalRating),
      totalReviews: user.totalReviews ?? 0,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  static toPublicProfile(user: PublicUserEntity) {
    return {
      id: user.id,
      name: user.name,
      avatarUrl: user.avatarUrl,
      bio: user.bio,
      role: user.role,
      totalRating: toNumber(user.totalRating),
      totalReviews: user.totalReviews ?? 0,
      createdAt: user.createdAt,
    };
  }
}