# Zuno Backend

Marketplace de aluguer de equipamentos para o mercado mocambicano.
Conecta proprietarios de equipamentos (PROVIDER) com clientes (CLIENT). Pagamento
via M-Pesa com sistema de escrow (cofre digital): o dinheiro fica retido na
plataforma ate o cliente confirmar a entrega.

**Stack:** NestJS 11 + Prisma 7 + PostgreSQL + Socket.IO + Cloudinary
**Moeda:** MZN (Meticais)
**API:** REST sob `/api/v1` + WebSocket sob `/chat`

---

## Pre-requisitos

- Node.js 22+
- PostgreSQL 14+ (local ou container)
- Conta Cloudinary (para upload de fotos)

---

## Setup desde o zero

```bash
# 1. Instalar dependencias
npm ci

# 2. Configurar variaveis de ambiente
cp .env.example .env
# editar .env com:
#   - DATABASE_URL (BD principal)
#   - DATABASE_URL_TEST (BD de testes — DEVE conter "zuno_db_test" no nome)
#   - JWT_ACCESS_SECRET e JWT_REFRESH_SECRET (64+ chars aleatorios)
#   - credenciais Cloudinary
#   - ALLOWED_ORIGINS (origens do frontend separadas por virgula)

# 3. Criar as bases de dados em PostgreSQL
createdb zuno_db
createdb zuno_db_test

# 4. Aplicar migrations e popular com dados de teste
npm run db:setup

# 5. Arrancar o servidor em modo dev (hot reload)
npm run start:dev
```

A API fica em `http://localhost:3000/api/v1`. O Swagger em `http://localhost:3000/docs`.

---

## Comandos uteis

| Comando | O que faz |
|---|---|
| `npm run start:dev` | Servidor com watch |
| `npm run build` | Compila para `dist/` |
| `npm run start:prod` | Corre `dist/main` (precisa de build previo) |
| `npm test` | Unit tests |
| `npm run test:cov` | Unit tests com coverage |
| `npm run test:e2e` | Testes end-to-end (precisa de `DATABASE_URL_TEST`) |
| `npm run typecheck` | `tsc --noEmit` (valida tipos sem emitir) |
| `npm run lint:check` | ESLint estrito (zero warnings — modo CI) |
| `npm run lint` | ESLint com auto-fix |
| `npm run format:check` | Prettier validacao |
| `npm run prisma:migrate` | Cria migration em desenvolvimento |
| `npm run prisma:deploy` | Aplica migrations (CI/producao) |
| `npm run prisma:generate` | Regenera o Prisma Client apos mudar `schema.prisma` |
| `npm run prisma:studio` | GUI da BD |
| `npm run db:seed` | Popula com dados de teste |
| `npm run db:reset` | Drop + migrations (sem seed). Destrutivo. |
| `npm run db:setup` | `prisma:deploy` + `db:seed` (setup inicial) |

### Correr um unico teste

```bash
npx jest src/modules/bookings/services/bookings.service.spec.ts
npx jest -t "release payment"   # filtra por nome do describe/it
```

---

## Credenciais de seed

Apos `npm run db:seed`, ficam disponiveis 5 contas para teste local
(password partilhada definida em `prisma/seed.ts`):

| Telefone | Email | Role |
|---|---|---|
| `+258840000000` | `admin@zuno.co.mz` | ADMIN |
| `+258840000001` | `provider1@zuno.co.mz` | PROVIDER |
| `+258840000002` | `provider2@zuno.co.mz` | PROVIDER |
| `+258840000003` | `client1@zuno.co.mz` | CLIENT |
| `+258840000004` | `client2@zuno.co.mz` | CLIENT (nao verificado) |

---

## Endpoints principais

| Path | Auth | Descricao |
|---|---|---|
| `GET /api/v1/health` | publico | Estado do servico e da BD |
| `POST /api/v1/auth/register` | publico | Registo |
| `POST /api/v1/auth/login` | publico | Login (devolve access + refresh) |
| `POST /api/v1/auth/refresh` | refresh JWT | Rotaciona o par de tokens |
| `GET /api/v1/users/me` | access JWT | Perfil proprio |
| `GET /api/v1/equipment` | publico | Listagem de equipamentos ACTIVE |
| `POST /api/v1/equipment` | PROVIDER | Cria equipamento (entra em PENDING_REVIEW) |
| `POST /api/v1/bookings` | CLIENT | Criar reserva |
| `POST /api/v1/payments` | CLIENT | Iniciar pagamento (PENDING) |
| `PATCH /api/v1/payments/:id/release` | CLIENT ou ADMIN | Liberta o escrow (suporta ambos os tipos de booking) |
| `POST /api/v1/disputes` | CLIENT ou PROVIDER | Abrir disputa (com bookingId ou serviceBookingId) |
| `GET /api/v1/services` | publico | Listagem de servicos ACTIVE |
| `POST /api/v1/services` | PROVIDER | Cria servico (entra em PENDING_REVIEW) |
| `POST /api/v1/service-requests` | CLIENT | Pede um servico (escolhe Service-alvo) |
| `POST /api/v1/service-requests/:id/quotes` | PROVIDER | Envia orcamento |
| `PATCH /api/v1/service-quotes/:id/accept` | CLIENT | Aceita orcamento -> cria ServiceBooking + Payment(PENDING) |
| `POST /api/v1/service-photos/upload` | PROVIDER | Upload de foto para um servico (serviceId em body) |
| `POST /api/v1/service-photos/upload-multiple` | PROVIDER | Upload em batch (ate 5 fotos) |
| `PATCH /api/v1/service-photos/:photoId/set-primary` | PROVIDER | Definir foto como primaria |
| `DELETE /api/v1/service-photos/:photoId` | PROVIDER | Apagar foto |
| `PATCH /api/v1/service-bookings/:id/start` | PROVIDER | Inicia execucao (exige Payment HELD) |
| `PATCH /api/v1/service-bookings/:id/complete` | PROVIDER | Conclui execucao |
| `GET /api/v1/services/:id/reviews` | publico | Reviews de um servico |
| WebSocket `/chat` | access JWT | Chat em tempo real (equipment ou service) |

Documentacao completa: `http://localhost:3000/docs`.

---

## Arquitectura

```
src/
  modules/
    auth/         JWT, sessoes, login, registo, refresh, logout
    users/        Perfil privado (getMe, updateMe) e publico
    categories/   Categorias hierarquicas de equipamentos
    equipment/    CRUD, aprovacao, fotos via Cloudinary
    services/     Prestacao de servicos: Service + Request + Quote + Booking
    bookings/     Reservas com deteccao de overlap (Serializable)
    payments/     Escrow: PENDING -> HELD -> RELEASED|REFUNDED
    disputes/     Abertura, resposta do provider, resolucao admin
    reviews/      Avaliacoes mutuas com recalculo atomico de rating
    chat/         Conversas + mensagens + WebSocket gateway
    health/       Health check publico
  shared/
    db/           PrismaService global
    cloudinary/   CloudinaryService (upload de fotos)
  common/
    filters/      HttpExceptionFilter global
    dto/          PaginationQueryDto partilhado
test/
  helpers/        auth.ts, db.ts, seed-test-data.ts
  setup-e2e.ts    valida DATABASE_URL_TEST e forca NODE_ENV=test
```

Ver `docs/RUNBOOK.md` e `docs/SERVICES.md` para regras de negocio criticas (escrow, fluxo de disputas,
restricoes de role) e decisoes tecnicas nao obvias.

---

## Convencoes

- Respostas seguem `{ message: string, data: T, meta?: PaginationMeta }`.
- Nunca devolver entidades Prisma directamente — usar Presenters.
- Operacoes que tocam multiplas tabelas usam `prisma.$transaction(...)`.
- `getOrThrow` para variaveis de ambiente obrigatorias, `get` com default para opcionais.
- Mensagens de erro user-facing em portugues correcto (com acentos).
- Comentarios internos sem acentos.

---

## Equipa e creditos

Projecto desenvolvido em equipa (2026):

- **Josias Fernando Magumba** ([@JosiasMagu](https://github.com/JosiasMagu)) - backend principal: bookings, escrow/pagamentos, chat em tempo real, autenticacao, testes.
- [@luzartecompany-stack](https://github.com/luzartecompany-stack) - arquitectura, auditoria e metricas de negocio.
- [@biemosfm](https://github.com/biemosfm) - administracao e gestao de equipamentos.

Codigo publico para fins de portefolio e aprendizagem.
