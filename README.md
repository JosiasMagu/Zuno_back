# CLAUDE.md — Zuno Backend

Documento de contexto para sessões de desenvolvimento com IA.
Actualizado sempre que uma decisão arquitectural importante é tomada.


## O que é o Zuno

Marketplace de aluguer de equipamentos de construção para o mercado moçambicano.
Conecta proprietários de equipamentos (OWNER) com quem precisa de alugar (CLIENT).
Pagamento via M-Pesa com sistema de escrow (cofre digital).

**Stack:** NestJS + Prisma + PostgreSQL + Socket.io + Cloudinary


## Estrutura de módulos

```
src/
├── common/
│   ├── dto/pagination-query.dto.ts   — base para todos os DTOs paginados
│   └── filters/http-exception.filter.ts — exception filter global
├── shared/
│   ├── db/                           — PrismaService e DatabaseModule
│   └── cloudinary/                   — provider, service e module do Cloudinary
└── modules/
    ├── auth/       — JWT access + refresh token, sessões revogáveis
    ├── users/      — perfil próprio (getMe/updateMe) + perfil público
    ├── categories/ — hierarquia de categorias com slug
    ├── equipment/  — catálogo com filtros, fotos Cloudinary, approve/reject
    ├── bookings/   — reservas com detecção de conflito de datas
    ├── payments/   — escrow: initiate → held → release/refund
    ├── disputes/   — resolução: client / owner / partial
    ├── reviews/    — avaliações mútuas com recálculo automático de rating
    └── chat/       — WebSocket (Socket.io) + REST fallback
```

---

## Decisões arquitecturais importantes

### Autenticação
- Access token: 15min. Refresh token: 7 dias, armazenado em hash na tabela `AuthSession`.
- Cada login cria uma nova `AuthSession`. O refresh token é rotacionado a cada renovação.
- `JWT_ACCESS_SECRET` e `JWT_REFRESH_SECRET` são obrigatórios — o servidor recusa iniciar sem eles.
- Usar `getOrThrow` da ConfigService, nunca fallback com string hardcoded.

### Roles
- `CLIENT` — aluga equipamentos, inicia conversas, libera pagamentos.
- `OWNER` — disponibiliza equipamentos, confirma/cancela reservas.
- `ADMIN` — aprova/rejeita equipamentos, resolve disputas, faz markHeld.
- O role está no payload JWT — o `JwtStrategy.validate()` confirma que o utilizador ainda existe e está activo.

### Fluxo de pagamento (escrow)
```
CLIENT inicia booking
  → CLIENT inicia pagamento (PENDING)
  → ADMIN confirma recepção M-Pesa → markHeld (HELD)
  → CLIENT confirma recepção equipamento → release (RELEASED)
  → OWNER recebe o dinheiro

Se há problema:
  → CLIENT abre disputa
  → ADMIN resolve: RESOLVED_CLIENT (refund) | RESOLVED_OWNER (release) | RESOLVED_PARTIAL
```

**Regra crítica:** só CLIENT ou ADMIN podem liberar o pagamento.
O OWNER nunca pode liberar o seu próprio pagamento — quebraria a garantia do cofre digital.

### Equipment
- Criado pelo OWNER → status `PENDING_REVIEW`.
- ADMIN aprova → `ACTIVE` (aparece no catálogo).
- ADMIN rejeita → `REJECTED`.
- Soft delete → status `DELETED` (nunca apagar da BD — preserva histórico de bookings).
- `EquipmentSortBy.NEAREST` aceite no MVP mas usa `NEWEST` como fallback — geolocalização real é backlog.

### Presenter pattern
Cada módulo tem uma pasta `presenters/` com uma classe estática que formata os dados antes de sair da API. Nunca devolver objectos Prisma directamente. O `EquipmentPresenter` em particular resolve:
- `condition`: `GOOD` → `"Good"` (o front filtra por capitalizado)
- `image`: primeira foto do array `photos[]`
- `owner`: string com o nome (na listagem) vs objecto completo (no detalhe)
- `deliveryIncluded` (BD) → `deliveryAvailable` (API)

### Chat
- WebSocket com namespace `/chat` — autenticação JWT no handshake.
- Token enviado via `socket.handshake.auth.token` (recomendado) ou `Authorization` header.
- Uma conversa por (clientId, ownerId, equipmentId) — constraint `@@unique`.
- Se já existe conversa, `startConversation` envia a mensagem na existente em vez de criar duplicado.
- REST fallback disponível em `POST /chat/conversations/:id/messages`.

### Reviews
- CLIENT avalia equipment (targetId = equipmentId) e indirectamente o owner.
- OWNER avalia cliente (targetId = clientId).
- Uma avaliação por booking por utilizador — constraint `@@unique([bookingId, authorId])`.
- `totalRating` e `totalReviews` em `Equipment` e `User` são recalculados na mesma transacção atómica sempre que uma review é criada.

### Rate limiting
- Global: 100 requests / 60s por IP.
- `POST /auth/register`: 5 / 60s.
- `POST /auth/login`: 10 / 60s.
- Implementado via `@nestjs/throttler` com `ThrottlerGuard` global no `AppModule`.

### CORS
- Lido de `ALLOWED_ORIGINS` no `.env` (lista separada por vírgula).
- Requests sem `origin` (apps nativas, Postman) são sempre permitidos.
- O mesmo valor aplica ao gateway WebSocket do chat.

---

## Backlog pós-MVP (não bloqueiam lançamento)

- [ ] Testes automatizados (fluxo crítico: booking → pagamento → disputa)
- [ ] Integração real com M-Pesa (webhook de confirmação → markHeld automático)
- [ ] Sistema de notificações push
- [ ] Geolocalização real para `sortBy=nearest`
- [ ] Endpoints admin de moderação de utilizadores
- [ ] Paginação no `findMyListings`
- [ ] Promoções e destaques pagos

---

## Convenções de código

- Respostas sempre em `{ message, data }` ou `{ message, data, meta }` — nunca devolver objectos Prisma raw.
- Soft delete em equipment (status `DELETED`), nunca `prisma.equipment.delete()`.
- Transacções Prisma (`$transaction`) em todas as operações que tocam múltiplas tabelas.
- `getOrThrow` para variáveis de ambiente obrigatórias, `get` para opcionais com default seguro.
- Moeda: Metical (MZN). Método de pagamento: M-Pesa.
- Língua das mensagens de erro: Português.
