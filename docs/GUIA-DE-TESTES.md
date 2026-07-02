# ZUNO — Guia de Testes de Plataforma (Tour Completa)

> Roteiro profissional para testar a plataforma com intensidade antes de qualquer
> lançamento. Segue as secções por ordem — cada uma assume o estado deixado pela
> anterior. Tempo total estimado: **4–6 horas** para a primeira passagem completa.
>
> Regra de ouro: em cada passo, verifica **três camadas** — o que a app mostra,
> o que a API devolve, e o que ficou na base de dados. Um teste só passa quando
> as três contam a mesma história.

---

## 0. Preparação do ambiente (~30 min)

### 0.1 Arrancar tudo

```powershell
# Terminal 1 — backend (verifica que o Postgres local está a correr)
cd D:\Project\ZUNO\Zuno_back
npm run start:dev
# Confirma no arranque: sem erros, migrations aplicadas

# Terminal 2 — frontend
cd D:\Project\ZUNO\zuno-frontEnd
npx expo start
# Telemóvel no MESMO Wi-Fi; confirma o IP em .env (EXPO_PUBLIC_API_URL)
```

### 0.2 Verificações de infra (smoke)

| Verificação | Como | Esperado |
|---|---|---|
| Liveness | `curl http://localhost:3000/api/v1/health` | 200, `uptimeSeconds` |
| Readiness (BD) | `curl http://localhost:3000/api/v1/ready` | 200, `database: ok` |
| Swagger | abrir `http://localhost:3000/docs` no browser | UI carrega (só em dev) |

O **Swagger é a tua ferramenta de admin** durante os testes: as operações sem UI
(mark-held, executar payouts, resolver disputas de depósito) fazem-se lá.
Autentica com o botão "Authorize" usando o accessToken do admin.

### 0.3 Criar o elenco de teste (3 personas)

Regista na app 3 contas com números diferentes:

| Persona | Papel no teste | Sugestão |
|---|---|---|
| **Carlos** | CLIENTE — reserva, paga, confirma entregas, abre disputas | +25884XXXXXX1 |
| **Paula** | PROVIDER — publica equipamento, confirma reservas e devoluções | +25884XXXXXX2 |
| **Admin** | Opera pagamentos, payouts, disputas, moderação | +25884XXXXXX3 |

Promover o Admin (não há UI para isto — é intencional):

```sql
UPDATE "User" SET role = 'ADMIN' WHERE phone = '+25884XXXXXX3';
```

> Dica prática: usa dois telemóveis (ou telemóvel + emulador) para Carlos e
> Paula em simultâneo — vais precisar de alternar muito entre eles.

### 0.4 Caderno de bugs

Abre um ficheiro/nota e regista CADA anomalia neste formato:
`[ecrã ou endpoint] — o que fiz — o que esperava — o que aconteceu — gravidade (bloqueia? errado? feio?)`

---

## 1. Tour do fluxo feliz — "o caminho do dinheiro" (~60 min)

Este é o teste mais importante da plataforma: uma transação completa de ponta a
ponta com verificação financeira em cada checkpoint.

### 1.1 Paula publica um equipamento
1. Login como Paula → publicar equipamento: título, descrição, categoria,
   **preço/dia 500**, **depósito 1000**, 2+ fotos.
2. ✅ App: aparece em "Os meus anúncios" com estado *Pendente de revisão*.
3. ✅ Não aparece no catálogo público (login como Carlos e procura — não deve existir).

### 1.2 Admin aprova
4. Login como Admin → painel admin → aprovar o equipamento.
5. ✅ O equipamento aparece agora no catálogo do Carlos, com fotos e preço certos.
6. ✅ Paula recebeu push de aprovação (se testares em dispositivo físico).

### 1.3 Carlos reserva (3 dias)
7. Carlos → detalhe do equipamento → reservar 3 dias (começa daqui a ~4 dias —
   importante para testar o cancelamento grátis depois).
8. ✅ Resumo mostra: rental 1500, depósito 1000, taxa 150, **total 2650**.
9. ✅ BD: `SELECT status, "rentalAmount", "totalAmount" FROM "Booking" ORDER BY "createdAt" DESC LIMIT 1;` → PENDING, 1500, 2650.

### 1.4 Paula confirma
10. Paula → pedidos recebidos → confirmar.
11. ✅ Carlos vê *Confirmado* e o botão de pagar M-Pesa.
12. ✅ BD: `Equipment.availableQuantity` decrementou.

### 1.5 Carlos paga (mock em dev)
13. Carlos → pagar via M-Pesa.
14. ✅ App: "pagamento retido no cofre".
15. ✅ BD — o dinheiro ENTROU no ledger:
```sql
SELECT direction, party, amount, reason FROM "LedgerEntry" ORDER BY "createdAt";
-- Esperado: 1 linha INFLOW CLIENT 2650
SELECT status, "depositStatus" FROM "Payment" ORDER BY "createdAt" DESC LIMIT 1;
-- Esperado: HELD, HELD
```

### 1.6 Checkpoint 1 — Carlos confirma a entrega
16. Carlos → "Confirmar recepção do equipamento". Lê o texto do diálogo — deve
    explicar que o **depósito continua retido**.
17. ✅ App: reserva passa a **Activo**; cartão azul "Depósito retido no cofre".
18. ✅ BD — o rental saiu, o depósito ficou:
```sql
SELECT direction, party, amount FROM "LedgerEntry" ORDER BY "createdAt";
-- Esperado agora: INFLOW CLIENT 2650 | OUTFLOW PROVIDER 1350 | OUTFLOW PLATFORM 300
-- Saldo do escrow = 1000 (exactamente o depósito)
SELECT kind, amount, status, msisdn FROM "Payout";
-- Esperado: PROVIDER_PAYOUT 1350 PENDING
```
19. ✅ Paula: a reserva dela também mostra *Activo*, com botões
    **"Confirmar devolução"** e **"Reportar dano no equipamento"**.

### 1.7 Admin executa o payout (fila de reconciliação)
20. Swagger → `GET /payouts?status=PENDING` (como Admin) → vês o payout da Paula
    com o msisdn dela.
21. `PATCH /payouts/{id}/execute` com `{ "mpesaReference": "TESTE123XYZ" }`.
22. ✅ `GET /payouts/me` como Paula → EXECUTED com a referência.

### 1.8 Checkpoint 2 — Paula confirma a devolução
23. Paula → "Confirmar devolução".
24. ✅ App: reserva *Concluída* nos dois lados; Carlos pode avaliar.
25. ✅ BD — o depósito voltou ao cliente:
```sql
SELECT direction, party, amount FROM "LedgerEntry" ORDER BY "createdAt";
-- Nova linha: OUTFLOW CLIENT 1000
SELECT "depositStatus" FROM "Payment" ORDER BY "createdAt" DESC LIMIT 1; -- RETURNED
SELECT kind, amount, status FROM "Payout"; -- + DEPOSIT_RETURN 1000 PENDING
```
26. **✅ RECONCILIAÇÃO FINAL — a verificação que importa:**
```sql
SELECT p."receiptNumber",
       SUM(CASE WHEN l.direction='INFLOW'  THEN l.amount ELSE 0 END) AS entrou,
       SUM(CASE WHEN l.direction='OUTFLOW' THEN l.amount ELSE 0 END) AS saiu
FROM "Payment" p JOIN "LedgerEntry" l ON l."paymentId" = p.id
GROUP BY p.id;
-- entrou = saiu = 2650. Se alguma vez saiu > entrou, é bug CRÍTICO.
```

### 1.9 Reviews
27. Carlos avalia o equipamento (5★); Paula avalia o Carlos.
28. ✅ Rating aparece no detalhe do equipamento e no perfil da Paula.
29. ✅ Tentar avaliar segunda vez → erro claro (não 500).

---

## 2. Caminhos adversos — onde as plataformas partem (~90 min)

Repete a preparação (nova reserva paga e HELD) antes de cada cenário.

### 2.1 Cancelamento grátis (cliente, >48h antes)
- Carlos cancela uma reserva paga que começa daqui a 4 dias.
- ✅ Diálogo NÃO avisa retenção. Payment → REFUNDED, refundAmount 2650.
- ✅ Ledger: OUTFLOW CLIENT 2650. Payout CLIENT_REFUND criado.
- ✅ `availableQuantity` da Paula restaurada.

### 2.2 Cancelamento tardio (cliente, <48h antes)
- Cria reserva a começar **amanhã**, paga, e cancela.
- ✅ Diálogo AVISA a retenção de 30%.
- ✅ Payment → PARTIALLY_REFUNDED; refundAmount = 2650 − 450 = **2200**;
  ledger com 3 saídas (cliente 2200, provider 405, plataforma 45) + depósito
  incluído no reembolso do cliente. Payouts: CLIENT_REFUND + PROVIDER_PAYOUT.
- ✅ Reconciliação (query 1.8/26) continua a bater certo.

### 2.3 Cancelamento pelo provider + strikes
- Paula cancela uma reserva confirmada e paga.
- ✅ Carlos recebe reembolso TOTAL (incluindo a taxa).
- ✅ BD: `SELECT * FROM "ProviderStrike";` → 1 strike.
- Repete mais 2 vezes (3 strikes): ✅ `User.listingsSuspendedUntil` preenchido;
  Paula tenta publicar novo equipamento → **403 com mensagem clara**.
- Limpa para continuar os testes: `DELETE FROM "ProviderStrike"; UPDATE "User" SET "listingsSuspendedUntil" = NULL;`

### 2.4 Disputa de pagamento (cliente, pré-entrega)
- Reserva paga (HELD). Carlos → "Reportar problema" → motivo + descrição + 2 fotos.
- ✅ Reserva fica *Em disputa*; Carlos NÃO consegue liberar o pagamento (o botão
  não deve funcionar / API recusa).
- Admin resolve a favor do cliente (painel admin).
- ✅ REFUNDED total, booking CANCELLED, quantidade restaurada, ledger e payout corretos.
- Repete com resolução a favor do owner: ✅ RELEASED (payout provider) + depósito
  devolvido ao cliente, booking COMPLETED.
- Repete com resolução parcial 50%: ✅ refund = 50% × rental = **750** (nunca
  sobre o total!); provider recebe 1500−750−150 = 600; depósito devolvido à parte.
  **Reconciliação tem de bater.**

### 2.5 Reclamação do depósito (provider, pós-entrega) — fluxo novo
- Reserva ACTIVE (entrega confirmada). Paula → "Reportar dano no equipamento"
  → descrição ≥20 chars + fotos do dano.
- ✅ Reserva fica *Em disputa*; disputa criada com `type = DEPOSIT` em UNDER_REVIEW.
- Admin (Swagger ou painel): resolve a favor do owner.
- ✅ `depositStatus = CLAIMED`; Payout DEPOSIT_CLAIM 1000 para a Paula; booking COMPLETED.
- Repete com resolução parcial 40%: ✅ 400 ao Carlos, 600 à Paula, `depositStatus = SPLIT`.

### 2.6 Prazos automáticos (schedulers)
Não esperes 3 dias — recua as datas na BD e força o relógio:
```sql
-- Auto-release: cliente "esqueceu-se" de confirmar a entrega
UPDATE "Booking" SET "startDate" = now() - interval '4 days'
WHERE id = '<booking CONFIRMED com payment HELD>';
-- Auto-devolução: provider "esqueceu-se" de confirmar a devolução
UPDATE "Booking" SET "endDate" = now() - interval '3 days'
WHERE id = '<booking ACTIVE>';
```
O cron corre à hora certa; para não esperar, reinicia o backend e aguarda o
primeiro tick, ou muda temporariamente `EVERY_HOUR` → `EVERY_MINUTE` em
`bookings.scheduler.ts` (reverte depois!).
- ✅ Logs do backend: "Auto-release: 1 pagamento(s)..." / "Auto-devolução: ...".
- ✅ Audit: `SELECT action FROM "AuditLog" WHERE action LIKE '%AUTO%';`

---

## 3. Testes de segurança — o que DEVE falhar (~45 min)

Usa o Swagger/curl com o token da persona errada. **Cada linha desta tabela tem
de devolver 403/400 — se alguma passar, é bug crítico.**

| # | Ataque | Como testar | Esperado |
|---|---|---|---|
| S1 | Paula liberta o próprio pagamento | token Paula → `PATCH /payments/{id}/release` | 403 |
| S2 | Carlos marca o próprio pagamento como HELD | token Carlos → `PATCH /payments/{id}/mark-held` | 403 |
| S3 | Carlos vê pagamento de terceiros | token de conta nova → `GET /payments/{id}` | 403 |
| S4 | Carlos aprova equipamento | `PATCH /equipment/{id}/approve` | 403 |
| S5 | Carlos resolve disputa | `PATCH /disputes/{id}/resolve-client` | 403 |
| S6 | Carlos reclama depósito da reserva dele | `POST /disputes/deposit-claim` | 403 (só o owner) |
| S7 | Paula confirma devolução de reserva de OUTRO provider | `PATCH /bookings/{id}/confirm-return` | 403 |
| S8 | Release de pagamento já RELEASED | repetir o release | 400 |
| S9 | Resolver disputa de pagamento já RELEASED | criar cenário via SQL se preciso | 400 (era o bug do desembolso duplo) |
| S10 | Reservar o próprio equipamento | Paula reserva o dela | 400 |
| S11 | Campo extra no body | `POST /bookings` com `"rentalAmount": 1` | 400 (whitelist) — e confirma que o preço NÃO mudou |
| S12 | Reserva no passado / fim antes do início | datas inválidas | 400 |
| S13 | Executar payout como Paula | `PATCH /payouts/{id}/execute` | 403 |
| S14 | Reclamar depósito fora da janela | `UPDATE "Booking" SET "endDate" = now() - interval '5 days'` e tentar | 400 |
| S15 | Brute force no login | 11+ tentativas erradas seguidas | 429 (throttle) |

---

## 4. Resiliência mobile — o teste do mundo real (~30 min)

Moçambique = rede intermitente. A app tem de sobreviver a isto:

| # | Cenário | Como | Esperado |
|---|---|---|---|
| R1 | Abrir a app offline | modo avião → abrir a app | **Continua logado** (perfil em cache), não volta ao login |
| R2 | Timeout | para o backend → tenta carregar o catálogo | Erro claro + "Tentar novamente" em ≤15s (não loading eterno) |
| R3 | Recuperação | volta a ligar o backend → retry | Carrega sem reiniciar a app |
| R4 | Expiração do token | espera 15+ min com a app aberta → navega | Renova sozinho, sem logout, sem erro visível |
| R5 | Refresh concorrente | após 15 min parado, abre um ecrã que dispara vários pedidos | NÃO desloga (mutex do refresh) |
| R6 | Duplo toque em "Reservar" | toca 2× rápido no submit | UMA só reserva (Idempotency-Key) |
| R7 | Rede lenta | throttle no router/emulador (3G) | Imagens carregam progressivamente, sem crash |
| R8 | Logout | logout → tenta voltar atrás no histórico | Sem acesso a ecrãs autenticados; novo login limpo |
| R9 | Sessão morta no servidor | `UPDATE "AuthSession" SET "revokedAt" = now();` → usa a app | Vai para login com mensagem digna (não crash) |

---

## 5. Concorrência — dois dedos no mesmo botão (~20 min)

Com dois tokens (Carlos e Admin), dispara pedidos simultâneos via PowerShell:

```powershell
# Duplo release simultâneo — só UM pode ganhar
$job1 = Start-Job { curl -X PATCH http://localhost:3000/api/v1/payments/<ID>/release -H "Authorization: Bearer <TOKEN_CARLOS>" }
$job2 = Start-Job { curl -X PATCH http://localhost:3000/api/v1/payments/<ID>/release -H "Authorization: Bearer <TOKEN_ADMIN>" }
Receive-Job $job1, $job2 -Wait
```
- ✅ Um 200, um 400. Ledger com UMA saída só. Reconciliação bate.

Repete o padrão para: dois `confirm` na última unidade (um deve falhar),
duas resoluções de disputa diferentes (uma deve falhar), dois `mark-held`.

---

## 6. Fluxo de serviços — o segundo escrow (~30 min)

1. Paula publica um serviço (categoria SERVICE) → Admin aprova.
2. Carlos abre um pedido **urgente** → Paula envia orçamento (a app deve exigir
   a majoração de urgência correcta).
3. Carlos aceita → ✅ ServiceBooking criado + Payment PENDING (aceitar 2ª vez → 400).
4. Paga (mock) → Paula inicia (`start`) → conclui (`complete`) → Carlos liberta.
5. ✅ Ledger/payout como no equipamento (sem depósito). Reviews nos dois sentidos.

> Nota conhecida: a gestão do ServiceBooking (start/complete) ainda não tem UI
> completa — testa esses passos via Swagger e regista as lacunas de UI que
> encontrares para o backlog do frontend.

## 7. Chat e notificações (~15 min)

- Carlos inicia conversa a partir de um equipamento; troca mensagens com a Paula.
- ✅ Mensagens persistem; badge de não-lidas atualiza (~30s).
- ⚠️ **Limitação conhecida:** a mensagem só aparece ao reentrar no ecrã (sem
  tempo real ainda). Confirma que pelo menos isso funciona.
- Push: com a app fechada, cria uma reserva → Paula recebe push → tocar abre o ecrã certo.

## 8. Qualidade visual e UX (transversal)

Durante toda a tour, mantém o olho de utilizador exigente:
- Estados vazios fazem sentido? ("Sem reservas" vs ecrã branco)
- Todos os erros têm mensagem em português legível? (nunca "Error 500")
- Loading em todas as ações? Botões desativam durante submit?
- Valores monetários sempre formatados (MZN 2.650 e não 2650.0000001)?
- Textos consistentes em PT (sem "Available now" perdido)?

---

## 9. Critério de aceitação final

A plataforma "passa" esta tour quando:

1. **O caminho do dinheiro (secção 1) fecha com reconciliação exacta** — entrou = saiu, sempre.
2. **Todas as 15 linhas da secção 3 falham como devido** — zero bypasses.
3. **R1–R9 passam** — a app sobrevive à rede real.
4. **Concorrência (5) nunca duplica dinheiro nem unidades.**
5. Zero crashes para ecrã branco em toda a tour.
6. O caderno de bugs tem só itens "feio/menor" — nada que bloqueie ou corrompa estado.

Bugs encontrados → trazem-se para a sessão seguinte por ordem:
corrompe dinheiro > bloqueia fluxo > erro visível > estético.
