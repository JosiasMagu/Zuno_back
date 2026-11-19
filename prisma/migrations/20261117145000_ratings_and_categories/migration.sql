-- Avaliações e categorias.
--
-- A nota de uma conta misturava o que os clientes disseram dos anúncios dela
-- com o que os providers disseram dela como cliente. Passam a ser duas:
-- "totalRating" e "totalReviews" ficam com a nota como provider (é a que a
-- app mostra ao lado dos anúncios), e as colunas novas guardam a nota como
-- cliente.
--
-- As notas são valores derivados das avaliações. Esta migração refá-las a
-- partir da tabela "Review": não apaga nem altera nenhuma avaliação.

ALTER TYPE "AuditAction" ADD VALUE 'CATEGORY_REACTIVATED';

ALTER TABLE "User"
  ADD COLUMN "clientRating" DECIMAL(3, 2),
  ADD COLUMN "clientReviews" INTEGER NOT NULL DEFAULT 0;

-- Nota como provider: as avaliações dos clientes aos alugueres e aos
-- serviços que a conta forneceu.
UPDATE "User" SET "totalRating" = NULL, "totalReviews" = 0;

UPDATE "User" u
SET "totalRating" = received.rating,
    "totalReviews" = received.reviews
FROM (
  SELECT provider_id,
         ROUND(AVG(rating)::numeric, 2) AS rating,
         COUNT(*)::int AS reviews
  FROM (
    SELECT b."ownerId" AS provider_id, r."rating"
    FROM "Review" r
    JOIN "Booking" b ON b."id" = r."bookingId"
    WHERE r."authorRole" = 'CLIENT'
    UNION ALL
    SELECT sb."providerId" AS provider_id, r."rating"
    FROM "Review" r
    JOIN "ServiceBooking" sb ON sb."id" = r."serviceBookingId"
    WHERE r."authorRole" = 'CLIENT'
  ) from_clients
  GROUP BY provider_id
) received
WHERE u."id" = received.provider_id;

-- Nota como cliente: as avaliações que os providers deixaram à conta.
UPDATE "User" u
SET "clientRating" = received.rating,
    "clientReviews" = received.reviews
FROM (
  SELECT r."targetId" AS client_id,
         ROUND(AVG(r."rating")::numeric, 2) AS rating,
         COUNT(*)::int AS reviews
  FROM "Review" r
  WHERE r."authorRole" = 'PROVIDER'
  GROUP BY r."targetId"
) received
WHERE u."id" = received.client_id;
