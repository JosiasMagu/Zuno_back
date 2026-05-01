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

## Roles do sistema

| Role    | O que pode fazer |
|---------|-----------------|
| CLIENT  | Criar reservas, pagar, confirmar entrega, abrir disputas, avaliar |
| OWNER   | Publicar equipamentos, confirmar reservas, responder a disputas |
| ADMIN   | Aprovar equipamentos, resolver disputas, marcar pagamentos como retidos |

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
- **RELEASED** — CLIENT confirmou entrega → dinheiro vai ao OWNER
- **REFUNDED** — disputa resolvida a favor do CLIENT → dinheiro devolvido
- **PARTIALLY_REFUNDED** — resolução parcial com `refundPercent`

**REGRA CENTRAL — nunca violar:**
Só o **CLIENT** (que confirma a entrega) ou o **ADMIN** podem chamar `release`.
O OWNER **nunca** pode liberar o seu próprio pagamento — isso quebraria o escrow.

---

## Fluxo de disputas

```
AWAITING_OWNER → UNDER_REVIEW → RESOLVED_CLIENT
                              → RESOLVED_OWNER
                              → RESOLVED_PARTIAL
```

- `create()` — CLIENT ou OWNER abre disputa (pagamento deve estar HELD ou RELEASED)
- `respond()` — OWNER ou ADMIN respondem (estado deve ser OPEN ou AWAITING_OWNER)
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
- **OWNER** avalia o cliente → `targetId = clientId`, `authorRole = OWNER`
- Unicidade: um utilizador só pode avaliar uma vez por booking (`bookingId_authorId`)
- Após create, os ratings são **recalculados atomicamente** na mesma transacção:
  - CLIENT avalia → recalcula rating do equipment E do owner
  - OWNER avalia → recalcula apenas rating do cliente
- Statuses avaliáveis: `COMPLETED`, `CANCELLED`

---

## Chat (WebSocket)

- Namespace: `/chat`
- Só CLIENTs iniciam conversas (via `startConversation`)
- Unicidade: uma conversa por tripla `(clientId, ownerId, equipmentId)`
- Se já existe conversa, reutiliza-a em vez de criar duplicado
- Autenticação WS: token em `handshake.auth.token` ou `handshake.headers.authorization`
- **Limitação actual:** `userSockets` em memória — não escala com múltiplas instâncias.
  Requer Redis antes de deploy horizontal.

---

## Decisões técnicas não óbvias

### Sessões de autenticação
Refresh tokens são guardados com **hash bcrypt** na tabela `AuthSession`.
Um utilizador pode ter múltiplas sessões activas (multi-dispositivo).
O logout revoga apenas a sessão do dispositivo actual, não todas.

### Soft delete em equipamentos
`remove()` nunca chama `prisma.equipment.delete()`.
Faz `status = DELETED, isAvailable = false` — o registo permanece na BD.

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

---

## Variáveis de ambiente obrigatórias

Ver `.env.example`. As seguintes **não têm fallback** — o servidor falha no arranque:

- `JWT_ACCESS_SECRET` — lançado por `getOrThrow` no `auth.module.ts`
- `JWT_REFRESH_SECRET` — lançado no `auth.service.ts`
- `DATABASE_URL` — lançado pelo Prisma

---

## Rate limiting (ThrottlerModule)

Configurado globalmente no `app.module.ts`:
- **Global:** 60 requests / 60s por IP
- **Login:** 10 tentativas / 60s (definido no `auth.controller.ts`)
- **Register:** 5 tentativas / 60s (definido no `auth.controller.ts`)
- **`/me`:** `@SkipThrottle()` — chamado frequentemente pelo frontend

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
    disputes/     → criação, resposta do owner, resolução pelo admin
    reviews/      → avaliações com recálculo atómico de ratings
    chat/         → conversas + mensagens + WebSocket em tempo real
  shared/
    db/           → PrismaService + DatabaseModule
    cloudinary/   → CloudinaryService (upload de fotos de equipamentos)
  common/
    filters/      → HttpExceptionFilter global (resposta limpa em produção)
    dto/          → PaginationQueryDto partilhado
```

---

## Padrões estabelecidos

- Controllers têm `@ApiTags`, `@ApiOperation`, `@ApiResponse` para Swagger
- Services usam `PrismaService` injectado — nunca instanciar Prisma directamente
- Respostas seguem: `{ message: string, data: T, meta?: PaginationMeta }`
- `Presenter` formata a resposta — nunca devolver entidades Prisma directamente
- Validação de DTOs via `class-validator` com `ValidationPipe` global (whitelist + transform)

---

## O que está em falta (backlog técnico)

1. Integração real com M-Pesa (webhook de confirmação automática)
2. Sistema de notificações push / WebSocket events
3. Redis para sessões WebSocket (necessário antes de deploy horizontal)
4. Testes do `chat.service` e `categories.service`
5. Logs de auditoria para operações financeiras
6. CI/CD pipeline
