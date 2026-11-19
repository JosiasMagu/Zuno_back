-- Rede de segurança do dinheiro.
--
-- Estas regras já são aplicadas pelo código da aplicação. Ficam também na
-- base de dados para valerem no dia em que um caminho novo se esqueça delas
-- ou alguém mexa nas tabelas à mão. Quando uma delas dispara, há um defeito
-- por corrigir: a aplicação responde 500 e o erro segue para o Sentry.

-- CreateIndex
-- Uma transferência M-Pesa só fecha um payout.
CREATE UNIQUE INDEX "Payout_mpesaReference_key" ON "Payout"("mpesaReference");

-- ─── Valores sempre positivos ───────────────────────────────────────────────

ALTER TABLE "LedgerEntry"
  ADD CONSTRAINT "LedgerEntry_amount_positive" CHECK ("amount" > 0);

ALTER TABLE "Payout"
  ADD CONSTRAINT "Payout_amount_positive" CHECK ("amount" > 0);

-- ─── O ledger só cresce ─────────────────────────────────────────────────────

CREATE FUNCTION zuno_ledger_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'LedgerEntry %: o ledger só aceita INSERT (% recusado)', OLD."id", TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "LedgerEntry_append_only"
  BEFORE UPDATE OR DELETE ON "LedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION zuno_ledger_is_append_only();

-- ─── Nenhuma saída acima do que entrou ──────────────────────────────────────

CREATE FUNCTION zuno_ledger_outflow_within_balance() RETURNS trigger AS $$
DECLARE
  inflow NUMERIC;
  outflow NUMERIC;
BEGIN
  IF NEW."direction" <> 'OUTFLOW' THEN
    RETURN NEW;
  END IF;

  -- Põe em fila as saídas do mesmo pagamento, para duas em simultâneo não
  -- lerem o mesmo saldo e passarem as duas.
  PERFORM 1 FROM "Payment" WHERE "id" = NEW."paymentId" FOR NO KEY UPDATE;

  SELECT COALESCE(SUM("amount") FILTER (WHERE "direction" = 'INFLOW'), 0),
         COALESCE(SUM("amount") FILTER (WHERE "direction" = 'OUTFLOW'), 0)
    INTO inflow, outflow
    FROM "LedgerEntry"
   WHERE "paymentId" = NEW."paymentId";

  IF outflow + NEW."amount" > inflow THEN
    RAISE EXCEPTION 'LedgerEntry: a saída de % excede o saldo de % do pagamento %',
      NEW."amount", inflow - outflow, NEW."paymentId"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "LedgerEntry_outflow_within_balance"
  BEFORE INSERT ON "LedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION zuno_ledger_outflow_within_balance();

-- ─── Estados do pagamento e do depósito ─────────────────────────────────────
--
-- Pagamento:  PENDING -> HELD | FAILED
--             HELD    -> RELEASED | REFUNDED | PARTIALLY_REFUNDED
-- Depósito:   NONE    -> HELD
--             HELD    -> RETURNED | CLAIMED | SPLIT
-- O total cobrado e as duas partes não mudam depois de o pagamento nascer.

CREATE FUNCTION zuno_payment_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."totalCharged" IS DISTINCT FROM OLD."totalCharged"
     OR NEW."clientId" IS DISTINCT FROM OLD."clientId"
     OR NEW."ownerId" IS DISTINCT FROM OLD."ownerId" THEN
    RAISE EXCEPTION 'Payment %: o total cobrado e as partes não mudam depois de criado', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'PENDING' AND NEW."status" IN ('HELD', 'FAILED'))
    OR (OLD."status" = 'HELD' AND NEW."status" IN ('RELEASED', 'REFUNDED', 'PARTIALLY_REFUNDED'))
  ) THEN
    RAISE EXCEPTION 'Payment %: transição de estado ilegal (% -> %)',
      OLD."id", OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."depositStatus" IS DISTINCT FROM OLD."depositStatus" AND NOT (
       (OLD."depositStatus" = 'NONE' AND NEW."depositStatus" = 'HELD')
    OR (OLD."depositStatus" = 'HELD' AND NEW."depositStatus" IN ('RETURNED', 'CLAIMED', 'SPLIT'))
  ) THEN
    RAISE EXCEPTION 'Payment %: transição ilegal do depósito (% -> %)',
      OLD."id", OLD."depositStatus", NEW."depositStatus"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Payment_guard"
  BEFORE UPDATE ON "Payment"
  FOR EACH ROW EXECUTE FUNCTION zuno_payment_guard();

-- ─── Estados do payout ──────────────────────────────────────────────────────
--
-- PENDING -> EXECUTED | FAILED      FAILED -> PENDING
-- Um payout executado já não muda, e só se executa com a referência, o
-- número de destino e quem executou. O valor, o tipo, o pagamento e o
-- destinatário não mudam depois de o payout nascer.

CREATE FUNCTION zuno_payout_guard() RETURNS trigger AS $$
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
       (OLD."status" = 'PENDING' AND NEW."status" IN ('EXECUTED', 'FAILED'))
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

CREATE TRIGGER "Payout_guard"
  BEFORE UPDATE ON "Payout"
  FOR EACH ROW EXECUTE FUNCTION zuno_payout_guard();

-- ─── Registos financeiros não se apagam ─────────────────────────────────────

CREATE FUNCTION zuno_financial_record_is_permanent() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% %: um registo financeiro não se apaga', TG_TABLE_NAME, OLD."id"
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Payment_permanent"
  BEFORE DELETE ON "Payment"
  FOR EACH ROW EXECUTE FUNCTION zuno_financial_record_is_permanent();

CREATE TRIGGER "Payout_permanent"
  BEFORE DELETE ON "Payout"
  FOR EACH ROW EXECUTE FUNCTION zuno_financial_record_is_permanent();
