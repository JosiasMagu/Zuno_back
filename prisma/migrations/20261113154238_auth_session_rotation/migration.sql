-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'AUTH_REFRESH_TOKEN_REUSED';

-- As sessões existentes guardavam o refresh token com bcrypt, e o formato novo
-- (token opaco, guardado em SHA-256) não as consegue validar. Ficariam na
-- tabela sem uso, por isso saem: cada utilizador volta a entrar uma vez.
DELETE FROM "AuthSession";

-- AlterTable
ALTER TABLE "AuthSession" ADD COLUMN     "previousTokenHash" TEXT,
ADD COLUMN     "rotatedAt" TIMESTAMP(3);
