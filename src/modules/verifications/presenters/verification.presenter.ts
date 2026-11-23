import { VerificationStatus, DocumentType } from '@prisma/client';

type VerificationEntity = {
  id: string;
  userId: string;
  status: VerificationStatus;
  documentType: DocumentType;
  documentBackId: string | null;
  submittedAt: Date;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  rejectionReason: string | null;
  user?: {
    id: string;
    name: string;
    phone?: string;
    role: string;
  };
};

/**
 * Os documentos não saem por aqui. O admin pede-os à parte, em
 * `GET /verifications/:id/documents`, com endereços que expiram.
 */
export class VerificationPresenter {
  static toOwnSummary(v: VerificationEntity) {
    return {
      id: v.id,
      status: v.status,
      documentType: v.documentType,
      submittedAt: v.submittedAt,
      reviewedAt: v.reviewedAt,
      rejectionReason: v.rejectionReason,
    };
  }

  static toAdminItem(v: VerificationEntity) {
    return {
      id: v.id,
      userId: v.userId,
      status: v.status,
      documentType: v.documentType,
      hasDocumentBack: v.documentBackId !== null,
      submittedAt: v.submittedAt,
      reviewedAt: v.reviewedAt,
      reviewedBy: v.reviewedBy,
      rejectionReason: v.rejectionReason,
      user: v.user
        ? {
            id: v.user.id,
            name: v.user.name,
            role: v.user.role,
          }
        : undefined,
    };
  }
}
