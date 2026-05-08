# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

# ZUNO Backend — Contexto do Projecto

## O que é este projecto

Plataforma moçambicana de aluguer de equipamentos e prestação de serviços.
O cliente reserva equipamento, paga dentro da app (sistema de escrow/cofre digital),
e só libera o pagamento ao proprietário após confirmar a entrega em boas condições.

**Stack:** NestJS 11 + Prisma 7 + PostgreSQL + Socket.IO + Cloudinary
**Moeda:** MZN (Meticais moçambicanos)
**Pagamento:** M-Pesa (integração pendente — actualmente marcado manualmente por ADMIN)
**Prefixo global da API:** `/api/v1`
**Swagger:** disponível em `/docs` apenas em `NODE_ENV !== 'production'`

---

## Comandos comuns

### Desenvolvimento
```bash
npm run start:dev         # nest start --watch (hot reload)
npm run start:debug       # com inspector
npm run build             # nest build → dist/
npm run start:prod        # node dist/main (após build)
```

### Qualidade
```bash
npm run lint              # ESLint com --fix em src/, apps/, libs/, test/
npx eslint "{src,apps,libs,test}/**/*.ts" --max-warnings=0   # modo CI (zero warnings)
npx tsc --noEmit          # type-check sem emitir
npm run format            # prettier --write
```

### Testes
```bash
npm test                  # Jest unit tests (rootDir=src, *.spec.ts)
npm run test:watch        # modo watch
npm run test:cov          # com coverage → ../coverage
npm run test:e2e          # Jest E2E (test/*.e2e-spec.ts, maxWorkers=1, timeout 30s)

# Correr um único ficheiro de teste:
npx jest src/modules/bookings/services/bookings.service.spec.ts
# Correr um único caso (regex sobre o nome do `describe`/`it`):
npx jest -t "release payment"
```

### Prisma
```bash
npx prisma generate                    # regenerar cliente após mudar schema.prisma
npx prisma migrate dev --name <nome>   # criar migration em desenvolvimento
npx prisma migrate deploy              # aplicar migrations (CI/produção)
npx prisma studio                      # GUI da BD
npx prisma db seed                     # corre prisma/seed.ts (configurado em prisma.config.ts)
```

### E2E — pré-requisitos
- Os testes E2E exigem `DATABASE_URL_TEST` no `.env`.
- Por segurança, `test/setup-e2e.ts` recusa correr se a URL **não contiver `zuno_db_test`** no nome — evita destruir BDs reais.
- Quando `NODE_ENV === 'test'` o `ThrottlerGuard` é substituído por um noop (ver `app.module.ts`), de modo a que os testes não sejam bloqueados pelo rate limiter. Não existe flag externa de desactivação — em produção o throttle está sempre activo.
- Antes de correr E2E pela primeira vez: criar a BD de teste e aplicar migrations com `DATABASE_URL` apontando para ela.

### CI
`.github/workflows/ci.yml` corre em push/PR para `main`: `npm ci` → `prisma generate` → `tsc --noEmit` → ESLint **com `--max-warnings=0`** → `test:cov` → `build` → `prisma migrate deploy` → `test:e2e`. Lint warnings falham o CI — não introduzir.

---

## Roles do sistema

| Role     | O que pode fazer |
|----------|-----------------|
| CLIENT   | Criar reservas, pagar, confirmar entrega, abrir disputas, avaliar |
| PROVIDER | Publicar equipamentos, confirmar reservas, responder a disputas |
| ADMIN    | Aprovar equipamentos, resolver disputas, marcar pagamentos como retidos |

> **Atenção:** o enum no schema é `UserRole.PROVIDER` (renomeado a partir de `OWNER` no commit `8328a81`).
> Em texto e nas variáveis dos serviços, a palavra "owner" ainda aparece (ex. `ownerId`, `ownerPayout`, estados de disputa `AWAITING_OWNER`/`RESOLVED_OWNER`). Os valores do enum `DisputeStatus` **não** foram renomeados — referenciam-se literalmente como `AWAITING_OWNER` e `RESOLVED_OWNER`.

---

## Fluxo de pagamento (escrow) — regra crítica

Os estados do pagamento são sequenciais e nenhum pode ser saltado:

```
PENDING → HELD → RELEASED
                └→ REFUNDED
                └→ PARTIALLY_REFUNDED
```

- **PENDING** — pagamento iniciado, aguarda confirmação M-Pesa
- **HELD** — M-Pesa confirmou, dinheiro retido na plataforma (marcado pelo ADMIN manualmente)
- **RELEASED** — CLIENT confirmou entrega → dinheiro vai ao PROVIDER
- **REFUNDED** — disputa resolvida a favor do CLIENT → dinheiro devolvido
- **PARTIALLY_REFUNDED** — resolução parcial com `refundPercent`

**REGRA CENTRAL — nunca violar:**
Só o **CLIENT** (que confirma a entrega) ou o **ADMIN** podem chamar `release`.
O PROVIDER **nunca** pode liberar o seu próprio pagamento — isso quebraria o escrow.

---

## Fluxo de disputas

```
AWAITING_OWNER → UNDER_REVIEW → RESOLVED_CLIENT
                              → RESOLVED_OWNER
                              → RESOLVED_PARTIAL
```

- `create()` — CLIENT ou PROVIDER abre disputa (pagamento deve estar HELD ou RELEASED)
- `respond()` — PROVIDER ou ADMIN respondem (estado deve ser OPEN ou AWAITING_OWNER)
- `resolveClient/resolveOwner/resolvePartial()` — apenas ADMIN

---

## Aprovação de equipamentos

Todo equipamento entra com `status: PENDING_REVIEW`. Só passa a `ACTIVE`
após aprovação explícita de um ADMIN via `approve()`.
Sem aprovação não aparece na listagem pública (`findAll` filtra por `status: ACTIVE`).

---

## Platform fee

Calculada como **10%** do `rentalAmount`.
Hardcoded em `BookingsService`. Se mudar, actualizar lá.

`ownerPayout = rentalAmount - platformFee`

---

## Sistema de reviews

- **CLIENT** avalia o equipamento → `targetId = equipmentId`, `authorRole = CLIENT`
- **PROVIDER** avalia o cliente → `targetId = clientId`, `authorRole = PROVIDER`
- Unicidade: um utilizador só pode avaliar uma vez por booking (`bookingId_authorId`)
- Após create, os ratings são **recalculados atomicamente** na mesma transacção:
  - CLIENT avalia → recalcula rating do equipment E do provider
  - PROVIDER avalia → recalcula apenas rating do cliente
- Statuses avaliáveis: `COMPLETED`, `CANCELLED`

---

## Chat (WebSocket)

- Namespace: `/chat`
- Só CLIENTs iniciam conversas (via `startConversation`)
- Unicidade: uma conversa por tripla `(clientId, providerId, equipmentId)`
- Se já existe conversa, reutiliza-a em vez de criar duplicado
- Autenticação WS: token em `handshake.auth.token` ou `handshake.headers.authorization`
- REST fallback: `POST /chat/conversations/:id/messages`
- **Limitação actual:** `userSockets` em memória — não escala com múltiplas instâncias.
  Requer Redis antes de deploy horizontal.

---

## Decisões técnicas não óbvias

### Sessões de autenticação
- Access token: 15min. Refresh token: 7 dias, guardado com **hash bcrypt** na tabela `AuthSession`.
- Cada login cria uma `AuthSession`; refresh rotaciona o token.
- Multi-dispositivo: várias sessões podem coexistir. Logout revoga **só** a sessão actual.
- `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET` são exigidos via `getOrThrow` — nunca usar fallback hardcoded.

### Soft delete em equipamentos
`remove()` nunca chama `prisma.equipment.delete()`.
Faz `status = DELETED, isAvailable = false` — o registo permanece na BD para preservar histórico de bookings.

### assertAdmin vs guard
Os métodos `resolveClient`, `resolveOwner`, `resolvePartial` em `DisputesService`
e outros métodos admin usam `assertAdmin(userId)` que faz query ao banco.
Futuramente migrar para decorator que lê o role do JWT sem query extra.

### receiptNumber
Gerado em loop com até 5 tentativas para garantir unicidade.
Formato: `ZUNO-{timestamp}-{sequência}`.

### Paginação
Todos os endpoints de listagem usam `PaginationQueryDto` com `page` e `limit`.
Defaults: `page=1`, `limit=10`.

### Presenter pattern
Cada módulo tem `presenters/` com classe estática que formata dados antes de sair da API.
**Nunca devolver entidades Prisma directamente.** O `EquipmentPresenter` em particular resolve:
- `condition`: `GOOD` → `"Good"` (frontend filtra por capitalizado)
- `image`: primeira foto de `photos[]`
- `owner`: string (nome) na listagem vs objecto completo no detalhe
- `deliveryIncluded` (BD) → `deliveryAvailable` (API)

### Geolocalização
`EquipmentSortBy.NEAREST` é aceite mas faz fallback para `NEWEST` — geolocalização real é backlog.

---

## Variáveis de ambiente obrigatórias

Ver `.env.example`. As seguintes **não têm fallback** — o servidor falha no arranque:

- `JWT_ACCESS_SECRET` — `getOrThrow` em `auth.module.ts`
- `JWT_REFRESH_SECRET` — `getOrThrow` em `auth.service.ts`
- `DATABASE_URL` — exigido pelo Prisma

Outras relevantes:
- `DATABASE_URL_TEST` — usada apenas em E2E; deve conter `zuno_db_test` no nome
- `ALLOWED_ORIGINS` — CORS (lista separada por vírgula). Requests sem `origin` (apps nativas, Postman) são sempre permitidos. O mesmo valor aplica ao gateway WebSocket
- `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` — upload de fotos

---

## Rate limiting (ThrottlerModule)

Configurado globalmente em `app.module.ts`:
- **Global:** 100 requests / 60s por IP (`ttl: 60_000, limit: 100`)
- **Login:** 10 tentativas / 60s (`@Throttle()` no `auth.controller.ts`)
- **Register:** 5 tentativas / 60s (`@Throttle()` no `auth.controller.ts`)
- **`/me`:** `@SkipThrottle()` — chamado frequentemente pelo frontend
- Em testes (`NODE_ENV === 'test'`), o `ThrottlerGuard` é substituído por um noop em `app.module.ts`

---

## Estrutura de módulos

```
src/
  modules/
    auth/         → JWT, sessões, login, registo, refresh, logout
    users/        → perfil privado (getMe, updateMe) e público (getPublicProfile)
    categories/   → categorias hierárquicas de equipamentos
    equipment/    → CRUD, aprovação/rejeição, toggle disponibilidade, soft delete
    bookings/     → reservas, validação de datas, overlap, confirmação/cancelamento
    payments/     → escrow, estados do pagamento, recibos
    disputes/     → criação, resposta do provider, resolução pelo admin
    reviews/      → avaliações com recálculo atómico de ratings
    chat/         → conversas + mensagens + WebSocket em tempo real
  shared/
    db/           → PrismaService + DatabaseModule
    cloudinary/   → CloudinaryService (upload de fotos de equipamentos)
  common/
    filters/      → HttpExceptionFilter global (resposta limpa em produção)
    dto/          → PaginationQueryDto partilhado
test/
  helpers/        → auth.ts, db.ts, seed-test-data.ts (utilitários para E2E)
  setup-e2e.ts    → valida DATABASE_URL_TEST e força NODE_ENV=test
prisma/
  schema.prisma
  migrations/
  seed.ts
```

---

## Padrões estabelecidos

- Controllers têm `@ApiTags`, `@ApiOperation`, `@ApiResponse` para Swagger
- Services usam `PrismaService` injectado — nunca instanciar Prisma directamente
- Respostas seguem: `{ message: string, data: T, meta?: PaginationMeta }`
- `Presenter` formata a resposta — nunca devolver entidades Prisma directamente
- Validação de DTOs via `class-validator` com `ValidationPipe` global (`whitelist + transform + forbidNonWhitelisted`)
- Operações que tocam múltiplas tabelas usam `prisma.$transaction(...)`
- Língua das mensagens de erro: **Português**

---

## O que está em falta (backlog técnico)

1. Integração real com M-Pesa (webhook de confirmação automática → markHeld)
2. Sistema de notificações push / WebSocket events
3. Redis para sessões WebSocket (necessário antes de deploy horizontal)
4. Testes do `chat.service` e `categories.service`
5. Logs de auditoria para operações financeiras
6. Geolocalização real para `sortBy=nearest`
7. Endpoints admin de moderação de utilizadores
8. Paginação no `findMyListings`
