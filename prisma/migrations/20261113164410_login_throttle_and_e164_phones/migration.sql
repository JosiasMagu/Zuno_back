-- CreateTable
CREATE TABLE "LoginThrottle" (
    "phone" TEXT NOT NULL,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "windowStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedUntil" TIMESTAMP(3),

    CONSTRAINT "LoginThrottle_pkey" PRIMARY KEY ("phone")
);

-- Passa para E.164 (+258841234567) os telemóveis gravados noutros formatos:
-- 841234567, 258841234567, 00258841234567, com ou sem espaços e traços.
--
-- Uma conta não é alterada quando o número normalizado já pertence a outra,
-- e quando várias contas por normalizar dão o mesmo número só a mais antiga
-- muda. As que ficam de fora são contas duplicadas da mesma pessoa, que têm
-- de ser vistas à mão. Encontram-se com:
--   SELECT id, phone FROM "User" WHERE phone !~ '^[+]2588[2-7][0-9]{7}$';
WITH candidates AS (
    SELECT DISTINCT ON (normalized) id, normalized
    FROM (
        SELECT id,
               "createdAt",
               '+258' || right(regexp_replace(phone, '[^0-9]', '', 'g'), 9) AS normalized
        FROM "User"
        WHERE phone !~ '^[+]2588[2-7][0-9]{7}$'
          AND regexp_replace(phone, '[^0-9]', '', 'g') ~ '^(00258|258)?8[2-7][0-9]{7}$'
    ) AS denormalized
    ORDER BY normalized, "createdAt"
)
UPDATE "User" AS u
SET phone = c.normalized
FROM candidates AS c
WHERE u.id = c.id
  AND NOT EXISTS (
      SELECT 1 FROM "User" AS taken WHERE taken.phone = c.normalized
  );
