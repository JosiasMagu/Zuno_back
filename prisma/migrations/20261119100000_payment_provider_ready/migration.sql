-- Preparação para um fornecedor de pagamentos automático (M-Pesa ou outro).
--
-- Cada cobrança e cada envio ficam registados como uma operação no
-- fornecedor, com a nossa referência (chave de idempotência junto dele) e a
-- dele. O dinheiro que entra sem fechar um pagamento (valor errado, excesso,
-- chegada tarde) fica à parte, à espera de ser devolvido. Os avisos do
-- fornecedor ficam guardados tal como chegaram antes de serem tratados.
-- Só acrescenta: não muda nem apaga dados existentes.

ALTER TYPE "PayoutStatus" ADD VALUE 'SENDING';

ALTER TYPE "AuditAction" ADD VALUE 'PAYMENT_COLLECTION_REQUESTED';
ALTER TYPE "AuditAction" ADD VALUE 'PAYMENT_COLLECTION_FAILED';
ALTER TYPE "AuditAction" ADD VALUE 'PAYMENT_UNALLOCATED_RECEIVED';
ALTER TYPE "AuditAction" ADD VALUE 'PAYMENT_UNALLOCATED_RETURNED';
ALTER TYPE "AuditAction" ADD VALUE 'PAYOUT_APPROVED';
ALTER TYPE "AuditAction" ADD VALUE 'PAYOUT_SENT';

CREATE TYPE "ProviderOperationKind" AS ENUM ('COLLECTION', 'PAYOUT', 'RETURN');
CREATE TYPE "ProviderOperationStatus" AS ENUM ('REQUESTED', 'PENDING', 'CONFIRMED', 'FAILED', 'UNKNOWN');
CREATE TYPE "UnallocatedReason" AS ENUM ('AMOUNT_MISMATCH', 'OVERPAYMENT', 'LATE', 'UNKNOWN_REFERENCE');
CREATE TYPE "UnallocatedStatus" AS ENUM ('OPEN', 'RETURNING', 'RETURNED');

-- Quem deu o dinheiro como entrado (um admin, ou 'system' quando foi o
-- fornecedor a confirmar), e quando o cliente foi avisado da libertação
-- automática que se aproxima.
ALTER TABLE "Payment"
  ADD COLUMN "heldById" TEXT,
  ADD COLUMN "autoReleaseReminderAt" TIMESTAMP(3);

-- Aprovação de um payout acima do valor que sai sozinho.
ALTER TABLE "Payout"
  ADD COLUMN "approvedById" TEXT,
  ADD COLUMN "approvedAt" TIMESTAMP(3);

CREATE TABLE "UnallocatedFunds" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerReference" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "payerMsisdn" TEXT,
    "paymentId" TEXT,
    "reason" "UnallocatedReason" NOT NULL,
    "status" "UnallocatedStatus" NOT NULL DEFAULT 'OPEN',
    "note" TEXT,
    "recordedById" TEXT NOT NULL,
    "returnReference" TEXT,
    "returnedById" TEXT,
    "returnedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UnallocatedFunds_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "UnallocatedFunds_amount_positive" CHECK ("amount" > 0)
);

CREATE UNIQUE INDEX "UnallocatedFunds_provider_providerReference_key" ON "UnallocatedFunds"("provider", "providerReference");
CREATE UNIQUE INDEX "UnallocatedFunds_returnReference_key" ON "UnallocatedFunds"("returnReference");
CREATE INDEX "UnallocatedFunds_status_idx" ON "UnallocatedFunds"("status");
CREATE INDEX "UnallocatedFunds_paymentId_idx" ON "UnallocatedFunds"("paymentId");

ALTER TABLE "UnallocatedFunds" ADD CONSTRAINT "UnallocatedFunds_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ProviderOperation" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "kind" "ProviderOperationKind" NOT NULL,
    "reference" TEXT NOT NULL,
    "providerReference" TEXT,
    "paymentId" TEXT,
    "payoutId" TEXT,
    "unallocatedId" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "msisdn" TEXT,
    "status" "ProviderOperationStatus" NOT NULL DEFAULT 'REQUESTED',
    "failureCode" TEXT,
    "failureReason" TEXT,
    "feeAmount" DECIMAL(12,2),
    "checks" INTEGER NOT NULL DEFAULT 0,
    "lastCheckedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "response" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderOperation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProviderOperation_amount_positive" CHECK ("amount" > 0)
);

CREATE UNIQUE INDEX "ProviderOperation_reference_key" ON "ProviderOperation"("reference");
-- Uma transacção do fornecedor só fecha uma operação.
CREATE UNIQUE INDEX "ProviderOperation_provider_providerReference_key" ON "ProviderOperation"("provider", "providerReference") WHERE ("providerReference" IS NOT NULL);
-- Uma só cobrança em curso por pagamento, e um só envio em curso por payout.
CREATE UNIQUE INDEX "ProviderOperation_one_active_collection" ON "ProviderOperation"("paymentId") WHERE ("kind" = 'COLLECTION' AND "status" IN ('REQUESTED', 'PENDING', 'UNKNOWN'));
CREATE UNIQUE INDEX "ProviderOperation_one_active_payout" ON "ProviderOperation"("payoutId") WHERE ("kind" = 'PAYOUT' AND "status" IN ('REQUESTED', 'PENDING', 'UNKNOWN'));
CREATE INDEX "ProviderOperation_status_updatedAt_idx" ON "ProviderOperation"("status", "updatedAt");
CREATE INDEX "ProviderOperation_paymentId_idx" ON "ProviderOperation"("paymentId");
CREATE INDEX "ProviderOperation_payoutId_idx" ON "ProviderOperation"("payoutId");

ALTER TABLE "ProviderOperation" ADD CONSTRAINT "ProviderOperation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProviderOperation" ADD CONSTRAINT "ProviderOperation_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "Payout"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProviderOperation" ADD CONSTRAINT "ProviderOperation_unallocatedId_fkey" FOREIGN KEY ("unallocatedId") REFERENCES "UnallocatedFunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ProviderEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,

    CONSTRAINT "ProviderEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProviderEvent_provider_externalId_key" ON "ProviderEvent"("provider", "externalId");
CREATE INDEX "ProviderEvent_processedAt_idx" ON "ProviderEvent"("processedAt");

-- ─── Estados do payout ──────────────────────────────────────────────────────
--
-- PENDING -> EXECUTED | FAILED | SENDING     SENDING -> EXECUTED | FAILED
-- FAILED -> PENDING
-- SENDING é o envio pelo fornecedor em curso: o payout fica reservado e não
-- se pode executar à mão nem enviar outra vez enquanto não houver resposta.

CREATE OR REPLACE FUNCTION zuno_payout_guard() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'EXECUTED' THEN
    RAISE EXCEPTION 'Payout %: um payout executado já não muda', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."amount" IS DISTINCT FROM OLD."amount"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."paymentId" IS DISTINCT FROM OLD."paymentId"
     OR NEW."recipientId" IS DISTINCT FROM OLD."recipientId" THEN
    RAISE EXCEPTION 'Payout %: o valor, o tipo, o pagamento e o destinatário não mudam depois de criado', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'PENDING' AND NEW."status" IN ('EXECUTED', 'FAILED', 'SENDING'))
    OR (OLD."status" = 'SENDING' AND NEW."status" IN ('EXECUTED', 'FAILED'))
    OR (OLD."status" = 'FAILED' AND NEW."status" = 'PENDING')
  ) THEN
    RAISE EXCEPTION 'Payout %: transição de estado ilegal (% -> %)',
      OLD."id", OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."status" = 'EXECUTED' AND (
       NEW."mpesaReference" IS NULL
    OR NEW."msisdn" IS NULL
    OR NEW."executedById" IS NULL
  ) THEN
    RAISE EXCEPTION 'Payout %: só se executa com referência, número de destino e autor', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- As operações no fornecedor e o dinheiro por atribuir são registos
-- financeiros: não se apagam, como os pagamentos e os payouts.
CREATE TRIGGER "ProviderOperation_permanent"
  BEFORE DELETE ON "ProviderOperation"
  FOR EACH ROW EXECUTE FUNCTION zuno_financial_record_is_permanent();

CREATE TRIGGER "UnallocatedFunds_permanent"
  BEFORE DELETE ON "UnallocatedFunds"
  FOR EACH ROW EXECUTE FUNCTION zuno_financial_record_is_permanent();
