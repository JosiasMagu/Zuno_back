# Integração M-Pesa

O backend já trata o dinheiro como se o fornecedor existisse. Hoje corre em modo manual (`PAYMENTS_PROVIDER=manual`): o cliente paga para o número da plataforma, declara a referência e o admin confirma pelo extracto. Em desenvolvimento há um simulador (`PAYMENTS_PROVIDER=simulator`) que cobra, envia e falha como um fornecedor a sério. O adaptador M-Pesa existe em `src/modules/payments/providers/mpesa.provider.ts`, mas está vazio e o arranque recusa-o (`ready = false`).

Ligar o M-Pesa resume-se a escrever esse adaptador e mudar a variável. As operações no fornecedor, as consultas de estado, os avisos, o envio dos payouts, o dinheiro por atribuir e a reconciliação já funcionam com o simulador e não mudam.

## O contrato do adaptador

A interface está em `src/modules/payments/providers/payment-provider.ts`.

| Membro | O que faz |
|---|---|
| `collects`, `transfers` | Se o fornecedor cobra no telemóvel e se envia dinheiro. Com `false`, a app volta ao pagamento declarado e os payouts ficam para execução manual. |
| `ready` | `true` só com os quatro métodos feitos. O `createPaymentProvider` recusa arrancar com um adaptador por acabar. |
| `requestCollection` | Pede ao cliente que pague `amount` no número `msisdn`. |
| `sendTransfer` | Envia `amount` para `msisdn` (payouts e devoluções). |
| `queryStatus` | Pergunta pelo estado de uma operação já pedida, pela nossa referência. |
| `parseEvent` | Traduz o corpo de um aviso (webhook) para o formato comum. Lança quando não o consegue ler. |

Cada resposta é um de quatro desfechos: `CONFIRMED` (com a referência do fornecedor, o valor que entrou ou saiu e, se o fornecedor a disser, a taxa), `FAILED` (com código e motivo), `PENDING` (aceite, à espera do cliente) e `UNKNOWN` (não se sabe).

As regras que o resto do código assume:

1. Na dúvida, `UNKNOWN`. Um timeout, uma ligação cortada ou uma resposta que não se lê nunca são `FAILED`, porque o dinheiro pode ter-se movido. Uma operação `UNKNOWN` nunca se repete: o job das operações (`ProviderOperationsService.pollDue`, de minuto a minuto) pergunta pelo estado com `queryStatus`, com intervalos que dobram até uma hora.
2. A nossa `reference` vai para o fornecedor como chave de idempotência. São 16 caracteres, `ZC`, `ZP` ou `ZR` mais 14 hexadecimais em maiúsculas. Repetir um pedido com a mesma referência não pode cobrar nem enviar duas vezes.
3. O número volta em E.164 (`+2588XXXXXXXX`). Se o fornecedor usar outro formato, o adaptador converte nos dois sentidos.
4. O valor confirmado é o que de facto se moveu. Se o cliente pagou menos, o adaptador devolve o valor menor e o backend põe o dinheiro de lado para devolução.
5. Um adaptador não lança em falhas de rede. Mesmo que lance, `callProvider` converte o erro em `UNKNOWN`.
6. A cobrança pode demorar o tempo que o cliente leva a pôr o PIN, e o pedido da app fica à espera dela. Se a chamada do fornecedor ficar presa mais do que uns segundos, o adaptador deve cortar e devolver `UNKNOWN` ou `PENDING`. A app mostra a cobrança como em curso e volta a ler `GET /payments/:id`.
7. Numa consulta (`queryStatus`), uma referência que o fornecedor ainda não conhece é `UNKNOWN`, e nunca `FAILED`. Um envio dado como falhado pode ser repetido por um admin, e se o primeiro afinal saiu o dinheiro sai duas vezes. O backend defende-se: aplica a confirmação que chegue depois de uma falha e pergunta ao fornecedor antes de repetir um payout. Essa defesa só cobre o que o fornecedor já sabe nesse momento. O simulador responde `FAILED` a uma referência desconhecida e não serve de exemplo neste ponto.

O ficheiro `payment-provider.contract.ts` tem `describePaymentProviderContract`, uma bateria de testes que qualquer adaptador tem de passar. Corre hoje contra o simulador (`simulator.provider.spec.ts`). Contra o M-Pesa, corre com as credenciais da sandbox.

## O que pedir à Vodacom ou ao agregador

As respostas a estas perguntas decidem como se escreve o adaptador:

- Credenciais de sandbox e de produção, e o que cada uma inclui.
- Se a cobrança no telemóvel (C2B) responde na mesma chamada depois do PIN ou se o resultado chega por aviso, e quanto tempo a chamada pode ficar aberta.
- Se há avisos (webhook), em que formato, e como se autenticam. O nosso endpoint espera o segredo partilhado no cabeçalho `x-zuno-webhook-token`. Se o fornecedor não puder enviar cabeçalhos, a verificação passa para o adaptador (assinatura ou lista de IPs), e isso decide-se antes de escrever o `parseEvent`.
- Se o envio para clientes e providers (B2C) está disponível na conta, com que limites por transacção e por dia.
- Por que referência se consulta o estado de uma operação: a nossa ou a deles.
- A tabela dos códigos de resposta. As bibliotecas comunitárias dizem que só existe no portal, depois de entrar.
- O formato do número de telefone nos pedidos e nas respostas.
- As taxas de cada operação, se vêm na resposta, e quem as paga.
- Os limites da carteira do cliente (por transacção e por dia), para a app avisar antes de cobrar uma reserva grande.
- Se é preciso autorizar o IP de saída do servidor.
- Como se obtém o extracto diário da conta, para conferir com a reconciliação.

## O que as fontes públicas dizem, por confirmar

Não encontrei a documentação oficial aberta. As bibliotecas comunitárias para Moçambique ([tekmpesa](https://tekmpesa.readthedocs.io/en/latest/_modules/mpesa/mozambique.html), [mpesa-laravel](https://packagist.org/packages/kelvinc/mpesa-laravel), a lista [awesome-mpesa](https://github.com/PauloPhagula/awesome-mpesa)) descrevem isto, e cada ponto tem de ser confirmado no portal da Vodacom (`developer.mpesa.vm.co.mz`, segundo essas bibliotecas):

- Credenciais: uma API key e uma chave pública do portal, mais um código de prestador de serviço (`ServiceProviderCode`). A chave de sessão obtém-se cifrando a API key com a chave pública.
- C2B em `/ipg/v1x/c2bPayment/singleStage/` (porta 18352), com `input_TransactionReference`, `input_CustomerMSISDN`, `input_Amount`, `input_ThirdPartyReference` e `input_ServiceProviderCode`.
- B2C em `/ipg/v1x/b2cPayment/` (porta 18345). Uma das bibliotecas escreve o caminho com uma gralha (`b2cPaymemt`), o que mostra que estas fontes não são de confiança.
- Estado em `/ipg/v1x/queryTransactionStatus/` (porta 18353), por `input_QueryReference`.
- Uma das bibliotecas aponta a sandbox para `api.sandbox.vm.co.mz`, e outras usam `openapi.m-pesa.com`.

`input_ThirdPartyReference` parece ser o sítio da nossa `reference`. Falta saber o comprimento máximo e se o fornecedor recusa uma referência repetida.

## No dia em que chegarem as credenciais

1. Juntar as variáveis das credenciais ao `env.validation.ts` e ao `.env.example` (sem valores). Nunca no código nem nos logs.
2. Escrever os quatro métodos do adaptador e pôr `collects`, `transfers` e `ready` de acordo com o que a conta permite.
3. Correr `describePaymentProviderContract` contra a sandbox, com os números de teste que a Vodacom der.
4. Decidir `PAYOUT_AUTO_MAX_AMOUNT` e `MONEY_FOUR_EYES` (ver abaixo) e definir `PAYMENTS_WEBHOOK_SECRET` com pelo menos 32 caracteres, se houver avisos.
5. Confirmar a cobrança na app. O detalhe da reserva já lê `GET /payments/instructions` e, em modo automático, pede a cobrança com `POST /payments/:id/collect` (`components/payments/BookingPaymentPanel.tsx`). Falta o mesmo para as reservas de serviço, que ainda não têm ecrã de pagamento.
6. Com mais de uma instância do servidor, os jobs de dinheiro correm em todas. Não enviam nem avisam duas vezes (a reserva `PENDING` para `SENDING` e as escritas condicionais impedem-no), mas consultam o fornecedor em dobro. O lock do backlog no `CLAUDE.md` evita isso.
7. Antes de abrir aos clientes, um ensaio com valores pequenos: cobrar, liberar, enviar o payout, reembolsar, e conferir a reconciliação com o extracto.

Mudar de `manual` para `mpesa` não deixa nada a meio: as operações manuais nascem todas confirmadas. Mudar de fornecedor com operações automáticas por responder deixa-as sem consulta (o job só pergunta ao fornecedor ligado), e a reconciliação aponta-as como `OPERATION_STUCK` ao fim de 6 horas.

## Decisões em aberto

- Quem paga as taxas. Hoje a plataforma absorve-as: a taxa fica na operação (`feeAmount`), a reconciliação desconta-a ao que devia estar na conta (`providerFees`) e os payouts saem pelo valor inteiro.
- `PAYOUT_AUTO_MAX_AMOUNT`: proposta de 5000 MZN. Acima disso, um payout espera aprovação de um admin.
- `MONEY_FOUR_EYES`: desligado. Ligado, quem confirmou a entrada de um pagamento não aprova nem executa as saídas dele, e o dinheiro confirmado à mão nunca sai sozinho: espera a aprovação de outro admin, seja qual for o valor. O dinheiro confirmado pelo fornecedor continua a sair sem aprovação até `PAYOUT_AUTO_MAX_AMOUNT`.
- Pagamento a mais: o pagamento fica retido pelo total e a diferença fica por atribuir, para devolver. A alternativa era recusar tudo e devolver o valor inteiro.
- Só M-Pesa ou também e-Mola e mKesh. Uma transacção conta uma vez, e a regra compara só a referência, sem o canal. Com uma segunda rede, as referências de redes diferentes podem coincidir e a regra tem de passar a comparar a rede.
