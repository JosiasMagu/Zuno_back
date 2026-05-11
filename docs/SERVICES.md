# Módulo de Serviços (Services)

Este documento descreve o domínio de "prestação de serviços" do Zuno,
que coexiste com o módulo de aluguer de equipamento (`equipment/`) mas tem
uma semântica diferente. Aqui, o cliente **pede** um serviço, o provider
**orçamenta**, e a aceitação cria uma reserva que segue o mesmo escrow
do equipamento.

---

## Entidades do domínio

### `Service`

Anúncio de prestação de serviço criado por um PROVIDER. Equivalente conceptual
ao `Equipment`, mas o objecto não é alugado por períodos — é executado uma
única vez por pedido.

Campos relevantes:

- `pricingType: FIXED | HOURLY | QUOTE` — `FIXED` por defeito.
- `basePrice` — preço de referência exibido no catálogo.
- `acceptsUrgent: boolean` — se `true`, o provider aceita pedidos urgentes.
- `urgentSurcharge: Decimal(5,2)` — **percentagem** (ex. `30.00` = +30%)
  aplicada quando um pedido é urgente. Obrigatório se `acceptsUrgent`.
- `categoryId` — referência a `Category` cujo `kind` ∈ `{SERVICE, BOTH}`.
- `status: PENDING_REVIEW | ACTIVE | PAUSED | REJECTED | DELETED`.

### `ServiceRequest`

Pedido de execução de serviço criado por um CLIENT. Aponta para um `Service`
específico e descreve o problema/contexto.

- `isUrgent: boolean` — só pode ser `true` se `service.acceptsUrgent`.
- `address` — morada de execução.
- `expiresAt` — quando o pedido caduca se não houver aceitação (default: 7 dias).
- `status: OPEN | QUOTED | ACCEPTED | CANCELLED | EXPIRED`.

### `ServiceQuote`

Orçamento enviado por um PROVIDER em resposta a um `ServiceRequest`. **Apenas
o provider do serviço-alvo** pode orçamentar.

- `amount` — valor base proposto (MZN).
- `urgentSurcharge` — valor adicional cobrado se o pedido for urgente.
  Validado contra `service.urgentSurcharge` (percentagem).
- `totalAmount` = `amount + (urgentSurcharge ?? 0)`. **Validação estrita** em
  `validateQuoteTotals`.
- `estimatedDays` — prazo proposto.
- `expiresAt` — quando o orçamento caduca (default: 48h).
- `status: PENDING | ACCEPTED | REJECTED | WITHDRAWN | EXPIRED`.

### `ServiceBooking`

Criado automaticamente quando o CLIENT aceita um `ServiceQuote`. Liga o
quote, o request, o serviço e ambas as partes; herda os valores do quote.

- `serviceAmount` = `quote.totalAmount`.
- `platformFee` = 10% do serviceAmount (via `calculatePlatformFee` em
  `src/shared/constants/fees.ts`).
- `totalAmount` = `serviceAmount + platformFee`.
- `status: PENDING | CONFIRMED | IN_PROGRESS | COMPLETED | CANCELLED | DISPUTED`.

### `Payment` (partilhado com equipamento)

Reusa o modelo `Payment` do escrow do equipamento. Polimórfico: cada `Payment`
liga a `Booking` OU a `ServiceBooking` (CHECK XOR em SQL). Sequência de estados:

```
PENDING → HELD → RELEASED
                ↘ REFUNDED
                ↘ PARTIALLY_REFUNDED
```

A **regra de ouro mantém-se**: apenas CLIENT (que confirma a entrega/execução)
ou ADMIN podem chamar `release`. O PROVIDER **nunca** pode libertar o seu
próprio pagamento.

---

## Diagrama do ciclo de vida

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                       │
│   PROVIDER cria Service ──────► ADMIN aprova ──► Service ACTIVE       │
│                                                                       │
│   CLIENT cria ServiceRequest (OPEN)                                   │
│                       │                                               │
│                       ▼                                               │
│              PROVIDER envia ServiceQuote (PENDING)                    │
│              + Request muda para QUOTED                               │
│                       │                                               │
│                       ▼                                               │
│              CLIENT aceita (transacção Serializable)                  │
│              ─ Quote → ACCEPTED                                       │
│              ─ Outras quotes do request → REJECTED                    │
│              ─ Request → ACCEPTED                                     │
│              ─ ServiceBooking criado (PENDING)                        │
│              ─ Payment criado (PENDING)                               │
│                       │                                               │
│                       ▼                                               │
│              ADMIN marca Payment como HELD                            │
│                       │                                               │
│                       ▼                                               │
│              PROVIDER inicia execução (start)                         │
│              ServiceBooking → IN_PROGRESS                             │
│                       │                                               │
│                       ▼                                               │
│              PROVIDER conclui execução (complete)                     │
│              ServiceBooking → COMPLETED                               │
│                       │                                               │
│                       ▼                                               │
│              CLIENT liberta escrow (Payment release)                  │
│              Payment → RELEASED, ServiceBooking → COMPLETED           │
│                       │                                               │
│                       ▼                                               │
│              CLIENT avalia serviço (Review com serviceBookingId)      │
│              PROVIDER avalia cliente                                  │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Exemplo end-to-end real

**Cenário:** Maria tem um curto-circuito em casa e precisa de um electricista
com urgência. O João é um electricista registado como PROVIDER no Zuno.

### 1. Setup (uma única vez)

**João regista o seu serviço:**

```http
POST /api/v1/services
Authorization: Bearer <joao-access-token>
Content-Type: application/json

{
  "title": "Reparação eléctrica residencial",
  "description": "Diagnóstico, reparação e instalação eléctrica. Resposta rápida em Maputo.",
  "categoryId": "<id-da-categoria-Electricidade>",
  "basePrice": 5000,
  "pricingType": "FIXED",
  "location": "Maputo, Cidade",
  "acceptsUrgent": true,
  "urgentSurcharge": 30
}
```

Resposta `201`:

```json
{
  "message": "Serviço criado com sucesso. Aguarda aprovação do administrador.",
  "data": { "id": "svc-001", "status": "PENDING_REVIEW", "...": "..." }
}
```

**Admin aprova:**

```http
PATCH /api/v1/services/svc-001/approve
Authorization: Bearer <admin-access-token>
```

Serviço passa para `ACTIVE` e aparece em `GET /api/v1/services`.

### 2. Maria pede o serviço (urgente)

```http
POST /api/v1/service-requests
Authorization: Bearer <maria-access-token>
Content-Type: application/json

{
  "serviceId": "svc-001",
  "description": "Curto-circuito no quadro principal — preciso urgente.",
  "isUrgent": true,
  "address": "Av. Eduardo Mondlane, 123, Maputo"
}
```

Resposta `201` com `requestId` em `data.id`.

### 3. João envia orçamento

O serviço dele tem `urgentSurcharge: 30`. Maria pediu urgente, logo:

- `amount = 5000` MZN (preço base)
- `urgentSurcharge = 5000 * 30 / 100 = 1500` MZN
- `totalAmount = 6500` MZN

```http
POST /api/v1/service-requests/<requestId>/quotes
Authorization: Bearer <joao-access-token>
Content-Type: application/json

{
  "amount": 5000,
  "urgentSurcharge": 1500,
  "totalAmount": 6500,
  "estimatedDays": 1,
  "message": "Posso ir hoje à tarde. Inclui pequenos materiais."
}
```

Se algum dos valores não bater, a API responde `400` com a mensagem do
campo que está incorrecto.

### 4. Maria aceita o orçamento

```http
PATCH /api/v1/service-quotes/<quoteId>/accept
Authorization: Bearer <maria-access-token>
```

Resposta `200`:

```json
{
  "message": "Orçamento aceite. Reserva e pagamento criados — aguarda confirmação M-Pesa.",
  "data": {
    "quote": { "...": "...", "status": "ACCEPTED" },
    "serviceBookingId": "sb-001",
    "paymentId": "pay-001"
  }
}
```

Atomicamente (em transacção Serializable):

- O orçamento aceite → `ACCEPTED`.
- Qualquer outro orçamento PENDING do mesmo request → `REJECTED`.
- O request → `ACCEPTED`.
- Novo `ServiceBooking` em `PENDING` com:
  - `serviceAmount = 6500`
  - `platformFee = 650` (10%)
  - `totalAmount = 7150`
- Novo `Payment` em `PENDING` com `serviceBookingId = sb-001`.

### 5. M-Pesa confirma o pagamento (alpha: ADMIN marca manualmente)

```http
PATCH /api/v1/payments/pay-001/mark-held
Authorization: Bearer <admin-access-token>
```

`Payment.status = HELD`. O dinheiro está retido na plataforma.

### 6. João executa o serviço

```http
PATCH /api/v1/service-bookings/sb-001/start
Authorization: Bearer <joao-access-token>
```

Estado → `IN_PROGRESS`. Se o pagamento não estiver `HELD`, a API recusa.

Depois de terminar:

```http
PATCH /api/v1/service-bookings/sb-001/complete
Authorization: Bearer <joao-access-token>
```

Estado → `COMPLETED`. Mas o dinheiro **ainda não foi libertado**.

### 7. Maria confirma a entrega — escrow liberado

```http
PATCH /api/v1/payments/pay-001/release
Authorization: Bearer <maria-access-token>
```

`Payment.status = RELEASED`. O João recebe `6500 - 650 = 5850 MZN`
(o `ownerPayout`). A plataforma fica com `650 MZN` de fee.

Se a Maria não estiver satisfeita, abre uma **disputa** em vez de
libertar:

```http
POST /api/v1/disputes
Authorization: Bearer <maria-access-token>
Content-Type: application/json

{
  "serviceBookingId": "sb-001",
  "paymentId": "pay-001",
  "reason": "SERVICE_QUALITY_POOR",
  "description": "O problema voltou no dia seguinte."
}
```

ADMIN resolve a disputa: a favor do cliente (`REFUNDED`), do provider
(`RELEASED`) ou parcial (`PARTIALLY_REFUNDED` com `refundPercent`).

### 8. Avaliações

Após o pagamento ser `RELEASED` (ou a disputa ser resolvida com cancelamento):

```http
POST /api/v1/reviews
Authorization: Bearer <maria-access-token>
Content-Type: application/json

{
  "serviceBookingId": "sb-001",
  "authorRole": "CLIENT",
  "rating": 5,
  "comment": "Profissional excelente, resolveu em 30 minutos."
}
```

E o João avalia a Maria:

```http
POST /api/v1/reviews
Authorization: Bearer <joao-access-token>
Content-Type: application/json

{
  "serviceBookingId": "sb-001",
  "authorRole": "PROVIDER",
  "rating": 5,
  "comment": "Cliente comunicativo e pontual."
}
```

Ambas as reviews são únicas por `(serviceBookingId, authorId)` graças a
um partial unique index na BD. Após a criação, `Service.totalRating`
(quando autor=CLIENT) e `User.totalRating` (quando autor=PROVIDER) são
recalculados atomicamente na mesma transacção da review.

---

## Diferenças relativamente a equipamento

| Aspecto | Equipamento | Serviço |
|---|---|---|
| Modelo principal | `Equipment` | `Service` |
| Cliente | Reserva (Booking) por período | Pede um serviço (Request) |
| Provider | Confirma a reserva | Envia orçamento (Quote) |
| Decisão final | Provider confirma | Cliente aceita orçamento |
| Preço fixo? | `pricePerDay/Week/Month` | `basePrice` + `urgentSurcharge` |
| Garantia de overlap | Sim, datas não-overlapping (Serializable) | Não aplicável |
| Categoria | `kind ∈ {EQUIPMENT, BOTH}` | `kind ∈ {SERVICE, BOTH}` |
| Audit actions | `PAYMENT_*`, `DISPUTE_*` | + `SERVICE_REQUEST_CREATED`, `SERVICE_QUOTE_*`, `SERVICE_BOOKING_*` |

O `Payment`, `Dispute`, `Review` e `Conversation` são polimórficos: cada
linha liga a UM de equipamento OU serviço (XOR enforced via CHECK constraint).

---

## Auto-expiração

Um `ServicesScheduler` corre a cada 5 minutos:

- `ServiceQuote.status = PENDING` com `expiresAt < now()` → `EXPIRED`.
- `ServiceRequest.status ∈ {OPEN, QUOTED}` com `expiresAt < now()` → `EXPIRED`.

Em `NODE_ENV=test` o cron é no-op (não interfere com E2E).

---

## Backlog

Ver secção "O que está em falta" em `CLAUDE.md`.
