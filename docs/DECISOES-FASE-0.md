# ZUNO — Decisões de Desenho (Fase 0)

> Documento de decisões de arquitetura e negócio que antecedem as retificações (Fases 1–4).
> Cada decisão tem uma **proposta recomendada** que vigora como default até ser confirmada ou alterada pelo responsável do produto.
>
> Estado possível: `PROPOSTA` (aguarda confirmação) · `APROVADA` · `ALTERADA` (ver nota)
> Data: 2026-07-02

---

## D1 — Ciclo de vida do escrow (aluguer de equipamento)

**Estado:** APROVADA (2026-07-02)

**Contexto:** hoje o `release` acontece quando o cliente confirma a entrega (início do aluguer)
e liberta tudo de uma vez; disputas exigem pagamento `HELD`, logo tornam-se impossíveis após
a entrega; o depósito não tem fluxo próprio (é cobrado mas não tem reclamação nem devolução
modelada). O provider fica sem proteção na devolução. O estado `BookingStatus.ACTIVE` existe
no enum mas nunca é atingido.

**Decisão proposta — escrow de dois checkpoints:**

```
PENDING ─(provider confirma)→ CONFIRMED ─(pagamento HELD)→ [aguarda início]
  → CHECKPOINT 1 · ENTREGA: cliente confirma receção
      → liberta rentalAmount − platformFee ao provider
      → depósito CONTINUA retido
      → booking passa a ACTIVE
  → CHECKPOINT 2 · DEVOLUÇÃO: provider confirma devolução em boas condições
      → devolve depósito ao cliente → COMPLETED
      → OU provider abre reclamação sobre o depósito (janela: 48h após endDate)
          → disputa sobre o depósito → resolução admin
  → AUTO-RELEASE: se o cliente não confirmar entrega nem abrir disputa em N dias
    após startDate, o sistema liberta automaticamente (N=3, configurável)
  → AUTO-DEVOLUÇÃO: se o provider não confirmar devolução nem reclamar em 48h
    após endDate, o depósito devolve-se automaticamente
```

**Consequências técnicas:** ressuscitar `ACTIVE`; separar `rentalReleasedAt` de
`depositResolvedAt`; janelas de disputa por fase (antes da entrega: pagamento inteiro;
após devolução: depósito); dois schedulers novos (auto-release, auto-devolução).

**Impacto:** o escrow passa a proteger as duas partes — é o argumento contra a
desintermediação e a justificação da fee de 10%.

---

## D2 — Política financeira

**Estado:** APROVADA (2026-07-02)

**Contexto:** não existe política escrita para reembolso de fee, base do refund parcial
nem penalizações de cancelamento. O `resolvePartial` atual aplica a percentagem sobre
`totalCharged` (rental + fee + depósito) sem ajustar o `ownerPayout`, permitindo
desembolsar mais do que foi cobrado.

**Decisão proposta:**

| Regra | Valor |
|---|---|
| Base do refund parcial | **Só o `rentalAmount`**. Fee e depósito nunca entram na percentagem. |
| Platform fee em refund parcial | **Não reembolsável** (a mediação foi prestada). |
| Platform fee em refund total (disputa a favor do cliente antes da entrega) | **Reembolsável** (o serviço não aconteceu). |
| Depósito | Segue o fluxo próprio de D1 — nunca se mistura com refund do rental. |
| Invariante obrigatória | `refund_cliente + payout_provider + fee_retida = totalCharged` — validada no código em toda a resolução. |
| Cancelamento pelo CLIENTE | Grátis até 48h antes do `startDate`; depois, retém-se 30% do rental para o provider (fee da plataforma sobre a parte retida mantém-se). |
| Cancelamento pelo PROVIDER (reserva confirmada) | Refund total ao cliente **incluindo fee** + 1 strike ao provider; 3 strikes em 90 dias = suspensão de listagens. |

**Impacto:** cada fórmula do backend implementa uma regra explícita; a invariante torna
estruturalmente impossível a família de bugs de duplo desembolso.

---

## D3 — Ledger imutável + Payout modelado

**Estado:** APROVADA (2026-07-02)

**Contexto:** o `Payment` é uma linha mutável com enum de status; não há registo imutável
de movimentos. A saída real do dinheiro (payout ao provider, refund ao cliente) não tem
representação nenhuma — é executada manualmente fora do sistema, sem rasto. O provider
não tem campo para número M-Pesa de recebimento.

**Decisão proposta:** adotar já (antes da integração M-Pesa):
1. **`LedgerEntry`** append-only: `(paymentId, direction: IN|OUT, party: CLIENT|PROVIDER|PLATFORM, amount, reason, createdAt)`. Nada se apaga nem se atualiza. Invariante: `SUM(OUT) ≤ SUM(IN)` por payment.
2. **`Payout`**: entidade com estados `PENDING → EXECUTED | FAILED`, referência M-Pesa,
   executor (admin), timestamp. Enquanto a execução for manual, é manual **registada**.
3. **`payoutMsisdn`** (número M-Pesa de recebimento) no perfil do utilizador; obrigatório
   para receber payout.

**Impacto:** responde a "quanto dinheiro temos retido agora?"; pré-requisito da
integração M-Pesa; rede de segurança estrutural contra duplo desembolso; auditabilidade
financeira real.

---

## D4 — Modelo de roles: capacidades em vez de identidade

**Estado:** PROPOSTA

**Contexto:** `User.role` é `CLIENT | PROVIDER | ADMIN` exclusivo — um provider precisa de
segunda conta para alugar. As permissões reais já são maioritariamente verificadas por
posição na transação (`booking.clientId === userId`), não pelo role global.

**Decisão proposta:** qualquer conta pode **reservar** (capacidade base); **publicar**
equipamento/serviços exige KYC aprovado (capacidade adquirida); `ADMIN` mantém-se como
role real. `authorRole` das reviews e regras do chat derivam da posição no booking, não
do rótulo global. Migração agora, enquanto a base de utilizadores é pequena.

**Impacto:** dobra o mercado endereçável por utilizador; elimina a segunda conta;
o custo de migração é mínimo hoje e cresce com cada feature/utilizador novo.

---

## D5 — TTL de reservas não pagas

**Estado:** PROPOSTA

**Contexto:** reservas `PENDING` (nunca pagas) contam no cálculo de conflitos
(`bookings.service.ts:69`) e não expiram — bloqueiam o calendário para sempre.
Vetor de griefing a custo zero + inventário morto.

**Decisão proposta:** reserva sem pagamento `HELD` expira automaticamente em
**24h após a criação** (ou 2h antes do `startDate`, o que ocorrer primeiro).
Scheduler idêntico ao `ServicesScheduler` existente. O cliente é notificado do prazo
na criação e da expiração quando ocorre.

**Impacto:** calendários refletem a realidade; elimina griefing; cria urgência de
pagamento (conversão).

---

## D6 — Gate de KYC

**Estado:** PROPOSTA

**Contexto:** o módulo de verificações existe mas só condiciona o auto-approve de
equipamentos. Utilizadores não verificados podem receber dinheiro.

**Decisão proposta:**
- Reservar e pagar: **livre** (sem fricção para clientes).
- **Receber payout: exige KYC aprovado.** O dinheiro pode ficar `RELEASED` à espera,
  mas o `Payout` só se executa para contas verificadas.
- **Publicar equipamento/serviços: exige KYC aprovado** (integra com D4; o auto-approve
  de listagens já existente torna a moderação leve).

**Impacto:** o KYC ganha consumidor natural (quem quer ganhar dinheiro tem incentivo
para o completar); reduz risco regulatório antes do M-Pesa; alivia moderação manual
de listagens.

---

## D7 — Escopo do lançamento (módulos backend sem UI)

**Estado:** PROPOSTA

| Módulo órfão | Veredicto | Justificação |
|---|---|---|
| Recuperação de password + verificação de conta | **ENTRA** | Sem isto, cada password esquecida é uma conta perdida. Depende do driver SMS real (Fase 1). |
| Service bookings (gerir serviço pós-aceitação: start/complete/cancel) | **ENTRA** | Sem isto o fluxo de serviços não fecha — não pode ser anunciado. |
| Responder a disputa (provider) | **ENTRA** | O escrow de dois checkpoints (D1) precisa do provider como parte ativa. |
| Submissão de KYC (utilizador) | **ENTRA** | Consequência direta de D6. |
| Analytics do provider | ADIADO | Nice-to-have; não bloqueia nenhum fluxo. |
| Gestão avançada de fotos (multiple, set-primary, delete) | ADIADO | Upload single cobre o essencial. |
| Moderação de utilizadores na app | ADIADO → vai para o back-office (D8) | Ferramenta de secretária, não de telemóvel. |

**Impacto:** backlog de frontend fechado e realista; o que é adiado sai da narrativa
de lançamento em vez de ficar como promessa quebrada.

---

## D8 — Back-office web separado

**Estado:** PROPOSTA

**Contexto:** a operação vive num ecrã de 810 linhas na app móvel; as funções mais
críticas (confirmar pagamento `mark-held`, rever KYC) nem UI têm — são feitas por
Postman/curl. Não há fila de reconciliação nem registo de payouts.

**Decisão proposta:** criar um back-office **web** simples (mesma API; React-admin ou
equivalente) com, por ordem de prioridade:
1. **Fila de reconciliação de pagamentos** — payments `PENDING` com referência esperada
   (`receiptNumber`), match manual → `mark-held`.
2. **Execução e registo de payouts** (D3) — fila de payouts pendentes, marcar executado
   com referência M-Pesa.
3. **Fila de revisão KYC** — documentos, aprovar/rejeitar com motivo.
4. Disputas com contexto completo (histórico, evidências, valores).
5. Moderação de utilizadores (suspend/reactivate).

O painel admin sai da app móvel. Futuro: maker-checker (segundo admin) para operações
financeiras acima de limiar.

**Impacto:** transforma "operação por Postman" em processo com fila e rasto;
multiplica a capacidade do admin — que hoje é o teto de crescimento do negócio.

---

## Sequência após a Fase 0

- **Fase 1 — Estancar:** mock-pay gated · bug `providerId` · resolveClient/RELEASED ·
  driver SMS OTP · frontend (env/HTTPS, SecureStore, sessão) · contrato (unwrap central,
  codegen OpenAPI, OWNER→PROVIDER).
- **Fase 2 — Ciclo de vida:** implementa D1, D2, D3, D5 + máquina de estados centralizada
  do Payment + serialização/idempotência nas operações financeiras.
- **Fase 3 — Operação:** D8 (back-office) + eventos de domínio + Notification persistida +
  audit fail-closed + alerting + CD.
- **Fase 4 — Escala:** M-Pesa real (C2B/B2C) · TanStack Query + expo-image no frontend ·
  chat tempo-real · E2E de reversão · D4 (roles) se aprovada · UI dos módulos de D7.

> Nota: D4 (roles) pode ser implementada na Fase 2 (recomendado, custo mínimo agora)
> ou explicitamente adiada com data de revisão — a confirmar.
