-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'EQUIPMENT_AVAILABILITY_TOGGLED';
ALTER TYPE "AuditAction" ADD VALUE 'SERVICE_REMOVED';
ALTER TYPE "AuditAction" ADD VALUE 'CATEGORY_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'CATEGORY_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'CATEGORY_DEACTIVATED';
ALTER TYPE "AuditAction" ADD VALUE 'CATEGORY_REACTIVATED';
