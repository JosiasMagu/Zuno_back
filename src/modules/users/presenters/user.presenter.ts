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
  payoutMsisdn?: string | null;
  providerRating?: unknown;
  providerReviews?: number;
  clientRating?: unknown;
  clientReviews?: number;
  createdAt: Date;
  updatedAt?: Date;
};

type PublicUserEntity = {
  id: string;
  name: string;
  avatarUrl: string | null;
  bio: string | null;
  role: string;
  providerRating?: unknown;
  providerReviews?: number;
  clientRating?: unknown;
  clientReviews?: number;
  createdAt: Date;
};

/**
 * As duas notas de uma conta. `totalRating` e `totalReviews` são a nota como
 * provider, a que a app mostra ao lado dos anúncios. A nota como cliente sai
 * à parte, para quem recebe uma reserva saber com quem está a tratar.
 */
function ratingsOf(user: {
  providerRating?: unknown;
  providerReviews?: number;
  clientRating?: unknown;
  clientReviews?: number;
}) {
  return {
    totalRating: toNumber(user.providerRating),
    totalReviews: user.providerReviews ?? 0,
    clientRating: toNumber(user.clientRating),
    clientReviews: user.clientReviews ?? 0,
  };
}

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
      payoutMsisdn: user.payoutMsisdn ?? null,
      ...ratingsOf(user),
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
      ...ratingsOf(user),
      createdAt: user.createdAt,
    };
  }
}
