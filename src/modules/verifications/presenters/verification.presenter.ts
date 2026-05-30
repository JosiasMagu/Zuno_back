import { VerificationStatus, DocumentType } from '@prisma/client';

type VerificationEntity = {
  id: string;
  userId: string;
  status: VerificationStatus;
  documentType: DocumentType;
  documentFrontUrl: string;
  documentBackUrl: string | null;
  selfieUrl: string;
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
 * Devolve os URLs dos documentos. Em produção pode interessar restringir
 * a URL do BI a apenas ADMINs (ex.: gerar signed URL com curta validade
 * apenas quando o admin abre o painel).
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
      documentFrontUrl: v.documentFrontUrl,
      documentBackUrl: v.documentBackUrl,
      selfieUrl: v.selfieUrl,
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
