-- Moderação dos anúncios (equipamentos e serviços).
--
-- O motivo de uma rejeição passa a ficar no anúncio, para o dono o ver e
-- corrigir. O que volta à revisão depois de aprovado fica em auditoria.
-- Só acrescenta: não muda nem apaga dados existentes.

ALTER TYPE "AuditAction" ADD VALUE 'EQUIPMENT_SENT_TO_REVIEW';
ALTER TYPE "AuditAction" ADD VALUE 'SERVICE_SENT_TO_REVIEW';

ALTER TABLE "Equipment"
  ADD COLUMN "rejectionReason" TEXT,
  ADD COLUMN "rejectedAt" TIMESTAMP(3);

ALTER TABLE "Service"
  ADD COLUMN "rejectionReason" TEXT,
  ADD COLUMN "rejectedAt" TIMESTAMP(3);

-- O catálogo público filtra pelo estado e ordena por data ou por preço. Com
-- estes índices a página sai sem ordenar todos os anúncios activos.
CREATE INDEX "Equipment_status_createdAt_idx" ON "Equipment"("status", "createdAt");
CREATE INDEX "Equipment_status_pricePerDay_idx" ON "Equipment"("status", "pricePerDay");
CREATE INDEX "Service_status_isActive_createdAt_idx" ON "Service"("status", "isActive", "createdAt");
