-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('PAYMENT_INITIATED', 'PAYMENT_MARKED_HELD', 'PAYMENT_RELEASED', 'PAYMENT_REFUNDED', 'PAYMENT_PARTIALLY_REFUNDED', 'DISPUTE_OPENED', 'DISPUTE_RESPONDED', 'DISPUTE_RESOLVED_CLIENT', 'DISPUTE_RESOLVED_OWNER', 'DISPUTE_RESOLVED_PARTIAL');

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "action" "AuditAction" NOT NULL,
    "actorId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "amount" DECIMAL(12,2),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditLog_actorId_idx" ON "AuditLog"("actorId");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- CreateIndex
CREATE INDEX "AuditLog_targetType_targetId_idx" ON "AuditLog"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");
