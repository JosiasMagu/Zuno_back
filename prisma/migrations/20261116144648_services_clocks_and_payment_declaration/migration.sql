-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'PAYMENT_DECLARED';
ALTER TYPE "AuditAction" ADD VALUE 'SERVICE_BOOKING_EXPIRED';

-- AlterEnum
ALTER TYPE "ServiceBookingStatus" ADD VALUE 'EXPIRED';

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "declaredAt" TIMESTAMP(3),
ADD COLUMN     "declaredPayerMsisdn" TEXT,
ADD COLUMN     "declaredReference" TEXT;

-- AlterTable
ALTER TABLE "ProviderStrike" ADD COLUMN     "serviceBookingId" TEXT;

-- AlterTable
ALTER TABLE "ServiceBooking" ADD COLUMN     "expiresAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "ServiceBooking_expiresAt_idx" ON "ServiceBooking"("expiresAt");

-- As reservas de serviço por pagar que já existiam passam a ter prazo: 24
-- horas depois de criadas. O job de expiração trata delas na primeira execução.
UPDATE "ServiceBooking" b
SET "expiresAt" = b."createdAt" + INTERVAL '24 hours'
WHERE b."status" = 'PENDING'
  AND NOT EXISTS (
    SELECT 1
    FROM "Payment" p
    WHERE p."serviceBookingId" = b."id"
      AND p."status" IN ('HELD', 'RELEASED')
  );
