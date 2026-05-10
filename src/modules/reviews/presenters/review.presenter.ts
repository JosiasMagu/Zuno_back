type ReviewEntity = {
  id: string;
  bookingId: string | null;
  serviceBookingId: string | null;
  authorId: string;
  targetId: string;
  authorRole: string;
  rating: number;
  comment: string | null;
  createdAt: Date;
  author: {
    id: string;
    name: string;
    avatarUrl: string | null;
  };
};

export class ReviewPresenter {
  static toItem(review: ReviewEntity) {
    return {
      id: review.id,
      bookingId: review.bookingId,
      serviceBookingId: review.serviceBookingId,
      authorRole: review.authorRole,
      rating: review.rating,
      comment: review.comment ?? null,
      createdAt: review.createdAt,
      author: {
        id: review.author.id,
        name: review.author.name,
        avatarUrl: review.author.avatarUrl,
      },
      targetId: review.targetId,
    };
  }
}
