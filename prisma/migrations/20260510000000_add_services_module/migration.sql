-- CreateEnum
CREATE TYPE "CategoryKind" AS ENUM ('EQUIPMENT', 'SERVICE', 'BOTH');

-- CreateEnum
CREATE TYPE "ServicePricingType" AS ENUM ('FIXED', 'HOURLY', 'QUOTE');

-- CreateEnum
CREATE TYPE "ServiceStatus" AS ENUM ('PENDING_REVIEW', 'ACTIVE', 'PAUSED', 'REJECTED', 'DELETED');

-- CreateEnum
CREATE TYPE "ServiceRequestStatus" AS ENUM ('OPEN', 'QUOTED', 'ACCEPTED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ServiceQuoteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ServiceBookingStatus" AS ENUM ('PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'DISPUTED');

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'SERVICE_REQUEST_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'SERVICE_QUOTE_SUBMITTED';
ALTER TYPE "AuditAction" ADD VALUE 'SERVICE_QUOTE_ACCEPTED';
ALTER TYPE "AuditAction" ADD VALUE 'SERVICE_BOOKING_STARTED';
ALTER TYPE "AuditAction" ADD VALUE 'SERVICE_BOOKING_COMPLETED';
ALTER TYPE "AuditAction" ADD VALUE 'SERVICE_BOOKING_CANCELLED';

-- AlterEnum
ALTER TYPE "DisputeReason" ADD VALUE 'SERVICE_NOT_PERFORMED';
ALTER TYPE "DisputeReason" ADD VALUE 'SERVICE_QUALITY_POOR';

-- DropForeignKey
ALTER TABLE "Conversation" DROP CONSTRAINT "Conversation_equipmentId_fkey";

-- DropForeignKey
ALTER TABLE "Dispute" DROP CONSTRAINT "Dispute_bookingId_fkey";

-- DropForeignKey
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_bookingId_fkey";

-- DropIndex
DROP INDEX "Conversation_clientId_ownerId_equipmentId_key";

-- DropIndex
DROP INDEX "Review_bookingId_authorId_key";

-- AlterTable
ALTER TABLE "Category" ADD COLUMN "kind" "CategoryKind" NOT NULL DEFAULT 'EQUIPMENT';

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "serviceId" TEXT,
ALTER COLUMN "equipmentId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Dispute" ADD COLUMN "serviceBookingId" TEXT,
ALTER COLUMN "bookingId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "serviceBookingId" TEXT,
ALTER COLUMN "bookingId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Review" ADD COLUMN "serviceBookingId" TEXT,
ALTER COLUMN "bookingId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "Service" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "basePrice" DECIMAL(12,2) NOT NULL,
    "pricingType" "ServicePricingType" NOT NULL DEFAULT 'FIXED',
    "estimatedHours" INTEGER,
    "location" TEXT NOT NULL,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "acceptsUrgent" BOOLEAN NOT NULL DEFAULT false,
    "urgentSurcharge" DECIMAL(5,2),
    "status" "ServiceStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "totalRating" DECIMAL(3,2),
    "totalReviews" INTEGER NOT NULL DEFAULT 0,
    "totalCompleted" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServicePhoto" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "publicId" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "order" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServicePhoto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceRequest" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "preferredDate" TIMESTAMP(3),
    "isUrgent" BOOLEAN NOT NULL DEFAULT false,
    "address" TEXT NOT NULL,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "status" "ServiceRequestStatus" NOT NULL DEFAULT 'OPEN',
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceQuote" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "urgentSurcharge" DECIMAL(12,2),
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "estimatedDays" INTEGER NOT NULL,
    "message" TEXT,
    "status" "ServiceQuoteStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceQuote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceBooking" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3),
    "isUrgent" BOOLEAN NOT NULL DEFAULT false,
    "serviceAmount" DECIMAL(12,2) NOT NULL,
    "platformFee" DECIMAL(12,2) NOT NULL,
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "status" "ServiceBookingStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancellationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceBooking_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Service_providerId_idx" ON "Service"("providerId");

-- CreateIndex
CREATE INDEX "Service_categoryId_idx" ON "Service"("categoryId");

-- CreateIndex
CREATE INDEX "Service_status_idx" ON "Service"("status");

-- CreateIndex
CREATE INDEX "Service_isActive_idx" ON "Service"("isActive");

-- CreateIndex
CREATE INDEX "ServicePhoto_serviceId_idx" ON "ServicePhoto"("serviceId");

-- CreateIndex
CREATE INDEX "ServiceRequest_clientId_idx" ON "ServiceRequest"("clientId");

-- CreateIndex
CREATE INDEX "ServiceRequest_serviceId_idx" ON "ServiceRequest"("serviceId");

-- CreateIndex
CREATE INDEX "ServiceRequest_status_idx" ON "ServiceRequest"("status");

-- CreateIndex
CREATE INDEX "ServiceRequest_expiresAt_idx" ON "ServiceRequest"("expiresAt");

-- CreateIndex
CREATE INDEX "ServiceQuote_requestId_idx" ON "ServiceQuote"("requestId");

-- CreateIndex
CREATE INDEX "ServiceQuote_providerId_idx" ON "ServiceQuote"("providerId");

-- CreateIndex
CREATE INDEX "ServiceQuote_status_idx" ON "ServiceQuote"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceQuote_requestId_providerId_key" ON "ServiceQuote"("requestId", "providerId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceBooking_requestId_key" ON "ServiceBooking"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceBooking_quoteId_key" ON "ServiceBooking"("quoteId");

-- CreateIndex
CREATE INDEX "ServiceBooking_clientId_idx" ON "ServiceBooking"("clientId");

-- CreateIndex
CREATE INDEX "ServiceBooking_providerId_idx" ON "ServiceBooking"("providerId");

-- CreateIndex
CREATE INDEX "ServiceBooking_serviceId_idx" ON "ServiceBooking"("serviceId");

-- CreateIndex
CREATE INDEX "ServiceBooking_status_idx" ON "ServiceBooking"("status");

-- CreateIndex
CREATE INDEX "Category_kind_idx" ON "Category"("kind");

-- CreateIndex
CREATE INDEX "Conversation_serviceId_idx" ON "Conversation"("serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "Dispute_serviceBookingId_key" ON "Dispute"("serviceBookingId");

-- CreateIndex
CREATE INDEX "Dispute_serviceBookingId_idx" ON "Dispute"("serviceBookingId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_serviceBookingId_key" ON "Payment"("serviceBookingId");

-- CreateIndex
CREATE INDEX "Payment_serviceBookingId_idx" ON "Payment"("serviceBookingId");

-- CreateIndex
CREATE INDEX "Review_serviceBookingId_idx" ON "Review"("serviceBookingId");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_serviceBookingId_fkey" FOREIGN KEY ("serviceBookingId") REFERENCES "ServiceBooking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_serviceBookingId_fkey" FOREIGN KEY ("serviceBookingId") REFERENCES "ServiceBooking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_serviceBookingId_fkey" FOREIGN KEY ("serviceBookingId") REFERENCES "ServiceBooking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "Equipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServicePhoto" ADD CONSTRAINT "ServicePhoto_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRequest" ADD CONSTRAINT "ServiceRequest_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRequest" ADD CONSTRAINT "ServiceRequest_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceQuote" ADD CONSTRAINT "ServiceQuote_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ServiceRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceQuote" ADD CONSTRAINT "ServiceQuote_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceBooking" ADD CONSTRAINT "ServiceBooking_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceBooking" ADD CONSTRAINT "ServiceBooking_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceBooking" ADD CONSTRAINT "ServiceBooking_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceBooking" ADD CONSTRAINT "ServiceBooking_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ServiceRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceBooking" ADD CONSTRAINT "ServiceBooking_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "ServiceQuote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- POLIMORFISMO: XOR check constraints + partial unique indexes
-- (não modeláveis em Prisma DSL — manter neste ficheiro e não regenerar)
-- ─────────────────────────────────────────────────────────────────────────────

-- CHECK constraint: Payment liga a exactamente um de booking/serviceBooking
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_target_xor"
  CHECK (("bookingId" IS NOT NULL AND "serviceBookingId" IS NULL)
      OR ("bookingId" IS NULL AND "serviceBookingId" IS NOT NULL));

-- CHECK constraint: Dispute liga a exactamente um de booking/serviceBooking
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_target_xor"
  CHECK (("bookingId" IS NOT NULL AND "serviceBookingId" IS NULL)
      OR ("bookingId" IS NULL AND "serviceBookingId" IS NOT NULL));

-- CHECK constraint: Review liga a exactamente um de booking/serviceBooking
ALTER TABLE "Review" ADD CONSTRAINT "Review_target_xor"
  CHECK (("bookingId" IS NOT NULL AND "serviceBookingId" IS NULL)
      OR ("bookingId" IS NULL AND "serviceBookingId" IS NOT NULL));

-- CHECK constraint: Conversation liga a exactamente um de equipment/service
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_target_xor"
  CHECK (("equipmentId" IS NOT NULL AND "serviceId" IS NULL)
      OR ("equipmentId" IS NULL AND "serviceId" IS NOT NULL));

-- Partial unique index: cada author só pode avaliar uma vez por booking de equipamento
CREATE UNIQUE INDEX "Review_bookingId_authorId_key"
  ON "Review"("bookingId", "authorId") WHERE "bookingId" IS NOT NULL;

-- Partial unique index: cada author só pode avaliar uma vez por booking de serviço
CREATE UNIQUE INDEX "Review_serviceBookingId_authorId_key"
  ON "Review"("serviceBookingId", "authorId") WHERE "serviceBookingId" IS NOT NULL;

-- Partial unique index: uma conversa por triplo (client, owner, equipment)
CREATE UNIQUE INDEX "Conversation_clientId_ownerId_equipmentId_key"
  ON "Conversation"("clientId", "ownerId", "equipmentId") WHERE "equipmentId" IS NOT NULL;

-- Partial unique index: uma conversa por triplo (client, owner, service)
CREATE UNIQUE INDEX "Conversation_clientId_ownerId_serviceId_key"
  ON "Conversation"("clientId", "ownerId", "serviceId") WHERE "serviceId" IS NOT NULL;
