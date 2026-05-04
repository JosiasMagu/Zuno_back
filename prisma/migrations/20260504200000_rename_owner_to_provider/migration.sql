-- Rename enum value OWNER -> PROVIDER on UserRole
ALTER TYPE "UserRole" RENAME VALUE 'OWNER' TO 'PROVIDER';

-- Rename enum value OWNER -> PROVIDER on ReviewAuthorRole
ALTER TYPE "ReviewAuthorRole" RENAME VALUE 'OWNER' TO 'PROVIDER';