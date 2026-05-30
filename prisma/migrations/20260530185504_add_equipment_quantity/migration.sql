-- AlterTable
ALTER TABLE "Equipment" ADD COLUMN     "availableQuantity" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "quantity" INTEGER NOT NULL DEFAULT 1;
