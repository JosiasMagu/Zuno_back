-- Anular a confirmação de entrada de um pagamento dada por engano.
--
-- O ledger continua a só crescer: a entrada errada fica, e junta-se-lhe um
-- estorno do mesmo valor (uma saída com a parte REVERSAL). O pagamento volta
-- a PENDING, e a base só aceita esse passo atrás com os campos da confirmação
-- limpos, para ele não servir para mais nada. O depósito volta a NONE no
-- mesmo passo.
-- Só acrescenta: não apaga nem altera dados existentes.

ALTER TYPE "LedgerParty" ADD VALUE 'REVERSAL';

ALTER TYPE "AuditAction" ADD VALUE 'PAYMENT_HOLD_VOIDED';

-- Pagamento:  PENDING -> HELD | FAILED
--             HELD    -> RELEASED | REFUNDED | PARTIALLY_REFUNDED
--             HELD    -> PENDING, só na anulação de uma confirmação
-- Depósito:   NONE    -> HELD
--             HELD    -> RETURNED | CLAIMED | SPLIT
--             HELD    -> NONE, só na anulação de uma confirmação

CREATE OR REPLACE FUNCTION zuno_payment_guard() RETURNS trigger AS $$
DECLARE
  hold_voided BOOLEAN;
BEGIN
  IF NEW."totalCharged" IS DISTINCT FROM OLD."totalCharged"
     OR NEW."clientId" IS DISTINCT FROM OLD."clientId"
     OR NEW."ownerId" IS DISTINCT FROM OLD."ownerId" THEN
    RAISE EXCEPTION 'Payment %: o total cobrado e as partes não mudam depois de criado', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  hold_voided := OLD."status" = 'HELD'
    AND NEW."status" = 'PENDING'
    AND NEW."heldAt" IS NULL
    AND NEW."heldById" IS NULL
    AND NEW."mpesaReference" IS NULL;

  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'PENDING' AND NEW."status" IN ('HELD', 'FAILED'))
    OR (OLD."status" = 'HELD' AND NEW."status" IN ('RELEASED', 'REFUNDED', 'PARTIALLY_REFUNDED'))
    OR hold_voided
  ) THEN
    RAISE EXCEPTION 'Payment %: transição de estado ilegal (% -> %)',
      OLD."id", OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."depositStatus" IS DISTINCT FROM OLD."depositStatus" AND NOT (
       (OLD."depositStatus" = 'NONE' AND NEW."depositStatus" = 'HELD')
    OR (OLD."depositStatus" = 'HELD' AND NEW."depositStatus" IN ('RETURNED', 'CLAIMED', 'SPLIT'))
    OR (hold_voided AND OLD."depositStatus" = 'HELD' AND NEW."depositStatus" = 'NONE')
  ) THEN
    RAISE EXCEPTION 'Payment %: transição ilegal do depósito (% -> %)',
      OLD."id", OLD."depositStatus", NEW."depositStatus"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
