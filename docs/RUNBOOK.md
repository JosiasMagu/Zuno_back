# Zuno Backend - Runbook operacional

Procedimentos comuns para operar o servico em alpha e beta.
Estado actual: alpha controlado, M-Pesa marcado manualmente por ADMIN.

---

## 1. Health checks

```bash
curl -fsS http://API_HOST/api/v1/health
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
| `JWT_REFRESH_SECRET` | sim | diferente do access |
| `ALLOWED_ORIGINS` | nao (default localhost) | lista separada por virgula |
| `CLOUDINARY_*` | nao | upload de fotos. Sem isto, fotos falham |
| `SENTRY_DSN` | nao | sem DSN, nao envia erros |
| `LOG_LEVEL` | nao (default info) | debug em alpha, info em prod |
| `NOTIFICATIONS_DRIVER` | nao (default log) | log\|silent\|<provider futuro> |

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

# Compose com Postgres
JWT_ACCESS_SECRET=$(openssl rand -hex 64) \
JWT_REFRESH_SECRET=$(openssl rand -hex 64) \
docker compose up -d --build

# Logs
docker compose logs -f api

# Health do container
docker compose ps   # coluna STATUS deve mostrar (healthy)
```

Migrations correm automaticamente no entrypoint (`prisma migrate deploy`).

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
SELECT action, target_type, target_id, amount, created_at
FROM "AuditLog"
WHERE actor_id = '<admin-id>' AND created_at > NOW() - INTERVAL '1 day'
ORDER BY created_at DESC;

-- Releases sem markHeld previo (anomalia)
SELECT a.target_id
FROM "AuditLog" a
WHERE a.action = 'PAYMENT_RELEASED'
  AND NOT EXISTS (
    SELECT 1 FROM "AuditLog" b
    WHERE b.target_id = a.target_id AND b.action = 'PAYMENT_MARKED_HELD'
  );
```

Falhas a escrever no audit log sao logadas mas nao falham a operacao
financeira (try/catch interno em `AuditService.record`).

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
  -H "Authorization: Bearer <admin-access-token>"
```

Confirmar com:

```sql
SELECT id, status, "heldAt" FROM "Payment" WHERE id = '<paymentId>';
```

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

## 13. Contactos e ownership

Preencher antes do alpha:

- Tech lead:
- DBA / on-call:
- Sentry project:
- Cloudinary owner:
- Provider de SMS futuro:
