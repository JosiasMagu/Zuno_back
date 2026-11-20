# Mudanças de contrato — Escrow v2 (D1/D2/D3)

> Guia para a equipa de frontend. Estas mudanças entram com a migration
> `20260702122709_escrow_two_checkpoints_ledger_payout`.
> Contexto completo: `D:\Project\ZUNO\DECISOES-FASE-0.md`.
>
> O que a app tem hoje e o que lhe falta está na secção 15. As notas «Na app»
> das secções 8 a 14 descrevem uma adaptação que não está no repositório da
> app: existe como patch sobre o commit `75209c6`, e a equipa de frontend
> decide se a aproveita.

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
- `PUT /users/me/payout-number` com `{ payoutMsisdn, currentPassword }` define o
  número M-Pesa de recebimento. Aceita `841234567`, `258841234567` ou
  `+258841234567` e guarda sempre `+2588XXXXXXXX`. Responde 200 com
  `{ message, data }`, em que `data` é o perfil.
- A rota exige a password actual da conta. Com a password errada responde 400
  com `errorCode: AUTH_WRONG_CURRENT_PASSWORD` (a sessão continua válida). Ao
  fim de 5 erros em 15 minutos responde 429 durante 15 minutos, e o login do
  número fica bloqueado pelo mesmo tempo.
- `PATCH /users/me` deixou de aceitar `payoutMsisdn` e responde 400 se o campo
  for enviado. `GET /users/me` continua a devolvê-lo.
- O número fica gravado em cada payout no momento em que este é criado. Mudar
  o número só vale para os payouts seguintes. Sem número de recebimento, o
  payout usa o telefone da conta.
- Cada mudança fica em auditoria e o dono recebe um push com os últimos 4
  dígitos do número novo (`data.type = payout_number_changed`).

## 6. Recordatório de correções de contrato pendentes no frontend
(da auditoria — ainda não feitas do lado do frontend)

1. `reviewService`: `authorRole "OWNER"` → `"PROVIDER"`.
2. `bookingService.createBooking/confirm/cancel`: desembrulhar `{ message, data }`.
3. Paginação de bookings/equipment: ler `meta.totalPages`, não o topo.
4. Filtro `deliveryIncluded` → `deliveryAvailable`.
5. Base URL hardcoded → `EXPO_PUBLIC_API_URL`.

Desde 2026-11-20 o backend aceita os itens 1 e 4, e o item 3 na lista de
equipamentos (secção 15). Os itens 2 e 5 continuam por fazer na app.

## 7. Reservas e disponibilidade (lote 4)

### Cancelamento e reembolso
- A partir do `startDate`, com o pagamento `HELD`, o cliente já não cancela:
  `PATCH /bookings/:id/cancel` responde 400 com
  `errorCode: BOOKING_RENTAL_STARTED`. Nessa altura o cliente confirma a
  entrega ou abre uma disputa. O ecrã da reserva deve esconder o botão de
  cancelar e mostrar o de disputa.
- Sem pagamento retido (reserva por pagar), o cliente continua a poder cancelar.
- O provider e o admin continuam a poder cancelar, com reembolso total.
- `PATCH /payments/:id/refund` num pagamento `PENDING` cancela a reserva e
  deixa o pagamento `FAILED`, sem `refundAmount` nem `refundedAt`. Antes
  ficava `REFUNDED` com o valor total.

### Disponibilidade pelas datas
- `availableQuantity` passou a ser calculado: são as unidades livres hoje
  (`quantity` menos as reservas que ocupam o dia de hoje). Já não é um
  contador que desce em cada confirmação.
- Uma reserva ocupa uma unidade de `startDate` a `endDate` enquanto estiver
  `PENDING`, `CONFIRMED`, `ACTIVE` ou `DISPUTED`. Uma unidade entregue e ainda
  não devolvida conta como ocupada hoje, mesmo depois do `endDate`.
- `POST /bookings` aceita qualquer período em que haja uma unidade livre,
  mesmo com `availableQuantity` a 0. Por isso a app não deve desactivar o
  botão de reservar quando `availableQuantity` é 0.
- `isAvailable` é só a pausa do anúncio (pelo provider, ou pela suspensão por
  strikes). As reservas deixaram de o alterar. Com `isAvailable: false`,
  `POST /bookings` responde 400.
- `GET /equipment?availableFrom=&availableTo=` conta o período em dias
  inteiros, como as reservas, e devolve os equipamentos com pelo menos uma
  unidade livre nesse período.
- `GET /equipment?onlyAvailableNow=true` devolve os anúncios não pausados com
  pelo menos uma unidade livre hoje.
- Um provider suspenso recebe 403 ao tentar reactivar um anúncio
  (`PATCH /equipment/:id/toggle-availability`, ou `availableNow: true` no
  `PATCH /equipment/:id`). O admin pode reactivar por ele.

### Prazos
- Cada reserva tem prazo de pagamento em `expiresAt`: 24 horas depois de
  criada, ou 2 horas antes do dia do início se isso for mais cedo, e nunca
  menos de 2 horas. Passa a `null` quando o pagamento entra no escrow.
- Passado o prazo sem pagamento, a reserva fica `EXPIRED` (estado novo), o
  pagamento por entrar fica `FAILED`, as datas ficam livres e o cliente recebe
  um push. O job corre de 10 em 10 minutos.
- Uma reserva não pode ter mais de 90 dias: `POST /bookings` responde 400.
- As respostas das reservas passam a trazer `expiresAt`,
  `deliveryConfirmedAt` e `returnConfirmedAt`.
- O auto-release acontece 3 dias depois do início do aluguer ou da entrada do
  dinheiro no escrow, o que for mais tarde.
- A janela de 48 horas para reclamar o depósito conta do `endDate` ou do
  `deliveryConfirmedAt`, o que for mais tarde. A devolução automática do
  depósito segue a mesma conta.

### Entrada do dinheiro
- `PATCH /payments/:id/mark-held` (admin) passou a exigir o que se lê no
  extracto M-Pesa: `{ mpesaReference, receivedAmount, payerMsisdn }`.
- `receivedAmount` tem de ser o `totalCharged` do pagamento. Com outro valor
  responde 400 com `errorCode: PAYMENT_AMOUNT_MISMATCH` e nada entra no escrow.
- Uma referência M-Pesa só fecha um pagamento. Repetida, responde 409 com
  `errorCode: PAYMENT_REFERENCE_ALREADY_USED`.
- A app ainda não tem ecrã para isto. A função está em
  `services/paymentService.ts` (`markPaymentHeld`).

### Dois pedidos ao mesmo tempo
- Quando dois pedidos mexem no mesmo pagamento ou na mesma reserva ao mesmo
  tempo, um ganha e o outro recebe um erro com mensagem para tentar de novo:
  409 no mark-held, no release e no refund; 400 no cancelamento, na
  confirmação da devolução e na abertura de disputa. Antes podia sair um 500.
- A app deve mostrar a mensagem e voltar a ler a reserva antes de repetir.

## 8. Serviços e pagamento declarado (lote 5)

### Quem pode fazer o quê
- O que cada conta pode fazer decide-se pela posição que tem em cada
  transacção, e não pelo papel da conta. Quem publica um serviço passa a
  `PROVIDER` nesse momento, e orçamenta os pedidos feitos aos seus serviços.
- Um provider que aluga equipamento a outro provider confirma a entrega e
  liberta o pagamento como qualquer cliente. Quem recebe o pagamento continua
  a não o poder libertar.

### Pagamento declarado
- `PATCH /payments/:id/declare` com `{ mpesaReference, payerMsisdn }`: quem
  fez a reserva diz que já pagou. Não move dinheiro. A reserva deixa de
  expirar por falta de pagamento e fica 48 horas à espera de o admin
  confirmar no extracto. Serve para alugueres e para serviços.
- A resposta traz `declaredAt`, `declaredReference` e `confirmBy` (até quando
  a reserva espera). As listagens de pagamentos trazem `declaredAt`.
- Declarar outra vez corrige a referência e não estica o prazo.
- Só declara quem paga aquela reserva: 403 para o provider e para o admin.
  400 quando o pagamento já foi confirmado ou a reserva já não espera
  pagamento.
- Passadas as 48 horas sem confirmação, a reserva expira com o motivo
  «A reserva expirou porque o pagamento declarado não foi confirmado a tempo.»
  e o cliente recebe um push a pedir que contacte o suporte se pagou.
- `GET /payments/admin/declared` (admin): fila dos pagamentos declarados por
  confirmar, do mais antigo para o mais recente, com a referência, o número
  pagador, o telefone do cliente e `confirmBy`.
- Na app: `declarePayment` e `getDeclaredPayments` em
  `services/paymentService.ts`. Ainda não há ecrã.

### Reservas de serviço
- `PATCH /service-quotes/:id/accept` devolve também `payBy`: a reserva tem
  24 horas para ser paga. Passado o prazo sem pagamento fica `EXPIRED`
  (estado novo) e o pagamento `FAILED`.
- As respostas das reservas de serviço passam a trazer `expiresAt`,
  `autoReleaseAt` e `payment.declaredAt`. `scheduledFor` traz a data que o
  cliente indicou no pedido, só como informação.
- A aceitação é recusada com 400 quando o orçamento ou o pedido expirou, o
  serviço saiu do catálogo ou o provider está suspenso.
- Depois de o provider dar o serviço por concluído, o cliente tem 3 dias
  para libertar o pagamento ou abrir disputa. Sem resposta, o pagamento é
  libertado ao provider. `autoReleaseAt` diz quando.

### Cancelar uma reserva de serviço
`PATCH /service-bookings/:id/cancel` passou a fechar o pagamento na mesma
operação.

| Situação | Cliente | Provider | Admin |
|---|---|---|---|
| Por pagar | cancela, pagamento `FAILED` | igual | igual |
| Paga, por começar | reembolso total | reembolso total e strike | reembolso total |
| Em execução | 400 `SERVICE_BOOKING_IN_PROGRESS` | reembolso total e strike | reembolso total |
| Concluída, em disputa, expirada | 400 | 400 | 400 |

- Com o serviço em execução, o ecrã do cliente deve esconder o cancelamento
  e mostrar a disputa.
- O reembolso devolve tudo o que o cliente pagou, taxa incluída.
- Ao terceiro strike em 90 dias, os anúncios do provider ficam suspensos 30
  dias: os equipamentos e também os serviços ficam em pausa, e
  `PATCH /services/:id/toggle-availability` responde 403 até a suspensão
  acabar.
- Na app: `services/serviceBookingService.ts`. Ainda não há ecrãs para as
  reservas de serviço.

### Avaliações
- Só se avalia uma reserva que chegou a ser paga (aluguer ou serviço).
  `POST /reviews` responde 400 e os dois `can-review` respondem
  `canReview: false` com o motivo «A reserva não chegou a ser paga.».

### Avisos push novos
- Pagamento confirmado: ao cliente e ao provider (`data.type` é `booking`
  ou `serviceBooking`).
- Reservas de serviço (`data.type: 'serviceBooking'`, com `serviceBookingId`):
  orçamento aceite (ao provider), serviço iniciado e serviço concluído (ao
  cliente), reserva cancelada (à outra parte) e reserva expirada (às duas).

### Dois pedidos ao mesmo tempo
- Nos orçamentos e nas reservas de serviço, quem perde a corrida recebe 400
  com mensagem para actualizar e tentar de novo. Antes podia sair um 500 ou
  ficar uma reserva cancelada com o dinheiro retido.

## 9. Rede de segurança (lote 6)

### Erros
- O corpo de todos os erros passa a trazer `requestId`, e todas as respostas
  trazem o cabeçalho `X-Request-Id` com o mesmo valor. É o que o suporte
  precisa para encontrar o pedido nos logs. A app pode mostrá-lo nos ecrãs de
  erro. Na camada de serviço, `ApiError` passou a ter `errorCode` e
  `requestId`.
- Quem perde uma corrida numa resolução de disputa ou num payout recebe 409
  com `errorCode: CONFLICT`. Antes podia sair um 500.

### Payouts (admin)
- `PATCH /payouts/:id/execute`: a referência M-Pesa tem de ter entre 6 e 40
  letras ou algarismos, e o `msisdn`, quando enviado, tem de ser um telemóvel
  moçambicano. Fica guardado em `+258…`.
- Uma referência M-Pesa só fecha um payout. Repetida, responde 409 com
  `errorCode: PAYOUT_REFERENCE_ALREADY_USED`.
- Enviar o dinheiro para um número diferente do registado continua possível
  e fica em auditoria.

### Reconciliação (admin)
- `GET /payments/admin/reconciliation` devolve quanto dinheiro está no escrow,
  quanto falta pagar, quanto devia estar na conta M-Pesa e cada pagamento que
  não bate certo. Só lê.
- Na app: `getReconciliation` em `services/paymentService.ts`. Ainda não há
  ecrã.

### Valores e datas
- A taxa e os arredondamentos fazem-se em decimal, com o meio cêntimo a
  subir. A app deve mostrar os valores que o servidor devolve e não refazer
  a conta: em preços com cêntimos, uma conta em vírgula flutuante pode
  diferir um cêntimo.
- O dia de uma reserva conta-se na hora de Moçambique, seja qual for o fuso
  do servidor. A app pode continuar a enviar um instante qualquer do dia
  escolhido: `startDate` e `endDate` voltam como a meia-noite de Maputo
  desse dia (22:00 UTC da véspera).

### Idempotência
- A chave do `POST /bookings` vale por utilizador e por caminho. A resposta
  de um pedido repetido é a guardada, sem criar outra reserva.
- 409 `IDEMPOTENCY_KEY_REUSED` quer dizer que o primeiro pedido ainda corre:
  a app espera um instante e repete com a mesma chave.

## 10. Disputas (lote 8)

### Uma disputa aberta de cada vez
- Uma reserva pode ter várias disputas ao longo da vida, mas só uma aberta
  de cada vez. Abrir outra enquanto há uma aberta responde 400 com
  `Já existe uma disputa aberta nesta reserva.`
- O caso comum de duas disputas na mesma reserva: o admin dá razão ao
  provider numa disputa de pagamento, o aluguer segue, e no fim o provider
  reclama o depósito por dano.
- `GET /payments/:id` devolve em `dispute` a disputa mais recente do
  pagamento (`id` e `status`), aberta ou já fechada.

### Resposta da outra parte
- `PATCH /disputes/:id/respond` com `{ response, evidenceUrls? }`. Responde a
  parte da reserva que não abriu a disputa: o provider quando abriu o
  cliente, o cliente quando o provider reclama o depósito. Deixou de depender
  do `role`. Quem abriu e quem está fora da reserva recebem 403.
- Há uma resposta só. A segunda recebe 400 com
  `Esta disputa já não aceita resposta.`
- A outra parte tem 3 dias (`responseDeadline`). Passado o prazo sem
  resposta, a disputa passa a `UNDER_REVIEW` e o admin pode decidir. A
  resposta atrasada ainda é aceite até o admin decidir.
- A reclamação do depósito passou a nascer em `AWAITING_OWNER`. Antes nascia
  em `UNDER_REVIEW` e o cliente não era ouvido.
- Um admin pode registar a resposta em nome da outra parte, na mesma rota.

### Campos da disputa
- Novos: `respondentId`, `evidenceUrls`, `response`, `responseEvidenceUrls`,
  `respondedAt`, `responseDeadline`, `closedAt`, `serviceBookingId`,
  `serviceBooking`, e em `payment` os campos `rentalAmount`, `depositAmount`
  e `depositStatus`.
- `ownerResponse` e `ownerDeadline` continuam a sair, com os valores de
  `response` e de `responseDeadline`.
- Estado novo: `WITHDRAWN`.

### Decisão do admin
- As três resoluções só são aceites com a disputa em `UNDER_REVIEW`. Antes
  disso respondem 400 com `A outra parte ainda pode responder a esta
  disputa. Só se resolve depois da resposta ou do fim do prazo.`
- Disputa de pagamento de um aluguer decidida a favor do provider, ou
  repartida: a entrega fica dada como feita, a reserva passa a `ACTIVE` e o
  depósito continua `HELD`. Segue-se o fim normal do aluguer, com
  `confirm-return` ou `deposit-claim`. Antes a reserva ficava `COMPLETED` e o
  depósito era devolvido na hora, com o equipamento ainda nas mãos do
  cliente.
- Por isso um pagamento `PARTIALLY_REFUNDED` pode ter o depósito `HELD` e a
  reserva `ACTIVE`.
- Nos serviços e nas disputas de depósito nada muda: a reserva conclui.

### Retirar uma disputa
- `PATCH /disputes/:id/withdraw` com `{ reason? }`. Retira quem abriu,
  enquanto a disputa não for decidida. Um admin pode arquivá-la. A outra
  parte recebe 403.
- Não move dinheiro. A reserva volta ao estado em que estava. O aluguer
  volta a `CONFIRMED` numa disputa de pagamento e a `ACTIVE` numa de
  depósito. O serviço volta a `PENDING`, `IN_PROGRESS` ou `COMPLETED`,
  conforme o provider já tinha começado ou concluído.
- Depois de uma retirada, a libertação automática do pagamento espera 3 dias
  a contar da retirada, para a outra parte ter tempo de abrir a sua disputa.
- Depois de retirada, pode abrir-se outra disputa na mesma reserva.

### Provas
- `POST /disputes/upload-evidence` aceita qualquer conta autenticada, até 30
  fotos por hora.
- `evidenceUrls` só aceita endereços devolvidos por esse upload a quem os
  envia, no máximo 10. Um link de fora ou a foto de outra pessoa recebem 400.

### Avisos push
Todos com `data: { type: 'dispute', disputeId }`.

| Quando | Quem recebe | Título |
|---|---|---|
| Disputa aberta | a outra parte | `Disputa aberta` ou `Reclamação do depósito` |
| Resposta registada | quem abriu | `Resposta à disputa` |
| Prazo de resposta terminado | as duas partes | `Disputa em análise` e `Prazo de resposta terminado` |
| Disputa resolvida | as duas partes | `Disputa resolvida` |
| Disputa retirada | a outra parte | `Disputa retirada` |
| Disputa arquivada por um admin | quem abriu | `Disputa arquivada` |

### Na app
- `services/disputeService.ts`: estado `WITHDRAWN` com rótulo e cores,
  campos novos em `Dispute`, `respondToDispute`, `withdrawDispute` e
  `isDisputeOpen`.
- Painel do admin: os botões de decisão só aparecem em `UNDER_REVIEW`. Antes
  disso o cartão mostra até quando a outra parte pode responder, e depois
  mostra a resposta.
- Ainda não há ecrã para as partes verem a disputa, responderem ou a
  retirarem. Até existir, a outra parte só é ouvida se um admin registar a
  resposta por ela.

## 11. Catálogo e moderação (lote 9)

Vale para equipamentos e para serviços, salvo indicação.

### Editar um anúncio aprovado
- `PATCH /equipment/:id` e `PATCH /services/:id` só contam o que muda de
  facto. A app pode continuar a enviar o formulário inteiro.
- Mudar o título, a descrição ou a categoria de um anúncio `ACTIVE` devolve-o
  a `PENDING_REVIEW`. Sai do catálogo até um admin o aprovar de novo. A
  resposta traz o estado novo e uma `message` que o explica: a app deve
  mostrá-la em vez de um texto fixo.
- Preço, depósito, quantidade, localização, entrega e operador não passam
  por revisão.
- Um provider verificado (KYC aprovado) edita sem revisão, como já publicava
  sem ela. Um admin também.
- Carregar uma foto nova num anúncio `ACTIVE` também o devolve à revisão.
  Tirar uma foto ou mudar a principal não.
- Enquanto o anúncio está em revisão não entram reservas nem pedidos novos.
  O que já estava em curso continua: o provider confirma as reservas
  pendentes, envia orçamentos e o cliente aceita-os.

### Anúncio rejeitado
- `PATCH /equipment/:id/reject` e `PATCH /services/:id/reject` guardam o
  motivo no anúncio. O dono recebe-o em `rejectionReason`, nas listas e no
  detalhe do dono, enquanto o anúncio estiver `REJECTED`, e recebe um aviso
  push (`type: 'equipment_rejected'` ou `'service_rejected'`).
- Qualquer alteração que o dono faça a um anúncio rejeitado, nos campos ou
  nas fotos, envia-o de novo para revisão. Gravar sem mudar nada deixa-o
  como está.
- A aprovação de um serviço passou a avisar o provider
  (`type: 'service_approved'`).

### Detalhe do dono
- `GET /equipment/me/listings/:id` e `GET /services/me/listings/:id`
  devolvem o anúncio ao dono em qualquer estado menos removido, com a
  localização exacta e o `rejectionReason`. Outra conta recebe 403.
- O ecrã de edição tem de ler daqui. O detalhe público só devolve anúncios
  `ACTIVE`, por isso não abria um anúncio em revisão ou rejeitado.

### Remover
- `DELETE /equipment/:id` responde 400 enquanto o equipamento tiver reservas
  pendentes, confirmadas, activas ou em disputa. `DELETE /services/:id`
  responde 400 enquanto houver reservas de serviço por pagar, em execução ou
  em disputa. A saída é pausar o anúncio e removê-lo depois.
- Um anúncio removido responde 404 a edições, fotos e a uma segunda remoção.

### Quantidade
- `PATCH /equipment/:id` aceita `quantity`. Não pode ficar abaixo das
  unidades com reserva ao mesmo tempo: responde 400 com o número.

### Catálogo público
- Os anúncios de uma conta suspensa saem das listas e do detalhe, e não
  aceitam reservas nem pedidos. Voltam quando a conta é reactivada.
- `latitude` e `longitude` no detalhe público vêm arredondadas a duas casas
  (cerca de um quilómetro). A localização exacta só sai no detalhe do dono.
- `page` vai até 1000 e tem de ser inteiro, como `limit`. `search` leva no
  máximo 100 caracteres. Fora disso, 400.
- Preços até 10 000 000 e depósito até 100 000 000. `quantity` é um inteiro
  até 1000.
- Criar um equipamento numa categoria de serviços responde 400.

### Listas
- `GET /equipment/admin/pending`, `GET /services/admin/pending` e
  `GET /services/me/listings` passam a ser paginadas (`page`, `limit`, 50 por
  omissão e 100 no máximo) e devolvem `meta`. `data` mantém o formato.
- `GET /services/me/listings` deixou de trazer os anúncios removidos.
- `GET /equipment/me/analytics`: a receita conta só os pagamentos que foram
  pagos ao provider (`RELEASED` e `PARTIALLY_REFUNDED`).

### Na app
- `services/equipmentService.ts`: `getMyEquipmentById`, `quantity` em
  `UpdateEquipmentDto` e `rejectionReason` em `Equipment`.
- `app/equipment/edit/[id].tsx` lê o anúncio pelo detalhe do dono, envia a
  quantidade e mostra a mensagem do servidor.
- As duas listas "os meus anúncios" mostram o motivo da rejeição.
- Não há ecrã para editar um serviço. As regras do servidor já estão
  prontas para quando existir.

## 12. Avaliações e categorias (lote 10)

### As duas notas de uma conta
- Cada conta tem duas notas. Como provider, é a média do que os clientes
  disseram dos alugueres e dos serviços dela. Como cliente, é a média do que
  os providers disseram dela. Antes era uma só, e um mau aluguer como cliente
  baixava a nota de todos os anúncios de quem também é provider.
- `owner.totalRating` e `owner.totalReviews` no detalhe de um equipamento, e
  `provider.totalRating` e `provider.totalReviews` no de um serviço, são a
  nota como provider. O nome dos campos não mudou.
- `GET /users/me` e `GET /users/:id` devolvem `totalRating` e `totalReviews`
  (como provider) e os campos novos `clientRating` e `clientReviews`.
- `GET /users/:id/reviews` devolve as avaliações que a conta recebeu dos dois
  lados. `authorRole=CLIENT` dá as que os clientes deixaram aos anúncios dela,
  e `authorRole=PROVIDER` as que os providers lhe deixaram como cliente. Antes
  o primeiro filtro vinha sempre vazio.
- As notas existentes foram refeitas a partir das avaliações.

### Avaliar
- Enviar a mesma avaliação duas vezes ao mesmo tempo dá 201 a uma e 400 à
  outra, com `Já submeteste uma avaliação para esta reserva.` Antes a segunda
  podia sair como 500.
- Duas avaliações em simultâneo ao mesmo anúncio contam as duas.

### Listagens
- `GET /equipment` passa a trazer `totalRating` e `totalReviews` reais. Antes
  vinham sempre null e 0, e os cartões nunca mostravam avaliações.
- `totalBookings` é o número de alugueres concluídos do anúncio, na lista, no
  detalhe e nas listas do dono. Antes era sempre 0.
- `GET /services` passa a trazer `totalRating`, `totalReviews` e
  `totalCompleted` em cada item. `totalCompleted` é o número de trabalhos
  concluídos, também no detalhe.
- `sortBy=relevant` ordena pelos mais avaliados e pela melhor nota (nos
  equipamentos, com os destacados primeiro). Antes ordenava por contadores
  que ninguém mantinha e dava a ordem de criação.

### Filtro de categoria
- `categoryId` e `categorySlug`, em `GET /equipment` e `GET /services`,
  apanham a categoria pedida e as que estão debaixo dela. Quem escolhe
  «Construção» vê também o que está em «Betoneiras».

### Categorias (admin)
- `PATCH /categories/:id` passa a aceitar `kind` e `isActive`. O painel já os
  enviava e recebia 400, por isso editar e activar ou desactivar uma
  categoria não funcionava.
- `isActive: false` desactiva com as condições de `DELETE` (sem subcategorias
  activas nem anúncios). `isActive: true` reactiva uma categoria desactivada,
  se o pai estiver activo.
- `kind` só muda se couber no que a categoria já tem. Uma categoria com
  equipamentos não passa a ser só de serviços, nem o contrário, e as
  subcategorias têm de caber no tipo novo.
- Uma subcategoria tem de ser do tipo do pai, salvo se o pai for `BOTH`.
- `parentId: null` tira a categoria de debaixo do pai e `iconUrl: null` tira
  o ícone. `name: null` responde 400. Antes os três davam 500.
- Uma categoria não pode ficar debaixo de si própria nem de uma das suas
  subcategorias: 400.
- `GET /categories/admin/all` devolve todas as categorias, com as
  desactivadas. A lista pública continua a devolver só as activas.
- Criar uma categoria com o nome de uma desactivada responde 400 a dizer
  para a reactivar.
- `GET /categories?kind=` com um valor desconhecido responde 400. Antes era
  tratado como `BOTH`.

### Na app
- `app/admin/index.tsx`: o separador de categorias lê
  `/categories/admin/all`. O resto do painel já enviava o que a API agora
  aceita.
- Os cartões do catálogo e a lista de serviços já liam `totalRating`, por
  isso passam a mostrar as notas sem alteração de ecrã.

## 13. Chat (lote 11)

### Conversas
- `POST /chat/conversations` aceita `clientId`. Com ele, quem pede é o dono
  do anúncio e fala com um cliente que tem uma reserva (equipamento) ou um
  pedido (serviço) nesse anúncio. Sem reserva nem pedido responde 403. É a
  mesma conversa que o cliente abriria, por isso a resposta dele cai nela.
- Sem `clientId` continua como estava: quem pede fala com o dono do anúncio.
  O anúncio tem de estar no catálogo e a conta do dono activa, senão 404.
- Cada conta abre no máximo 20 conversas novas por dia. Acima disso, 429.
- Dois pedidos iguais ao mesmo tempo ficam com uma conversa só. Antes o
  segundo podia sair como 500.
- `GET /chat/conversations` passa a ser paginada (`page`, `limit`, 30 por
  omissão e 100 no máximo), devolve `meta`, e cada conversa traz
  `unreadCount`: as mensagens do outro que o utilizador ainda não leu.

### Mensagens
- `POST /chat/conversations/:id/messages` devolve a mensagem no formato de
  `ChatMessage` (`senderName`, `senderAvatar`). Antes devolvia a linha da
  base, com `sender` aninhado, que não era o tipo que a app esperava.
- Cada conta envia no máximo 30 mensagens por minuto, pelo REST e pelo
  socket juntos. Acima disso, 429.
- `GET /chat/conversations/:id` aceita `limit` até 100. Ficam lidas as
  mensagens do outro até à mais recente da página devolvida. Antes, pedir
  uma página antiga dava por lidas todas as mensagens da conversa.

### Socket
- O socket em `/chat` vem desligado. Liga-se com `CHAT_GATEWAY_ENABLED=true`
  no ambiente do servidor. Desligado, recusa todas as ligações com
  `O chat em tempo real está desligado.` A app usa só o REST e não é
  afectada.
- Ligado, pede o access token no handshake e segue as regras do HTTP: a
  sessão tem de estar aberta e a conta activa. O logout, a troca de password
  e a suspensão fecham o socket.
- `send_message` valida o conteúdo e conta para o limite por minuto.
  `typing` e `stop_typing` só passam de quem entrou na conversa com
  `join_conversation`.
- Uma mensagem enviada pelo REST chega também a quem está no socket
  (`new_message` e `conversation_updated`).
- `join_conversation` deixou de marcar mensagens como lidas.

### Na app
- `services/chatService.ts`: `startConversation` aceita `clientId`, e
  `getMyConversations` pede 100 conversas por página, o máximo. Os tipos
  `Conversation.unreadCount` e `ChatMessage` já batiam com o que a API passa
  a devolver.
- Falta o botão para o provider escrever ao cliente a partir de uma reserva.
  É trabalho de ecrã.

## 14. Fornecedor de pagamentos e controlos do dinheiro (lote 7A)

O M-Pesa ainda não está ligado. Esta secção descreve o que a API já aceita para quando estiver, e o que mudou no modo manual de hoje. Os detalhes da integração estão em `docs/MPESA-INTEGRACAO.md`.

### Como se paga
- `GET /payments/instructions` diz à app como se paga agora. `mode: "automatic"` quer dizer que a app pede a cobrança no telemóvel. `mode: "manual"` quer dizer que o cliente paga para `receiver.number` e declara a referência, como hoje.
- `POST /payments/:id/collect` com `{ "msisdn": "+2588..." }` e o cabeçalho `Idempotency-Key` obrigatório. Só quem fez a reserva. O fornecedor pede o PIN no telemóvel e a resposta traz a cobrança (`status`, `inProgress`, `failureCode`, `failureReason`). No modo manual responde 400 `PAYMENT_COLLECTION_UNAVAILABLE`. Com uma cobrança ainda em curso responde 409 `PAYMENT_COLLECTION_IN_PROGRESS`, e a app espera em vez de pedir outra.
- `GET /payments/:id` traz `collection`: a cobrança mais recente, ou `null`. Uma cobrança `UNKNOWN` ou `PENDING` resolve-se sozinha (o job pergunta ao fornecedor ou chega o aviso dele). A app volta a ler o pagamento até `inProgress` passar a `false`.
- O número que pagou fica no pagamento. Um reembolso ou a devolução do depósito sai para esse número, mesmo que não seja o da conta.

### Confirmação manual (mark-held)
- Um valor abaixo do total continua a dar 400 `PAYMENT_AMOUNT_MISMATCH`. Um valor acima passa a ser aceite: o pagamento fica retido pelo total e a diferença fica como dinheiro por atribuir, para devolver.
- Uma transacção M-Pesa conta uma vez. A referência que já fecha um pagamento, ou que já está registada como dinheiro por atribuir, responde 409 `PAYMENT_REFERENCE_ALREADY_USED`.
- Um admin que é cliente ou dono da reserva não confirma o pagamento dela: 403 `MONEY_CONTROL_VIOLATION`.
- A auditoria `PAYMENT_MARKED_HELD` guarda também `provider`, `receivedAmount` e `excess`.

### Libertar e reembolsar
- Quem recebe o pagamento nunca o liberta, mesmo com conta de admin: 403 `MONEY_CONTROL_VIOLATION`.
- Um admin que é cliente ou dono da reserva não a reembolsa: 403 `MONEY_CONTROL_VIOLATION`.
- O provider recebe um aviso quando o pagamento é libertado. O cliente recebe um 24 horas antes da libertação automática e outro quando ela acontece.

### Payouts
- Estado novo `SENDING`: o fornecedor está a enviar. Nesse estado o payout não se executa nem se dá como falhado à mão (400), espera-se pelo resultado.
- Acima de `PAYOUT_AUTO_MAX_AMOUNT` (proposta: 5000 MZN) um payout espera aprovação. `PATCH /payouts/:id/approve` (ADMIN) aprova-o e, com o fornecedor a enviar, ele sai logo. Na fila do admin cada payout traz `needsApproval` e `approvedAt`.
- Um admin não aprova nem executa um payout para si próprio. Com `MONEY_FOUR_EYES=true`, quem confirmou a entrada do dinheiro também não. Os dois respondem 403 `MONEY_CONTROL_VIOLATION`.
- O destinatário recebe um aviso quando o payout é executado e quando falha.

### Dinheiro por atribuir (ADMIN)
- `GET /payments/admin/unallocated?status=OPEN|RETURNING|RETURNED`: dinheiro que entrou sem fechar nenhum pagamento. O motivo (`reason`) é `AMOUNT_MISMATCH`, `OVERPAYMENT`, `LATE` (chegou depois de a reserva expirar) ou `UNKNOWN_REFERENCE`.
- `POST /payments/admin/unallocated` regista uma entrada do extracto que não fecha pagamento, com `mpesaReference`, `amount`, `payerMsisdn` e, opcionais, `paymentId` e `note`.
- `PATCH /payments/admin/unallocated/:id/returned` com `{ "returnReference": "..." }` regista a devolução feita à mão. A mesma referência não fecha duas saídas: 409.
- `POST /payments/admin/unallocated/:id/return` devolve pelo fornecedor. No modo manual responde 400 `PAYOUT_TRANSFER_UNAVAILABLE`.

### Reconciliação
- `totals` ganha `unallocatedInAccount` e `providerFees`. `expectedInAccount` passa a ser o recebido nos pagamentos, mais o dinheiro por atribuir, menos os payouts executados e as taxas.
- `alertsTotal` e `alerts` listam o que está parado tempo demais: `OPERATION_STUCK` (operação no fornecedor sem resposta há 6 horas), `PAYOUT_STALE` (payout por executar há 48 horas) e `UNALLOCATED_OPEN` (dinheiro por devolver há 48 horas). Não contam como divergências.

### Avisos do fornecedor
- `POST /payments/providers/:provider/events`, sem JWT, com o segredo `PAYMENTS_WEBHOOK_SECRET` no cabeçalho `x-zuno-webhook-token`. Responde 200 também a um aviso repetido (`duplicate: true`), 401 sem o segredo certo e 404 para um fornecedor que não está ligado.

### Reservas
- O prazo de pagamento volta a contar quando o provider confirma a reserva. Antes contava da criação, e uma reserva confirmada ao fim de 20 horas deixava ao cliente 4 horas para pagar.
- O preço calcula-se em decimal. Valores com cêntimos deixam de produzir totais como `0.30000000000000004`.

### Na app
- `services/paymentService.ts`: `getPaymentInstructions`, `startCollection` (recebe a chave de idempotência do ecrã, para uma repetição não cobrar outra vez), o tipo `PaymentCollection` e `Payment.collection`, `Payout.status` com `SENDING`, `approvePayout`, as funções do dinheiro por atribuir e os campos novos da reconciliação.
- `initiateBookingPayment` abre o pagamento de uma reserva confirmada.
- O detalhe da reserva (`app/booking/[id].tsx`) paga pelo `BookingPaymentPanel` (`components/payments/`). O painel lê `instructions`: no modo manual mostra o número da plataforma e o valor, e envia a referência com `declare`. No automático pede a cobrança com `collect` e volta a ler o pagamento de 4 em 4 segundos enquanto a cobrança estiver em curso, até 3 minutos. O `mock-pay` ficou só como ligação em desenvolvimento (`__DEV__`).
- No mesmo ecrã, o botão do provider passou a ser "Confirmar devolução do equipamento" e aparece com a reserva `ACTIVE`. Antes aparecia com a reserva `CONFIRMED`, quando o backend ainda recusa a conclusão.
- As reservas de serviço continuam sem ecrã de pagamento. O painel abre o pagamento por `initiateBookingPayment`, que só serve alugueres, por isso um ecrã de serviço passa-lhe o pagamento que nasce com a aceitação do orçamento.

## 15. Estado da app e compatibilidade (2026-11-20)

A app em `feature/new-design` (commit `75209c6`) ainda segue o contrato antigo. O backend aceita quatro coisas que ela já faz, para não dar erro em uso normal, e há cinco faltas que só se resolvem na app.

O que o backend aceita por compatibilidade são nomes e formatos antigos. O código novo da app deve usar os actuais.

- `POST /reviews` aceita `authorRole: "OWNER"` e grava `PROVIDER`. O filtro `authorRole=OWNER` das listas de avaliações segue a mesma regra. As respostas trazem sempre `PROVIDER`.
- `GET /equipment` aceita o filtro `deliveryIncluded` com o efeito de `deliveryAvailable`. Quando chegam os dois, vale `deliveryAvailable`.
- `GET /equipment` devolve `total`, `page`, `limit` e `totalPages` também no topo da resposta, com os valores de `meta`. As outras listas só têm `meta`.
- `GET /equipment/:id` e `GET /services/:id` continuam públicos e só mostram anúncios activos a quem não os gere. Com a sessão do dono ou de um admin no cabeçalho `Authorization`, um anúncio em revisão ou rejeitado responde como em `me/listings/:id`. Um anúncio removido responde 404 a todos. Um token inválido ou expirado nestas duas rotas responde 401, para a app renovar a sessão e repetir o pedido.

O que falta na app, por ordem de gravidade:

1. Pagamento. A app paga por `POST /payments/booking/:id/mock-pay`, que responde 403 em produção. O caminho real são `GET /payments/instructions`, `PATCH /payments/:id/declare` e `POST /payments/:id/collect` (secções 8 e 14). No modo manual de hoje falta também o lado do admin: o painel não tem a fila `GET /payments/admin/declared` nem a confirmação `PATCH /payments/:id/mark-held`, e sem elas um pagamento declarado nunca fica retido. Os payouts (`/payouts`, secção 5) também não têm ecrã.
2. Estado `EXPIRED`. Uma reserva por pagar expira (secção 7). `getStatusColors` não tem esse caso e devolve `undefined`, por isso rebentam os quatro ecrãs que lêem `colors.bg`: `(tabs)/bookings`, `(tabs)/requests`, `booking/my-bookings` e `booking/[id]`.
3. Devolução. O botão com que o proprietário conclui a reserva aparece em `CONFIRMED`, e o backend só aceita a conclusão em `ACTIVE`. Falta também a reclamação do depósito, `POST /disputes/deposit-claim` (secção 1).
4. Serviços. Depois de aceitar um orçamento, a app não tem ecrã para a reserva de serviço: o pagamento e as rotas `start`, `complete` e `cancel` de `/service-bookings` (secção 8).
5. Disputas. Falta a resposta da outra parte (`PATCH /disputes/:id/respond`) e a retirada (`withdraw`). O painel de admin mostra os botões de resolver em `OPEN` e `AWAITING_OWNER`, e o backend só resolve em `UNDER_REVIEW` (secção 10).

Mais pequeno: o ecrã de registo aceita passwords de 6 caracteres e o backend exige 8.
