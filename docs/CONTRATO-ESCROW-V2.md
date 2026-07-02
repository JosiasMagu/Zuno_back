# Mudanças de contrato — Escrow v2 (D1/D2/D3)

> Guia para a equipa de frontend. Estas mudanças entram com a migration
> `20260702122709_escrow_two_checkpoints_ledger_payout`.
> Contexto completo: `D:\Project\ZUNO\DECISOES-FASE-0.md`.

## 1. Novo ciclo de vida do aluguer (BREAKING de semântica)

```
PENDING → CONFIRMED → [pagamento HELD] → ACTIVE → COMPLETED
                                    ↘ DISPUTED ↗
```

- `PATCH /payments/:id/release` (CLIENT confirma a entrega) agora põe a reserva
  em **ACTIVE** (antes ia direto para COMPLETED). O rental − fee é liberado ao
  provider; **o depósito continua retido**.
- **NOVO** `PATCH /bookings/:id/confirm-return` (PROVIDER/ADMIN) — o provider
  confirma a devolução em boas condições: reserva → COMPLETED e o depósito é
  devolvido ao cliente. (`PATCH /bookings/:id/complete` continua a existir como
  alias deprecado com o mesmo comportamento.)
- **NOVO** `POST /disputes/deposit-claim` (PROVIDER) — em vez de confirmar a
  devolução, o provider pode reclamar o depósito por dano, dentro de **48h após
  o endDate**. Body: `{ bookingId, description (min 20 chars), reason?, evidenceUrls? }`.
  Cria uma disputa `type: "DEPOSIT"` em `UNDER_REVIEW` e a reserva fica DISPUTED.
- **Automático (sem ação do frontend):** se o cliente não confirmar a entrega nem
  abrir disputa em 3 dias após o startDate, o sistema liberta o pagamento sozinho;
  se o provider não confirmar devolução nem reclamar em 48h após o endDate,
  o depósito devolve-se sozinho.

### Impacto nos ecrãs
- Ecrã de reserva do CLIENTE: estado ACTIVE = "aluguer em curso; depósito retido".
- Ecrã do PROVIDER: em reservas ACTIVE mostrar dois botões — "Confirmar devolução"
  (confirm-return) e "Reportar dano" (deposit-claim), com o prazo de 48h visível.
- O botão de review só faz sentido depois de COMPLETED (como antes), que agora
  só acontece na devolução.

## 2. Reviews / estados

- `BookingStatus` agora usa efetivamente `ACTIVE`. Qualquer switch/label de
  status no frontend precisa de cobrir `ACTIVE` ("Em curso").
- `Dispute` ganhou o campo **`type`**: `"PAYMENT" | "DEPOSIT"` (devolvido pelos
  presenters). Disputas de depósito são abertas pelo provider.

## 3. Pagamentos

- `Payment` ganhou **`depositStatus`**: `NONE | HELD | RETURNED | CLAIMED | SPLIT`.
  Útil para mostrar "depósito retido/devolvido/retido pelo proprietário".
- `GET /payments/me` foi corrigido (rebentava com 500 para não-admins).
- `POST /payments/booking/:id/mock-pay` **deixa de existir em produção**
  (403). Em produção o fluxo é `initiate` + confirmação do admin (mark-held)
  até o M-Pesa automático chegar. Em dev continua a funcionar.

## 4. Cancelamentos (política D2 — mostrar ao utilizador!)

- Cliente cancela **até 48h antes** do startDate → reembolso total.
- Cliente cancela **a menos de 48h** → retém-se 30% do rental (vai para o
  provider, menos fee); o resto + depósito + fee voltam ao cliente.
  A resposta do payment fica `PARTIALLY_REFUNDED` com `refundAmount` = valor devolvido.
- Provider cancela reserva confirmada → reembolso total ao cliente **+ strike
  ao provider**; 3 strikes em 90 dias = suspensão de listagens por 30 dias
  (o create de equipment/serviço devolve 403 com mensagem explicativa).
- Mostrar avisos destas regras nos diálogos de confirmação de cancelamento.

## 5. Payouts (novo recurso)

O dinheiro que sai do escrow agora é rastreado:

- `GET /payouts/me` — payouts do utilizador autenticado (provider vê os seus
  recebimentos, cliente vê reembolsos/devoluções de depósito).
  Item: `{ id, kind, amount, status, msisdn, mpesaReference, executedAt, receiptNumber, bookingId }`.
  `kind`: `PROVIDER_PAYOUT | CLIENT_REFUND | DEPOSIT_RETURN | DEPOSIT_CLAIM`.
  `status`: `PENDING | EXECUTED | FAILED`.
- `GET /payouts?status=PENDING` (ADMIN) — fila de execução.
- `PATCH /payouts/:id/execute` (ADMIN) — body `{ mpesaReference, msisdn? }`.
- `PATCH /payouts/:id/fail` (ADMIN) — body `{ reason }`.
- `PATCH /payouts/:id/retry` (ADMIN).

### Perfil
- `PATCH /users/me` aceita **`payoutMsisdn`** (número M-Pesa de recebimento,
  formato `+2588XXXXXXXX`); `GET /users/me` devolve-o. Adicionar campo ao ecrã
  de perfil — sem ele, os payouts do utilizador ficam bloqueados na execução.

## 6. Recordatório de correções de contrato pendentes no frontend
(da auditoria — ainda não feitas do lado do frontend)

1. `reviewService`: `authorRole "OWNER"` → `"PROVIDER"`.
2. `bookingService.createBooking/confirm/cancel`: desembrulhar `{ message, data }`.
3. Paginação de bookings/equipment: ler `meta.totalPages`, não o topo.
4. Filtro `deliveryIncluded` → `deliveryAvailable`.
5. Base URL hardcoded → `EXPO_PUBLIC_API_URL`.
