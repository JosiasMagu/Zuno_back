-- AlterEnum
ALTER TYPE "BookingStatus" ADD VALUE 'EXPIRED';

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "expiresAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Booking_expiresAt_idx" ON "Booking"("expiresAt");

-- As reservas por pagar que já existiam passam a ter prazo, pela mesma regra
-- das novas: 24 horas depois de criadas, ou 2 horas antes do início do
-- aluguer se isso for mais cedo. O job de expiração trata delas na primeira
-- execução.
UPDATE "Booking" b
SET "expiresAt" = LEAST(
  b."createdAt" + INTERVAL '24 hours',
  b."startDate" - INTERVAL '2 hours'
)
WHERE b."status" IN ('PENDING', 'CONFIRMED')
  AND NOT EXISTS (
    SELECT 1
    FROM "Payment" p
    WHERE p."bookingId" = b."id"
      AND p."status" IN ('HELD', 'RELEASED')
  );
