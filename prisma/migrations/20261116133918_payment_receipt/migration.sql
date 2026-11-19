-- DropIndex
DROP INDEX "Payment_mpesaReference_idx";

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "payerMsisdn" TEXT,
ADD COLUMN     "receivedAmount" DECIMAL(12,2);

-- CreateIndex
-- Uma transferência M-Pesa só pode fechar um pagamento. Os pagamentos sem
-- referência (NULL) não entram na unicidade.
CREATE UNIQUE INDEX "Payment_mpesaReference_key" ON "Payment"("mpesaReference");
