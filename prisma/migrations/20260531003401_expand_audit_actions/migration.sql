/*
  Warnings:

  - The values [SERVICE_APPROVED,SERVICE_REJECTED,USER_KYC_SUBMITTED,USER_KYC_APPROVED,USER_KYC_REJECTED,SERVICE_REMOVED,CATEGORY_CREATED,CATEGORY_UPDATED,CATEGORY_DEACTIVATED,CATEGORY_REACTIVATED] on the enum `AuditAction` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the `IdempotencyKey` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `UserVerification` table. If the table is not empty, all the data it contains will be lost.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "AuditAction_new" AS ENUM ('PAYMENT_INITIATED', 'PAYMENT_MARKED_HELD', 'PAYMENT_RELEASED', 'PAYMENT_REFUNDED', 'PAYMENT_PARTIALLY_REFUNDED', 'DISPUTE_OPENED', 'DISPUTE_RESPONDED', 'DISPUTE_RESOLVED_CLIENT', 'DISPUTE_RESOLVED_OWNER', 'DISPUTE_RESOLVED_PARTIAL', 'SERVICE_REQUEST_CREATED', 'SERVICE_QUOTE_SUBMITTED', 'SERVICE_QUOTE_ACCEPTED', 'SERVICE_BOOKING_STARTED', 'SERVICE_BOOKING_COMPLETED', 'SERVICE_BOOKING_CANCELLED', 'BOOKING_CREATED', 'BOOKING_CONFIRMED', 'BOOKING_CANCELLED', 'BOOKING_COMPLETED', 'EQUIPMENT_APPROVED', 'EQUIPMENT_REJECTED', 'EQUIPMENT_REMOVED', 'EQUIPMENT_AVAILABILITY_TOGGLED', 'USER_SUSPENDED', 'USER_REACTIVATED', 'USER_VERIFIED');
ALTER TABLE "AuditLog" ALTER COLUMN "action" TYPE "AuditAction_new" USING ("action"::text::"AuditAction_new");
ALTER TYPE "AuditAction" RENAME TO "AuditAction_old";
ALTER TYPE "AuditAction_new" RENAME TO "AuditAction";
DROP TYPE "public"."AuditAction_old";
COMMIT;

-- DropForeignKey
ALTER TABLE "UserVerification" DROP CONSTRAINT "UserVerification_userId_fkey";

-- DropTable
DROP TABLE "IdempotencyKey";

-- DropTable
DROP TABLE "UserVerification";

-- DropEnum
DROP TYPE "DocumentType";

-- DropEnum
DROP TYPE "VerificationStatus";
