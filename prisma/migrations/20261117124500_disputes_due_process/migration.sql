-- Disputas com voz para as duas partes.
--
-- Uma reserva passa a poder ter várias disputas ao longo da vida: a do
-- pagamento, antes da entrega, e a do depósito, depois dela. Só uma pode
-- estar aberta de cada vez. A outra parte responde, com provas, dentro de um
-- prazo, e quem abriu pode retirar a disputa.

-- AlterEnum
ALTER TYPE "DisputeStatus" ADD VALUE 'WITHDRAWN';

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'DISPUTE_WITHDRAWN';
ALTER TYPE "AuditAction" ADD VALUE 'DISPUTE_RESPONSE_WINDOW_CLOSED';

-- DropIndex
-- Uma disputa por reserva e por pagamento deixa de ser regra.
DROP INDEX "Dispute_bookingId_key";
DROP INDEX "Dispute_serviceBookingId_key";
DROP INDEX "Dispute_paymentId_key";

-- AlterTable
ALTER TABLE "Dispute" ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "closedBy" TEXT,
ADD COLUMN     "respondedAt" TIMESTAMP(3),
ADD COLUMN     "respondedBy" TEXT,
ADD COLUMN     "responseEvidenceUrls" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE INDEX "Dispute_bookingId_idx" ON "Dispute"("bookingId");

-- CreateIndex
CREATE INDEX "Dispute_paymentId_idx" ON "Dispute"("paymentId");

-- Só uma disputa aberta por pagamento. O Prisma não modela índices parciais,
-- por isso fica aqui. Os estados da lista já existiam antes desta migração.
CREATE UNIQUE INDEX "Dispute_one_open_per_payment"
  ON "Dispute"("paymentId")
  WHERE "status" IN ('OPEN', 'AWAITING_OWNER', 'UNDER_REVIEW');

-- As disputas que já existiam ganham as datas novas a partir do que se sabe.
UPDATE "Dispute"
SET "closedAt" = "updatedAt"
WHERE "status" IN ('RESOLVED_CLIENT', 'RESOLVED_OWNER', 'RESOLVED_PARTIAL');

UPDATE "Dispute"
SET "respondedAt" = "updatedAt"
WHERE "ownerResponse" IS NOT NULL;
