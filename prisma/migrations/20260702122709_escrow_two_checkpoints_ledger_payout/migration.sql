-- CreateEnum
CREATE TYPE "DepositStatus" AS ENUM ('NONE', 'HELD', 'RETURNED', 'CLAIMED', 'SPLIT');

-- CreateEnum
CREATE TYPE "LedgerDirection" AS ENUM ('INFLOW', 'OUTFLOW');

-- CreateEnum
CREATE TYPE "LedgerParty" AS ENUM ('CLIENT', 'PROVIDER', 'PLATFORM');

-- CreateEnum
CREATE TYPE "PayoutKind" AS ENUM ('PROVIDER_PAYOUT', 'CLIENT_REFUND', 'DEPOSIT_RETURN', 'DEPOSIT_CLAIM');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'EXECUTED', 'FAILED');

-- CreateEnum
CREATE TYPE "DisputeType" AS ENUM ('PAYMENT', 'DEPOSIT');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('BI', 'PASSAPORTE', 'CARTA_CONDUCAO');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'PAYMENT_AUTO_RELEASED';
ALTER TYPE "AuditAction" ADD VALUE 'DEPOSIT_RETURNED';
ALTER TYPE "AuditAction" ADD VALUE 'DEPOSIT_AUTO_RETURNED';
ALTER TYPE "AuditAction" ADD VALUE 'DEPOSIT_CLAIM_OPENED';
ALTER TYPE "AuditAction" ADD VALUE 'DEPOSIT_CLAIMED';
ALTER TYPE "AuditAction" ADD VALUE 'PAYOUT_EXECUTED';
ALTER TYPE "AuditAction" ADD VALUE 'PAYOUT_FAILED';
ALTER TYPE "AuditAction" ADD VALUE 'PAYOUT_RETRIED';
ALTER TYPE "AuditAction" ADD VALUE 'PROVIDER_STRIKE_ISSUED';
ALTER TYPE "AuditAction" ADD VALUE 'PROVIDER_LISTINGS_SUSPENDED';
ALTER TYPE "AuditAction" ADD VALUE 'BOOKING_RETURN_CONFIRMED';
ALTER TYPE "AuditAction" ADD VALUE 'USER_KYC_SUBMITTED';
ALTER TYPE "AuditAction" ADD VALUE 'USER_KYC_APPROVED';
ALTER TYPE "AuditAction" ADD VALUE 'USER_KYC_REJECTED';
ALTER TYPE "AuditAction" ADD VALUE 'CATEGORY_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'CATEGORY_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'CATEGORY_DEACTIVATED';
ALTER TYPE "AuditAction" ADD VALUE 'SERVICE_APPROVED';
ALTER TYPE "AuditAction" ADD VALUE 'SERVICE_REJECTED';
ALTER TYPE "AuditAction" ADD VALUE 'SERVICE_REMOVED';

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "deliveryConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "returnConfirmedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Dispute" ADD COLUMN     "type" "DisputeType" NOT NULL DEFAULT 'PAYMENT';

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "depositStatus" "DepositStatus" NOT NULL DEFAULT 'NONE';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "listingsSuspendedUntil" TIMESTAMP(3),
ADD COLUMN     "payoutMsisdn" TEXT;

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "direction" "LedgerDirection" NOT NULL,
    "party" "LedgerParty" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payout" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "kind" "PayoutKind" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "msisdn" TEXT,
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "mpesaReference" TEXT,
    "executedById" TEXT,
    "executedAt" TIMESTAMP(3),
    "failReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderStrike" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bookingId" TEXT,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderStrike_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseStatus" INTEGER NOT NULL DEFAULT 0,
    "responseBody" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserVerification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "documentType" "DocumentType" NOT NULL,
    "documentFrontUrl" TEXT NOT NULL,
    "documentBackUrl" TEXT,
    "selfieUrl" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "rejectionReason" TEXT,

    CONSTRAINT "UserVerification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LedgerEntry_paymentId_idx" ON "LedgerEntry"("paymentId");

-- CreateIndex
CREATE INDEX "LedgerEntry_createdAt_idx" ON "LedgerEntry"("createdAt");

-- CreateIndex
CREATE INDEX "Payout_status_idx" ON "Payout"("status");

-- CreateIndex
CREATE INDEX "Payout_recipientId_idx" ON "Payout"("recipientId");

-- CreateIndex
CREATE INDEX "Payout_paymentId_idx" ON "Payout"("paymentId");

-- CreateIndex
CREATE INDEX "ProviderStrike_userId_createdAt_idx" ON "ProviderStrike"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "IdempotencyKey_expiresAt_idx" ON "IdempotencyKey"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyKey_key_userId_endpoint_key" ON "IdempotencyKey"("key", "userId", "endpoint");

-- CreateIndex
CREATE UNIQUE INDEX "UserVerification_userId_key" ON "UserVerification"("userId");

-- CreateIndex
CREATE INDEX "UserVerification_status_idx" ON "UserVerification"("status");

-- CreateIndex
CREATE INDEX "UserVerification_submittedAt_idx" ON "UserVerification"("submittedAt");

-- CreateIndex
CREATE INDEX "Payment_depositStatus_idx" ON "Payment"("depositStatus");

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderStrike" ADD CONSTRAINT "ProviderStrike_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserVerification" ADD CONSTRAINT "UserVerification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
