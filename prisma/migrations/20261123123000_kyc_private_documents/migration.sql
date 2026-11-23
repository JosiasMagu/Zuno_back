-- Os documentos de identidade passam a ficar no armazenamento privado. A base
-- guarda o identificador de cada imagem, e o endereço gera-se a pedido, com
-- validade curta. Consultar os documentos fica em auditoria.
--
-- As colunas dos endereços antigos deixam de ser obrigatórias e de ser
-- escritas. Ficam até à migração que as remover.
-- Só acrescenta: não apaga nem altera dados existentes.

ALTER TYPE "AuditAction" ADD VALUE 'USER_KYC_DOCUMENTS_VIEWED';

ALTER TABLE "UserVerification"
  ADD COLUMN "documentFrontId" TEXT,
  ADD COLUMN "documentBackId" TEXT,
  ADD COLUMN "selfieId" TEXT,
  ALTER COLUMN "documentFrontUrl" DROP NOT NULL,
  ALTER COLUMN "selfieUrl" DROP NOT NULL;
