-- Índices do chat. Só acrescenta.
--
-- O histórico de uma conversa lê-se por ordem de data, o badge conta as
-- mensagens por ler e o tecto diário de conversas novas conta por cliente e
-- data. Sem estes índices, as três consultas percorriam a tabela inteira.

CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");

CREATE INDEX "Message_unread_idx" ON "Message"("conversationId") WHERE ("isRead" = false);

CREATE INDEX "Conversation_clientId_createdAt_idx" ON "Conversation"("clientId", "createdAt");
