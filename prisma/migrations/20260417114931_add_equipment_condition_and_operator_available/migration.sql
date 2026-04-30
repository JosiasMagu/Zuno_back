-- CreateEnum
CREATE TYPE "EquipmentCondition" AS ENUM ('NEW', 'EXCELLENT', 'GOOD', 'USED');

-- AlterTable
ALTER TABLE "Equipment" ADD COLUMN     "condition" "EquipmentCondition" NOT NULL DEFAULT 'GOOD',
ADD COLUMN     "operatorAvailable" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Equipment_condition_idx" ON "Equipment"("condition");

-- CreateIndex
CREATE INDEX "Equipment_operatorAvailable_idx" ON "Equipment"("operatorAvailable");
