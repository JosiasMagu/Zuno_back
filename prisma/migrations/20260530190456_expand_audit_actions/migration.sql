-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'EQUIPMENT_APPROVED';
ALTER TYPE "AuditAction" ADD VALUE 'EQUIPMENT_REJECTED';
ALTER TYPE "AuditAction" ADD VALUE 'EQUIPMENT_REMOVED';
ALTER TYPE "AuditAction" ADD VALUE 'BOOKING_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'BOOKING_CONFIRMED';
ALTER TYPE "AuditAction" ADD VALUE 'BOOKING_CANCELLED';
ALTER TYPE "AuditAction" ADD VALUE 'SERVICE_APPROVED';
ALTER TYPE "AuditAction" ADD VALUE 'SERVICE_REJECTED';
