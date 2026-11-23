# Zuno Backend - Runbook operacional

Procedimentos comuns para operar o servico em alpha e beta.
Estado actual: alpha controlado, M-Pesa marcado manualmente por ADMIN.

---

## 1. Health checks

```bash
curl -fsS http://API_HOST/health
```

Resposta esperada (200):

```json
{ "status": "ok", "database": "ok", "uptimeSeconds": 1234, "latencyMs": 4 }
```

503 indica que a base de dados esta inacessivel. O Docker `HEALTHCHECK` ja chama
este endpoint - quando falha, o orquestrador reinicia o container.

---

## 2. Variaveis de ambiente criticas em producao

| Variavel | Falha se faltar | Notas |
|---|---|---|
| `DATABASE_URL` | sim | Postgres principal |
| `JWT_ACCESS_SECRET` | sim | 64+ chars aleatorios |
| `ALLOWED_ORIGINS` | nao (default localhost) | lista separada por virgula |
| `CLOUDINARY_*` | nao | upload de fotos. Sem isto, fotos falham |
| `SENTRY_DSN` | nao | sem DSN, nao envia erros |
| `LOG_LEVEL` | nao (default info) | debug em alpha, info em prod |
| `METRICS_TOKEN` | sim, em producao | 32+ chars aleatorios. O scraper envia-o como Bearer para ler `/metrics`. Sem ele a aplicacao nao arranca em producao |
| `PAYMENTS_MANUAL_RECEIVER_NUMBER` | sim, em producao no modo manual | o numero M-Pesa para onde os clientes pagam. A app mostra-o |
| `TRUST_PROXY_HOPS` | nao (default 0) | numero de proxies a frente da API. Atras de nginx ou de um balanceador tem de ser 1 ou mais, senao todos os clientes contam como um so IP no rate limit |
| `POSTGRES_PASSWORD` | sim, com o docker-compose | password da base que o compose cria. Sem ela o compose recusa arrancar |
| `DATABASE_POOL_MAX` e afins | nao | limites do pool de ligacoes (ver `.env.example`) |
| `NOTIFICATIONS_DRIVER` | nao | log\|silent. `log` e recusado em producao, porque escreve os codigos no log. Sem a variavel: log em development, silent nos outros. Com silent os codigos nao sao entregues, por isso a recuperacao de password e a verificacao do telefone nao funcionam ate haver fornecedor de SMS ou e-mail |

Validar antes de deploy:

```bash
test -n "$JWT_ACCESS_SECRET" && [[ ${#JWT_ACCESS_SECRET} -ge 64 ]] || echo "secret fraco"
```

---

## 3. Arrancar localmente

```bash
cp .env.example .env  # editar com valores reais
createdb zuno_db && createdb zuno_db_test
npm ci
npm run db:setup     # migrations + seed
npm run start:dev
```

API em `http://localhost:3000/api/v1`. Swagger em `/docs`.

---

## 4. Deploy via Docker

```bash
# Build da imagem local
docker build -t zuno-back:latest .

# Compose com Postgres. O .env do servidor tem de trazer POSTGRES_PASSWORD e
# as variaveis de producao da seccao 2: a API recebe-as todas por env_file.
docker compose up -d --build

# Logs
docker compose logs -f api

# Health do container
docker compose ps   # coluna STATUS deve mostrar (healthy)
```

As migrations correm no servico `migrate` do compose (`prisma migrate deploy`),
que termina antes de a API arrancar. A imagem da API nao traz o CLI do Prisma;
para as aplicar a mao: `docker compose run --rm migrate`.

O Postgres do compose nao publica porta: so responde dentro da rede do
compose. Para lhe chegar a partir do servidor:
`docker compose exec postgres psql -U zuno zuno_db`.

---

## 5. Migrations

| Operacao | Comando |
|---|---|
| Aplicar pendentes (prod) | `npx prisma migrate deploy` |
| Criar nova (dev) | `npm run prisma:migrate -- --name <nome>` |
| Status | `npx prisma migrate status` |
| Resync sem aplicar | `npx prisma generate` |

**Reverter migration:** o Prisma nao tem rollback nativo. Recuperar de backup
ou criar uma nova migration que desfaz a anterior. Em alpha, preferir testar em
staging primeiro.

---

## 6. Backup e restauro

### Backup manual

```bash
DATABASE_URL=postgres://user:pass@host:5432/zuno_db \
  scripts/backup-db.sh
```

Configurar no cron do host:

```cron
0 3 * * *  cd /opt/zuno && DATABASE_URL=... ./scripts/backup-db.sh >> /var/log/zuno-backup.log 2>&1
```

Variaveis opcionais: `BACKUP_DIR`, `BACKUP_PREFIX`, `RETENTION_DAYS` (default 14),
`S3_BUCKET` (upload via aws-cli).

### Restauro

```bash
gunzip -c backups/zuno-20260601T030000Z.dump.gz \
  | pg_restore -d "$DATABASE_URL" --clean --if-exists --no-owner
```

Reiniciar a API depois do restauro para limpar caches em memoria.

---

## 7. Logs

Logs em JSON estruturado em producao (pino). Em alpha podem ser pesquisados com:

```bash
docker compose logs api | grep '"level":50'  # erros (level 50 = ERROR)
docker compose logs api | grep '"req":'      # requests
```

Em dev sao impressos com cores via `pino-pretty`.

Campos automaticamente redactados: `authorization`, `cookie`, `password*`,
`token`, `refreshToken`, `accessToken`. Se algum campo sensivel novo for
introduzido, adicionar em `src/shared/logger/logger.module.ts`.

---

## 8. Sentry

Sem `SENTRY_DSN` o SDK fica inerte. Com DSN:

- Apenas excepcoes que resultam em status >= 500 sao enviadas.
- Drop de PII activado por defeito (`sendDefaultPii: false`).
- Para amostragem de tracing, definir `SENTRY_TRACES_SAMPLE_RATE` (0.1 = 10%).

---

## 9. Audit log financeiro

Cada operacao financeira regista uma entrada em `AuditLog`. Consultar:

```sql
-- Tudo o que um ADMIN fez no ultimo dia
SELECT action, "targetType", "targetId", amount, "createdAt"
FROM "AuditLog"
WHERE "actorId" = '<admin-id>' AND "createdAt" > NOW() - INTERVAL '1 day'
ORDER BY "createdAt" DESC;

-- Releases sem markHeld previo (anomalia)
SELECT a."targetId"
FROM "AuditLog" a
WHERE a.action = 'PAYMENT_RELEASED'
  AND NOT EXISTS (
    SELECT 1 FROM "AuditLog" b
    WHERE b."targetId" = a."targetId" AND b.action = 'PAYMENT_MARKED_HELD'
  );
```

Falhas a escrever no audit log sao logadas mas nao falham a operacao
financeira (try/catch interno em `AuditService.record`). O registo que nunca
falha sem a operacao falhar e o ledger: e escrito na mesma transaccao do
movimento, com o autor e o motivo, e a base nao deixa altera-lo (seccao 17).

---

## 10. Operacoes manuais comuns

### Promover utilizador a ADMIN

```sql
UPDATE "User" SET role = 'ADMIN' WHERE phone = '+258...';
```

Depois forcar logout das sessoes activas:

```sql
UPDATE "AuthSession" SET "revokedAt" = NOW()
WHERE "userId" = (SELECT id FROM "User" WHERE phone = '+258...');
```

### Forcar reset de password (sem SMS)

Enquanto nao houver provider real, ADMIN pode emitir e ler o codigo nos logs:

```bash
curl -X POST http://API_HOST/api/v1/auth/password/forgot \
  -H 'Content-Type: application/json' \
  -d '{"phone":"+258840000001"}'
```

E pesquisar nos logs:

```bash
docker compose logs api | grep '"purpose":"PASSWORD_RESET"' | tail -1
```

Comunicar o codigo ao utilizador por canal seguro. Codigo expira em 15 min.

### Marcar pagamento como HELD (alpha, M-Pesa manual)

ADMIN autenticado:

```bash
curl -X PATCH http://API_HOST/api/v1/payments/<paymentId>/mark-held \
  -H "Authorization: Bearer <admin-access-token>" \
  -H "Content-Type: application/json" \
  -d '{"mpesaReference":"<referencia do extracto>","receivedAmount":<total do pagamento>,"payerMsisdn":"<numero pagador>"}'
```

O valor tem de ser igual ao `totalCharged` (senao 400) e a referencia nao pode
ja estar noutro pagamento (senao 409).

Confirmar com:

```sql
SELECT id, status, "heldAt", "mpesaReference", "payerMsisdn", "receivedAmount"
FROM "Payment" WHERE id = '<paymentId>';
```

### Anular uma confirmacao dada por engano

Se o admin confirmou a entrada de dinheiro que nao entrou, ou que era de
outra reserva, a confirmacao anula-se. Nao se reembolsa: um reembolso criava
um payout de dinheiro que nunca existiu.

```bash
curl -X PATCH http://API_HOST/api/v1/payments/<paymentId>/void-hold   -H "Authorization: Bearer <TOKEN_DE_OUTRO_ADMIN>"   -H "Content-Type: application/json"   -d '{"reason":"A referencia era do pagamento da reserva seguinte."}'
```

- Tem de ser outro admin. Quem confirmou a entrada recebe 403, e quem e
  parte da reserva tambem.
- So enquanto o pagamento esta `HELD`, sem disputa aberta e sem a entrega
  confirmada (aluguer `CONFIRMED`, servico `PENDING`). Depois disso resolve-se
  pela disputa ou pelo reembolso.
- So para confirmacoes feitas a mao. O que o fornecedor confirmou entrou de
  facto na conta e devolve-se com um reembolso.
- Se a confirmacao deixou dinheiro em excesso por atribuir, resolve-se esse
  primeiro (seccao 22).

O pagamento volta a `PENDING`, a reserva ganha novo prazo de pagamento e a
referencia M-Pesa fica livre para o pagamento certo. O ledger nao se apaga:
fica a entrada errada e, ao lado, um estorno do mesmo valor (`OUTFLOW` com a
parte `REVERSAL`). A auditoria guarda `PAYMENT_HOLD_VOIDED` com quem anulou,
quem tinha confirmado, a referencia e o motivo. O cliente e o proprietario
recebem um aviso, porque o proprietario ja tinha sido informado de que podia
entregar.

---

## 11. Incidente: API caida

1. `docker compose ps` - confirmar que o container esta unhealthy.
2. `docker compose logs --tail 200 api` - procurar stack trace.
3. Se a BD esta acessivel mas a API nao arranca: ver se as migrations estao
   aplicadas (`npx prisma migrate status`).
4. Se alguma migration falhou: NAO correr `--force-reset` em producao.
   Recuperar do backup mais recente (ver seccao 6).
5. Se o problema for codigo, fazer rollback para a tag estavel anterior:

```bash
docker compose pull api && docker compose up -d
```

---

## 12. Rate limiting e throttle

Configurado em `app.module.ts`:

- Global: 100 requests / 60s por IP
- Login: 10 / 60s
- Register: 5 / 60s
- Forgot/verify: 3-5 / 60s
- `/me`: sem limite (`@SkipThrottle`)
- `/health`: sem limite

Em testes (`NODE_ENV=test`) o guard e substituido por noop. Em producao nao ha
flag para desactivar - se for preciso aumentar limites, editar o codigo e
fazer deploy.

---

## 13. Modulo de servicos: inspecao operacional

### Scheduler de expiracao

Corre a cada 5 minutos via `@nestjs/schedule` em `ServicesScheduler`:
- `ServiceQuote` em PENDING com `expiresAt < now()` -> EXPIRED.
- `ServiceRequest` em OPEN/QUOTED com `expiresAt < now()` -> EXPIRED.

Em `NODE_ENV=test` o cron e no-op para nao interferir com E2E. Em
producao single-instance e seguro; ANTES de scale horizontal, adicionar
lock (Redis SETNX ou tabela `LeaderElection`) para evitar dupla execucao.

### Inspeccionar pedidos/orcamentos em estados terminais

```sql
-- Quotes que expiraram nas ultimas 24h
SELECT id, "requestId", "providerId", "expiresAt", "updatedAt"
FROM "ServiceQuote"
WHERE status = 'EXPIRED'
  AND "updatedAt" > NOW() - INTERVAL '1 day'
ORDER BY "updatedAt" DESC;

-- Requests que ficaram OPEN sem qualquer orcamento
SELECT r.id, r."clientId", r."createdAt", r."expiresAt"
FROM "ServiceRequest" r
LEFT JOIN "ServiceQuote" q ON q."requestId" = r.id
WHERE r.status IN ('OPEN', 'EXPIRED')
  AND q.id IS NULL
ORDER BY r."createdAt" DESC
LIMIT 50;

-- Service bookings com pagamento em estado inesperado
SELECT sb.id, sb.status AS booking_status, p.status AS payment_status, p."receiptNumber"
FROM "ServiceBooking" sb
JOIN "Payment" p ON p."serviceBookingId" = sb.id
WHERE sb.status = 'IN_PROGRESS' AND p.status <> 'HELD';
```

### Reverter uma aceitacao errada via audit trail

Se um cliente aceitou um orcamento por engano e o admin precisa de
desfazer (apenas com pagamento ainda PENDING):

1. Localizar o audit log e confirmar a sequencia:

```sql
SELECT action, "actorId", "targetId", "createdAt"
FROM "AuditLog"
WHERE "targetId" = '<quoteId>'
ORDER BY "createdAt" DESC;
```

2. Validar que o pagamento ainda esta em PENDING (caso contrario, abrir
   disputa em vez de reverter):

```sql
SELECT status FROM "Payment"
WHERE "serviceBookingId" = (
  SELECT id FROM "ServiceBooking" WHERE "quoteId" = '<quoteId>'
);
```

3. Reverter em transacao:

```sql
BEGIN;
UPDATE "ServiceQuote" SET status = 'PENDING' WHERE id = '<quoteId>';
UPDATE "ServiceRequest" SET status = 'QUOTED' WHERE id = '<requestId>';
-- Apagar booking e payment criados pela aceitacao
DELETE FROM "Payment" WHERE "serviceBookingId" = '<bookingId>';
DELETE FROM "ServiceBooking" WHERE id = '<bookingId>';
-- Re-abrir outros quotes que tinham sido rejeitados automaticamente
UPDATE "ServiceQuote" SET status = 'PENDING'
WHERE "requestId" = '<requestId>' AND id <> '<quoteId>' AND status = 'REJECTED';
COMMIT;
```

Registar a operacao manualmente no audit log com motivo explicito.

---

## 14. Contactos e ownership

Preencher antes do alpha:

- Tech lead:
- DBA / on-call:
- Sentry project:
- Cloudinary owner:
- Provider de SMS futuro:

---

## 15. Reservas de equipamento: jobs e prazos

`BookingsScheduler` tem dois crons. Em `NODE_ENV=test` nao fazem nada.

- De 10 em 10 minutos: reservas PENDING ou CONFIRMED com `expiresAt` vencido e
  sem dinheiro no escrow passam a EXPIRED, e o pagamento por entrar a FAILED.
- De hora a hora: auto-release (3 dias depois do inicio do aluguer ou do
  `heldAt`, o que for mais tarde) e devolucao automatica do deposito (48 horas
  depois do `endDate` ou do `deliveryConfirmedAt`, o que for mais tarde).

Cada job trata tudo o que encontra vencido, em lotes de 50. Um item que falha
fica para a execucao seguinte e nao impede os outros. A falha fica no log
como warning. As accoes automaticas ficam em `AuditLog` com `actorId = 'system'`.

Como nos servicos, antes de scale horizontal e preciso um lock para os jobs
nao correrem em duas instancias ao mesmo tempo.

```sql
-- Reservas que expiraram nas ultimas 24h
SELECT id, "clientId", "equipmentId", "expiresAt", "cancelledAt"
FROM "Booking"
WHERE status = 'EXPIRED'
  AND "cancelledAt" > NOW() - INTERVAL '1 day'
ORDER BY "cancelledAt" DESC;

-- Reservas vivas com o prazo de pagamento vencido (o job ainda nao passou, ou falhou)
SELECT id, status, "expiresAt"
FROM "Booking"
WHERE status IN ('PENDING', 'CONFIRMED')
  AND "expiresAt" < NOW()
ORDER BY "expiresAt";

-- O que o sistema fez sozinho nas ultimas 24h
SELECT action, "targetType", "targetId", "createdAt"
FROM "AuditLog"
WHERE "actorId" = 'system'
  AND "createdAt" > NOW() - INTERVAL '1 day'
ORDER BY "createdAt" DESC;
```

---

## 16. Reservas de servico e pagamentos declarados

### Jobs

- `ServicesScheduler`, de 10 em 10 minutos: reservas de servico PENDING com
  `expiresAt` vencido e sem dinheiro no escrow passam a EXPIRED, e o pagamento
  por entrar a FAILED.
- `BookingsScheduler`, de hora a hora: o auto-release passou a incluir os
  servicos que o provider concluiu ha mais de 3 dias, sem release nem disputa.

### Confirmar pagamentos declarados

O cliente declara o pagamento na app (`PATCH /payments/:id/declare`). A
reserva fica 48 horas a espera da confirmacao. A fila do que esta por
confirmar, do mais antigo para o mais recente:

```bash
curl -s "$API/payments/admin/declared?page=1&limit=20" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Para cada linha, procurar no extracto M-Pesa a `declaredReference` vinda do
`declaredPayerMsisdn`, com o valor de `totalCharged`, e confirmar com o
`mark-held` da seccao 10. A referencia que o cliente declarou fica na
auditoria do mark-held, ao lado da que foi lida no extracto.

### Reservas que expiraram com pagamento declarado

Se ninguem confirmar dentro das 48 horas, a reserva expira. O cliente pode
ter pago: e preciso procurar a referencia no extracto e, se o dinheiro
entrou, devolve-lo por M-Pesa fora da plataforma. O pagamento ja esta FAILED
e nao pode ser retido.

```sql
-- Reservas que expiraram com um pagamento declarado (ultimos 7 dias)
SELECT a."targetType", a."targetId", a.metadata->>'declaredReference' AS referencia,
       a."createdAt"
FROM "AuditLog" a
WHERE a.action IN ('BOOKING_EXPIRED', 'SERVICE_BOOKING_EXPIRED')
  AND a.metadata->>'declaredReference' IS NOT NULL
  AND a."createdAt" > NOW() - INTERVAL '7 days'
ORDER BY a."createdAt" DESC;

-- Pagamentos declarados ha mais de 24h e ainda por confirmar
SELECT id, "receiptNumber", "totalCharged", "declaredReference", "declaredAt"
FROM "Payment"
WHERE status = 'PENDING'
  AND "declaredAt" < NOW() - INTERVAL '24 hours'
ORDER BY "declaredAt";
```

### Strikes e suspensao

Um provider que cancela um servico ja pago leva um strike
(`ProviderStrike.serviceBookingId`). Ao terceiro em 90 dias, os anuncios ficam
suspensos 30 dias: `User.listingsSuspendedUntil`, equipamentos com
`isAvailable = false` e servicos com `isActive = false`. A suspensao fica em
auditoria como `PROVIDER_LISTINGS_SUSPENDED`, com `actorId = 'system'`.

```sql
-- Providers suspensos neste momento
SELECT id, name, phone, "listingsSuspendedUntil"
FROM "User"
WHERE "listingsSuspendedUntil" > NOW()
ORDER BY "listingsSuspendedUntil";
```

---

## 17. Rede de seguranca do dinheiro

### O que a base de dados recusa

A migracao `20261116162500_money_safety_net` pos na base as regras que o
codigo ja aplicava. Quem escreve nas tabelas sem passar pelos servicos
(um script, uma sessao de psql, um caminho novo com um defeito) e recusado:

- `LedgerEntry`: so aceita INSERT, com valor positivo, e uma saida nunca
  passa o saldo do pagamento.
- `Payment`: so passa de PENDING a HELD ou FAILED, e de HELD a RELEASED,
  REFUNDED ou PARTIALLY_REFUNDED. O deposito so passa de NONE a HELD, e de
  HELD a RETURNED, CLAIMED ou SPLIT. O total cobrado e as duas partes nao
  mudam. Nao se apaga.
- `Payout`: so passa de PENDING a EXECUTED ou FAILED, e de FAILED volta a
  PENDING. So se executa com referencia, numero e autor, e depois disso nao
  muda. A
  referencia M-Pesa e unica. O valor e o destinatario nao mudam. Nao se apaga.

Quando um trigger dispara num pedido da aplicacao, a resposta e 500 e o erro
vai para o Sentry com a mensagem do trigger, que diz o pagamento e a
transicao recusada. Isso e sempre um defeito no
codigo: corrige-se o codigo, nao se desliga o trigger.

Para limpar uma base de desenvolvimento usa-se `TRUNCATE` (os triggers sao
por linha e nao disparam) ou `prisma migrate reset`.

### Reconciliacao

`ReconciliationService` confere cada pagamento contra o ledger, os payouts e
a reserva. So le. Corre de hora a hora (`ReconciliationScheduler`) e a pedido:

```bash
curl -s "$API/payments/admin/reconciliation" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

`totals` diz onde esta o dinheiro:

| Campo | O que e |
|---|---|
| `received` | tudo o que os clientes pagaram e entrou no escrow |
| `heldInEscrow` | o que ainda nao foi atribuido a ninguem (entradas menos saidas) |
| `owedInPayouts` | payouts decididos e ainda por executar |
| `paidOut` | payouts ja executados por M-Pesa |
| `platformShare` | a parte da plataforma, que fica na conta |
| `expectedInAccount` | o que devia estar na conta M-Pesa: `received` menos `paidOut` |

Comparar `expectedInAccount` com o saldo real da conta M-Pesa e a verificacao
que falta fazer a mao, enquanto o M-Pesa nao estiver integrado.

`findings` traz uma linha por divergencia, ate 200. `findingsTotal` da o total.

| `check` | O que quer dizer |
|---|---|
| `INFLOW_MISMATCH` | o ledger nao tem a entrada do valor cobrado, ou tem-na sem o dinheiro ter entrado |
| `OUTFLOW_EXCEEDS_INFLOW` | saiu mais do que entrou |
| `BALANCE_MISMATCH` | o que resta no escrow nao e o que o estado do pagamento diz |
| `CLIENT_PAYOUTS_MISMATCH`, `PROVIDER_PAYOUTS_MISMATCH` | ha saidas no ledger sem payout, ou payouts sem saida |
| `RESERVATION_STATE_MISMATCH` | a reserva esta num estado que nao combina com o do pagamento |
| `DEPOSIT_STATE_MISMATCH` | o deposito esta num estado que nao combina com o do pagamento |

Uma divergencia quer dizer que ha um defeito no codigo ou que alguem mexeu na
base a mao. O job escreve um erro no log, envia-o ao Sentry e poe a metrica
`zuno_reconciliation_findings` acima de zero. Nao corrige nada sozinho: cada
caso ve-se com o `detail`, o ledger do pagamento e a auditoria.

```sql
-- Ledger e payouts de um pagamento apontado pela reconciliacao
SELECT direction, party, amount, reason, "actorId", "createdAt"
FROM "LedgerEntry" WHERE "paymentId" = '<id>' ORDER BY "createdAt";

SELECT kind, amount, status, "mpesaReference", msisdn, "executedAt"
FROM "Payout" WHERE "paymentId" = '<id>' ORDER BY "createdAt";
```

### Metricas

`/metrics` fica na raiz e, com `METRICS_TOKEN` definido, so responde a quem o
envia:

```bash
curl -s "$HOST/metrics" -H "Authorization: Bearer $METRICS_TOKEN"
```

- `zuno_http_requests_total{method,route,status}`: contado quando a resposta
  sai, com o estado que o cliente recebeu. Inclui os 401, 403, 404 e 429. A
  etiqueta `route` e o padrao da rota. Pedidos sem rota ficam em `unmatched`.
- `zuno_reconciliation_findings`: divergencias da ultima reconciliacao. Alerta
  para qualquer valor acima de zero.
- `zuno_escrow_held_mzn` e `zuno_payouts_owed_mzn`: dinheiro no escrow e
  payouts por executar, actualizados em cada reconciliacao.
- `zuno_job_failures_total{job,scope}`: falhas dos jobs agendados. Com
  `scope="run"` falhou a execucao ou um passo inteiro. Com `scope="item"`
  falhou um item, que fica para a execucao seguinte. Cada falha sai tambem no
  log, com o contexto `Jobs`, e vai para o Sentry quando nao e um conflito
  com outro pedido nem uma regra que deixou de se cumprir.

Valores de `job`: `bookings-expire-unpaid`, `auto-release`,
`deposit-auto-return`, `disputes-response-window`, `provider-operations-poll`,
`provider-events`, `payout-dispatch`, `payment-auto-release-reminders`,
`money-reconciliation`, `services-expire-unpaid`, `services-expire-stale` e
`idempotency-purge`.

Alertas uteis: taxa de `status=~"5.."`, subida de `status="401"` ou
`status="429"` em `/api/v1/auth/login` (forca bruta),
`zuno_reconciliation_findings > 0`, qualquer subida de
`zuno_job_failures_total{scope="run"}`, e `scope="item"` a subir hora apos
hora no mesmo `job`. Este ultimo e um item que falha em todas as execucoes,
por exemplo um pagamento que nunca chega a ser libertado.

### Seguir um pedido

Cada pedido tem um id: vem no cabecalho `X-Request-Id` de todas as respostas
e no campo `requestId` do corpo dos erros. Nos logs de producao e o campo
`requestId` (e `req.id`), ao lado do `userId` de quem fez o pedido.

```bash
# Todas as linhas de log de um pedido que o utilizador reportou
grep '"requestId":"<id>"' app.log
```

Se a app ou um proxy enviarem `X-Request-Id` (8 a 64 letras, algarismos,
ponto, hifen ou sublinhado), o backend usa esse id em vez de gerar um.

### Pedidos em simultaneo e repetidos

- Dois pedidos sobre o mesmo pagamento, payout, reserva ou disputa: um ganha
  e o outro recebe 409 (pagamentos, payouts, resolucoes) ou 400 (reservas,
  orcamentos, abertura de disputa), com mensagem para tentar de novo. Um 500
  nestas rotas ja nao e esperado: e para investigar.
- Idempotencia (`POST /bookings`): a chave vale por utilizador e por caminho.
  Um pedido que morre a meio deixa a chave "em curso" durante 60 segundos.
  Depois disso a mesma chave volta a executar. As chaves fora de prazo (24
  horas) sao apagadas de hora a hora.

---

## 18. Disputas

Uma das partes abre a disputa, que fica `AWAITING_OWNER`, e a outra tem 3
dias para responder (`Dispute.responseDeadline`). Quando responde, ou quando
o prazo passa, a disputa fica `UNDER_REVIEW` e um admin decide
(`RESOLVED_CLIENT`, `RESOLVED_OWNER` ou `RESOLVED_PARTIAL`). Quem abriu pode
retira-la antes da decisao (`WITHDRAWN`). So ha uma disputa aberta por
reserva de cada vez, e o indice unico parcial `Dispute_one_open_per_payment`
garante-o ainda que o codigo falhe.

`DisputesScheduler` corre de hora a hora e passa a `UNDER_REVIEW` as disputas
a espera de resposta com o prazo vencido. Fica em auditoria como
`DISPUTE_RESPONSE_WINDOW_CLOSED`, com `actorId = 'system'`. O job nao decide
nada: ninguem ganha por a outra parte nao aparecer. Em `NODE_ENV=test` nao
corre.

### O que o admin faz

- Decidir so e possivel em `UNDER_REVIEW`. Antes disso a API responde 400.
- Se a outra parte responder por telefone ou por mensagem, o admin regista a
  resposta por ela em `PATCH /disputes/:id/respond`. Fica em auditoria com
  `onBehalfOfRespondent: true`.
- Uma disputa aberta por engano arquiva-se em `PATCH /disputes/:id/withdraw`.
  Nao move dinheiro e a reserva volta ao estado anterior.
- Numa disputa de pagamento de um aluguer, dar razao ao provider (no todo ou
  em parte) da a entrega como feita: a reserva fica ACTIVE e o deposito
  continua retido ate o provider confirmar a devolucao ou reclamar o
  deposito. O prazo de 48 horas do deposito conta da decisao quando ela e
  posterior ao fim do aluguer.
- Cada retirada faz a libertacao automatica do pagamento esperar mais 3
  dias. Um cliente que abre e retira disputas seguidas consegue assim atrasar
  o pagamento ao provider. A ultima consulta abaixo mostra esses casos, e o
  admin resolve-os a mao. Com a disputa retirada, libera o pagamento em
  `PATCH /payments/:id/release`. Com a disputa aberta e ja em analise,
  decide-a.

```bash
# Registar a resposta em nome da outra parte
curl -s -X PATCH "$API/disputes/<id>/respond" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"response": "Por telefone: diz que entregou no dia 12, as 8h."}'
```

### Consultas

```sql
-- Disputas a espera de decisao, da mais antiga para a mais recente
SELECT id, type, "paymentId", "openedBy", "respondedAt", "createdAt"
FROM "Dispute"
WHERE status = 'UNDER_REVIEW'
ORDER BY "createdAt";

-- Disputas com o prazo de resposta vencido e ainda a espera (o job nao passou, ou falhou)
SELECT id, status, "responseDeadline"
FROM "Dispute"
WHERE status IN ('OPEN', 'AWAITING_OWNER')
  AND "responseDeadline" < NOW()
ORDER BY "responseDeadline";

-- Historico das disputas de um pagamento
SELECT id, type, status, "openedBy", "createdAt", "closedAt", resolution
FROM "Dispute"
WHERE "paymentId" = '<id do pagamento>'
ORDER BY "createdAt";

-- Quem abriu e retirou mais de uma disputa no mesmo pagamento
SELECT "paymentId", "openedBy", COUNT(*) AS retiradas
FROM "Dispute"
WHERE status = 'WITHDRAWN'
GROUP BY "paymentId", "openedBy"
HAVING COUNT(*) > 1;
```

---

## 19. Moderacao dos anuncios

Um anuncio so fica publico depois de um admin o aprovar. A fila do que esta
por rever e `GET /equipment/admin/pending` e `GET /services/admin/pending`,
paginada, do mais antigo para o mais recente. Entram nela os anuncios novos e
os que voltaram a revisao: um anuncio aprovado cujo dono mudou o titulo, a
descricao, a categoria ou juntou fotos, e um anuncio rejeitado que o dono
corrigiu. Providers verificados e admins editam sem passar pela fila.

Ao rejeitar, indicar sempre o motivo. Fica no anuncio
(`rejectionReason`, `rejectedAt`), o dono ve-o na app e recebe um aviso push.
Sem motivo o dono nao sabe o que corrigir.

Um anuncio em revisao nao recebe reservas nem pedidos novos, mas o que ja
estava em curso continua. Rejeitar e a forma de tirar um anuncio do catalogo
de imediato: a partir dai as reservas pendentes ja nao se confirmam. Remover
so e possivel sem reservas em curso.

A aprovacao nao desfaz uma suspensao por strikes: o anuncio fica aprovado e
pausado ate a suspensao acabar. Suspender uma conta
(`PATCH /users/:id/suspend`) tira os anuncios dela do catalogo sem lhes mexer,
e a reactivacao devolve-os.

```sql
-- O que voltou a revisao nas ultimas 24h, com os campos que mudaram
SELECT action, "targetId", "actorId", metadata->'changed' AS mudou, "createdAt"
FROM "AuditLog"
WHERE action IN ('EQUIPMENT_SENT_TO_REVIEW', 'SERVICE_SENT_TO_REVIEW')
  AND "createdAt" > NOW() - INTERVAL '1 day'
ORDER BY "createdAt" DESC;

-- Anuncios a espera de revisao ha mais de 48 horas
SELECT 'equipamento' AS tipo, id, title, "updatedAt" FROM "Equipment"
WHERE status = 'PENDING_REVIEW' AND "updatedAt" < NOW() - INTERVAL '48 hours'
UNION ALL
SELECT 'servico', id, title, "updatedAt" FROM "Service"
WHERE status = 'PENDING_REVIEW' AND "updatedAt" < NOW() - INTERVAL '48 hours'
ORDER BY "updatedAt";

-- Anuncios publicos de contas suspensas (ja nao aparecem no catalogo)
SELECT e.id, e.title, u.name
FROM "Equipment" e JOIN "User" u ON u.id = e."ownerId"
WHERE e.status = 'ACTIVE' AND u."isActive" = false;
```

---

## 20. Avaliacoes e categorias

Cada conta tem duas notas: como provider (`User.totalRating`, `totalReviews`)
e como cliente (`User.clientRating`, `clientReviews`). No codigo, as duas
primeiras colunas chamam-se `providerRating` e `providerReviews`. As notas
sao valores derivados e refazem-se a partir da tabela `Review`. Se alguma
ficar errada, a consulta abaixo diz quais.

```sql
-- Contas cuja nota como provider nao bate com as avaliacoes
SELECT u.id, u.name, u."totalReviews" AS guardado, COALESCE(r.reviews, 0) AS real
FROM "User" u
LEFT JOIN (
  SELECT provider_id, COUNT(*)::int AS reviews FROM (
    SELECT b."ownerId" AS provider_id FROM "Review" rv
      JOIN "Booking" b ON b.id = rv."bookingId" WHERE rv."authorRole" = 'CLIENT'
    UNION ALL
    SELECT sb."providerId" FROM "Review" rv
      JOIN "ServiceBooking" sb ON sb.id = rv."serviceBookingId" WHERE rv."authorRole" = 'CLIENT'
  ) received GROUP BY provider_id
) r ON r.provider_id = u.id
WHERE u."totalReviews" <> COALESCE(r.reviews, 0);

-- Categorias desactivadas (o painel do admin tambem as mostra)
SELECT id, name, slug, kind FROM "Category" WHERE "isActive" = false ORDER BY name;

-- Subcategorias cujo tipo nao cabe no do pai (dados anteriores a regra)
SELECT c.id, c.name, c.kind, p.name AS pai, p.kind AS tipo_do_pai
FROM "Category" c JOIN "Category" p ON p.id = c."parentId"
WHERE p.kind <> 'BOTH' AND p.kind <> c.kind;
```

Uma categoria so se desactiva vazia: sem subcategorias activas, sem
equipamentos e sem servicos por remover. Reactiva-se no painel, ou com
`PATCH /categories/:id` e `{"isActive": true}`. Mudar o tipo de uma categoria
(`kind`) e recusado quando deixa de fora o que ela ja tem.

---

## 21. Chat

A app fala com o chat so pelo REST. O socket em `/chat` existe mas vem
desligado: sem `CHAT_GATEWAY_ENABLED=true` recusa todas as ligacoes. So se
liga quando a app passar a usa-lo. Ligado, cada ligacao pede um access token
de uma sessao aberta, e o logout, a troca de password e a suspensao da conta
fecham o socket na hora.

Limites por conta, definidos em `src/shared/constants/policy.ts`: 30
mensagens por minuto (REST e socket juntos) e 20 conversas novas por dia. Os
dois respondem 429. O limite de mensagens vive em memoria, por instancia: com
varias instancias o tecto real e esse valor vezes o numero delas, ate haver
Redis.

```sql
-- Contas que abriram mais conversas nas ultimas 24h
SELECT "clientId", COUNT(*) AS conversas
FROM "Conversation"
WHERE "createdAt" > NOW() - INTERVAL '1 day'
GROUP BY "clientId"
ORDER BY conversas DESC
LIMIT 20;

-- Quem mais escreveu na ultima hora
SELECT "senderId", COUNT(*) AS mensagens
FROM "Message"
WHERE "createdAt" > NOW() - INTERVAL '1 hour'
GROUP BY "senderId"
ORDER BY mensagens DESC
LIMIT 20;
```

Uma conta que usa o chat para levar clientes para fora da plataforma
suspende-se em `PATCH /users/:id/suspend`. As conversas ficam guardadas. Nao
ha filtro automatico de telefones nem de links nas mensagens.

---

## 22. Fornecedor de pagamentos

O fornecedor escolhe-se com `PAYMENTS_PROVIDER`: `manual` (o de hoje: o
cliente paga para `PAYMENTS_MANUAL_RECEIVER_NUMBER` e o admin confirma pelo
extracto), `simulator` (so desenvolvimento e testes) ou `mpesa` (o adaptador
ainda nao esta escrito e o arranque recusa-o). Em producao o arranque falha
com `simulator`, com um fornecedor automatico sem `PAYMENTS_WEBHOOK_SECRET`
(minimo 32 caracteres) e com `manual` sem `PAYMENTS_MANUAL_RECEIVER_NUMBER`.
A integracao do M-Pesa esta descrita em `docs/MPESA-INTEGRACAO.md`.

Duas variaveis mexem em quem decide as saidas. `PAYOUT_AUTO_MAX_AMOUNT`
(5000 por omissao) e o valor ate ao qual um payout sai pelo fornecedor sem
aprovacao. `MONEY_FOUR_EYES=true` impede quem confirmou a entrada de um
pagamento de aprovar ou executar as saidas dele. Com quatro olhos, o
dinheiro que um admin confirmou a mao tambem nunca sai sozinho: o payout
espera a aprovacao de outro admin, seja qual for o valor. So o dinheiro
confirmado pelo fornecedor sai sem aprovacao ate ao limite. Sempre, mesmo sem quatro
olhos: um admin nao confirma, nao reembolsa nem liberta o dinheiro de uma
reserva em que e parte, e nao aprova nem executa um payout para si proprio.

O `PaymentOperationsScheduler` corre de minuto a minuto e faz tres coisas:
pergunta ao fornecedor pelas operacoes sem resposta, trata os avisos que
ficaram por tratar e envia os payouts que podem sair sozinhos. No modo manual
nao faz nada disso. De hora a hora avisa os clientes cujo pagamento vai ser
libertado nas 24 horas seguintes, uma vez por pagamento.

A reconciliacao (`GET /payments/admin/reconciliation`) devolve, alem das
divergencias, alertas do que esta parado tempo demais. Os alertas saem no log
como aviso e na metrica `zuno_reconciliation_alerts`, por tipo. O que fazer
com cada um:

- `OPERATION_STUCK`: uma cobranca, um envio ou uma devolucao sem resposta ha
  6 horas. Ver o estado no portal do fornecedor pela referencia (`ZC`, `ZP`
  ou `ZR` seguida de 14 caracteres). Se o fornecedor a conhece, o job acaba
  por receber a resposta. Nao ha rota para fechar uma operacao a mao, e e de
  proposito: um fecho errado de um envio paga duas vezes. Um payout nesse
  estado fica `SENDING` e recusa a execucao manual.
- `PAYOUT_STALE`: um payout por executar ha 48 horas. Na fila
  (`GET /payouts?status=PENDING`), `needsApproval: true` pede
  `PATCH /payouts/:id/approve`. No modo manual, faz-se a transferencia e
  regista-se com `PATCH /payouts/:id/execute`.
- `PAYOUT_FAILED`: um payout que falhou e continua por resolver. Alerta logo,
  sem prazo, porque ha alguem a espera desse dinheiro. O motivo vem no
  detalhe. Confirma-se o numero com a pessoa, que o corrige em
  `PUT /users/me/payout-number`, e repete-se com `PATCH /payouts/:id/retry`.
  A repeticao usa o numero que a conta tem nesse momento e apaga a aprovacao
  anterior, por isso acima do limite automatico pede nova aprovacao. Antes de
  repetir, o backend pergunta ao fornecedor pelo envio que falhou. Se afinal
  saiu, responde 409 e o payout fica executado.
- `UNALLOCATED_OPEN`: dinheiro que entrou sem fechar pagamento e ninguem
  devolveu em 48 horas. Devolve-se por M-Pesa ao `payerMsisdn` e regista-se a
  referencia com `PATCH /payments/admin/unallocated/:id/returned`. Com um
  fornecedor que envia dinheiro, `POST /payments/admin/unallocated/:id/return`
  faz a devolucao.

Se o fornecedor confirmar um envio que tinha dado como falhado, o payout fica
executado por esse envio. Se nessa altura o payout ja tinha sido repetido e
enviado, o dinheiro saiu duas vezes. Fica um erro no log e no Sentry («saiu
duas vezes») e uma linha `PAYOUT_SENT` na auditoria com `paidTwice: true`.
Recuperar o valor em duplicado faz-se fora da plataforma, com a pessoa ou com
o fornecedor. A reconciliacao nao o mostra, porque so compara o ledger com os
payouts.

Uma transferencia que aparece no extracto e nao fecha nenhum pagamento (o
cliente pagou menos, ou pagou para uma reserva que ja expirou) regista-se com
`POST /payments/admin/unallocated`. Cada referencia M-Pesa conta uma vez: uma
referencia que ja fecha um pagamento ou ja esta registada e recusada com 409,
seja qual for o canal por onde chegou.

Os avisos do fornecedor ficam guardados em `ProviderEvent` antes de serem
tratados. Um aviso que falha fica com `lastError` e o job tenta outra vez, ate
20 vezes. Um 401 no endpoint dos avisos quer dizer que o segredo no cabecalho
`x-zuno-webhook-token` nao e o de `PAYMENTS_WEBHOOK_SECRET`.

```sql
-- Operacoes no fornecedor ainda sem resposta final
SELECT reference, provider, kind, status, amount, checks, "createdAt"
FROM "ProviderOperation"
WHERE status IN ('REQUESTED', 'PENDING', 'UNKNOWN')
ORDER BY "createdAt";

-- Avisos que falharam
SELECT "externalId", provider, attempts, "lastError", "receivedAt"
FROM "ProviderEvent"
WHERE "processedAt" IS NULL
ORDER BY "receivedAt";

-- Dinheiro por devolver
SELECT id, reason, amount, "payerMsisdn", "providerReference", "createdAt"
FROM "UnallocatedFunds"
WHERE status IN ('OPEN', 'RETURNING')
ORDER BY "createdAt";

-- Taxas do fornecedor, por mes
SELECT date_trunc('month', "confirmedAt") AS mes, SUM("feeAmount") AS taxas
FROM "ProviderOperation"
WHERE status = 'CONFIRMED' AND "feeAmount" IS NOT NULL
GROUP BY 1
ORDER BY 1;
```

As operacoes e o dinheiro por atribuir nao se apagam (trigger na migracao
`payment_provider_ready`), como os pagamentos e os payouts.
