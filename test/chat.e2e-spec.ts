import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createTestApp } from './helpers/app';
import { authHeader, loginAsOutsider } from './helpers/auth';
import {
  BookingFlowActors,
  createApprovedEquipment,
  createBooking,
  resetBookingFlow,
} from './helpers/booking-flow';
import { disconnectTestPrisma, getTestPrisma } from './helpers/db';

const MESSAGES_PER_MINUTE = 30;
const NEW_CONVERSATIONS_PER_DAY = 20;

describe('Chat E2E', () => {
  let app: INestApplication;
  let actors: BookingFlowActors;
  const prisma = () => getTestPrisma();

  beforeAll(async () => {
    app = await createTestApp();
  }, 30000);

  beforeEach(async () => {
    actors = await resetBookingFlow(app);
  });

  afterAll(async () => {
    await app.close();
    await disconnectTestPrisma();
  });

  const as = (token: string) => ({
    get: (path: string) =>
      request(actors.httpServer).get(`/api/v1${path}`).set(authHeader(token)),
    post: (path: string, body: object = {}) =>
      request(actors.httpServer)
        .post(`/api/v1${path}`)
        .set(authHeader(token))
        .send(body),
    patch: (path: string, body: object = {}) =>
      request(actors.httpServer)
        .patch(`/api/v1${path}`)
        .set(authHeader(token))
        .send(body),
  });

  const client = () => as(actors.client.accessToken);
  const provider = () => as(actors.provider.accessToken);

  /** O cliente abre conversa com o dono do equipamento. Devolve o id dela. */
  async function openConversation(equipmentId: string): Promise<string> {
    const response = await client()
      .post('/chat/conversations', {
        equipmentId,
        firstMessage: 'Bom dia, a betoneira está livre na próxima semana?',
      })
      .expect(201);

    return response.body.data.conversation.id as string;
  }

  const send = (
    who: ReturnType<typeof as>,
    conversationId: string,
    content: string,
  ) => who.post(`/chat/conversations/${conversationId}/messages`, { content });

  const unreadOf = async (who: ReturnType<typeof as>) =>
    (await who.get('/chat/unread-count').expect(200)).body.data
      .unreadCount as number;

  describe('starting a conversation', () => {
    it('opens one conversation per listing and writes in it from then on', async () => {
      const equipmentId = await createApprovedEquipment(actors);

      const first = await client().post('/chat/conversations', {
        equipmentId,
        firstMessage: 'Bom dia, está disponível?',
      });
      const second = await client().post('/chat/conversations', {
        equipmentId,
        firstMessage: 'E faz entrega em Matola?',
      });

      expect(first.status).toBe(201);
      expect(first.body.data.isNew).toBe(true);
      expect(second.body.data.isNew).toBe(false);
      expect(second.body.data.conversation.id).toBe(
        first.body.data.conversation.id,
      );
      expect(await prisma().conversation.count()).toBe(1);
      expect(await prisma().message.count()).toBe(2);
    });

    it('keeps one conversation when the same request arrives twice at once', async () => {
      const equipmentId = await createApprovedEquipment(actors);
      const body = { equipmentId, firstMessage: 'Bom dia, está disponível?' };

      const responses = await Promise.all([
        client().post('/chat/conversations', body),
        client().post('/chat/conversations', body),
      ]);

      expect(responses.map(({ status }) => status)).toEqual([201, 201]);
      expect(await prisma().conversation.count()).toBe(1);
      expect(await prisma().message.count()).toBe(2);
    });

    it('returns 404 for the listing of a suspended account', async () => {
      const equipmentId = await createApprovedEquipment(actors);
      await as(actors.admin.accessToken)
        .patch(`/users/${actors.provider.userId}/suspend`, {
          reason: 'Queixas de clientes.',
        })
        .expect(200);

      const response = await client().post('/chat/conversations', {
        equipmentId,
        firstMessage: 'Bom dia, está disponível?',
      });

      expect(response.status).toBe(404);
    });

    it('returns 429 after the daily limit of new conversations', async () => {
      const category = actors.seed.categories.construcao;
      await prisma().equipment.createMany({
        data: Array.from({ length: NEW_CONVERSATIONS_PER_DAY + 1 }, (_, n) => ({
          id: `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`,
          ownerId: actors.provider.userId,
          title: `Betoneira ${n}`,
          description: 'Betoneira para o teste do limite de conversas.',
          categoryId: category.id,
          pricePerDay: 1500,
          depositAmount: 0,
          location: 'Maputo',
          status: 'ACTIVE' as const,
        })),
      });
      const listings = await prisma().equipment.findMany({
        orderBy: { id: 'asc' },
        select: { id: true },
      });
      await prisma().conversation.createMany({
        data: listings.slice(0, NEW_CONVERSATIONS_PER_DAY).map(({ id }) => ({
          clientId: actors.client.userId,
          ownerId: actors.provider.userId,
          equipmentId: id,
        })),
      });

      const response = await client().post('/chat/conversations', {
        equipmentId: listings[NEW_CONVERSATIONS_PER_DAY].id,
        firstMessage: 'Faço mais barato fora da app.',
      });

      expect(response.status).toBe(429);
      expect(response.body.message).toBe(
        'Abriste muitas conversas novas hoje. O limite são 20 por dia.',
      );
      expect(await prisma().conversation.count()).toBe(
        NEW_CONVERSATIONS_PER_DAY,
      );
    });
  });

  describe('the owner of a listing writing to a client', () => {
    it('is allowed once the client has a booking on it', async () => {
      const equipmentId = await createApprovedEquipment(actors);
      await createBooking(actors, equipmentId, 5);

      const response = await provider().post('/chat/conversations', {
        equipmentId,
        clientId: actors.client.userId,
        firstMessage: 'Bom dia. A que horas posso entregar a betoneira?',
      });

      expect(response.status).toBe(201);
      expect(response.body.data.isNew).toBe(true);
      expect(response.body.data.conversation.other.id).toBe(
        actors.client.userId,
      );

      // É a mesma conversa que o cliente abriria: ele responde nela.
      const reply = await client().post('/chat/conversations', {
        equipmentId,
        firstMessage: 'Pode ser às 8h.',
      });
      expect(reply.body.data.isNew).toBe(false);
      expect(reply.body.data.conversation.id).toBe(
        response.body.data.conversation.id,
      );
    });

    it('returns 403 for a client with no booking on the listing', async () => {
      const equipmentId = await createApprovedEquipment(actors);

      const response = await provider().post('/chat/conversations', {
        equipmentId,
        clientId: actors.client.userId,
        firstMessage: 'Tenho uma betoneira que lhe pode interessar.',
      });

      expect(response.status).toBe(403);
      expect(await prisma().conversation.count()).toBe(0);
    });

    it('returns 403 when someone who does not own the listing names a client', async () => {
      const equipmentId = await createApprovedEquipment(actors);
      await createBooking(actors, equipmentId, 5);
      const outsider = await loginAsOutsider(app);

      const response = await as(outsider.accessToken).post(
        '/chat/conversations',
        {
          equipmentId,
          clientId: actors.client.userId,
          firstMessage: 'Olá, sou eu.',
        },
      );

      expect(response.status).toBe(403);
    });
  });

  describe('messages', () => {
    it('returns the message in the format the app reads', async () => {
      const conversationId = await openConversation(
        await createApprovedEquipment(actors),
      );

      const response = await send(provider(), conversationId, '  Está sim.  ');

      expect(response.status).toBe(201);
      expect(response.body.data).toMatchObject({
        conversationId,
        senderId: actors.provider.userId,
        senderName: expect.any(String) as string,
        content: 'Está sim.',
        isRead: false,
      });
      expect(response.body.data.sender).toBeUndefined();
    });

    it.each([
      ['an empty message', { content: '   ' }],
      ['a message that is not text', { content: 12345 }],
      ['a message longer than 1000 characters', { content: 'a'.repeat(1001) }],
    ])('returns 400 for %s', async (_label, body) => {
      const conversationId = await openConversation(
        await createApprovedEquipment(actors),
      );

      const response = await client().post(
        `/chat/conversations/${conversationId}/messages`,
        body,
      );

      expect(response.status).toBe(400);
      expect(await prisma().message.count()).toBe(1);
    });

    it('returns 403 to someone outside the conversation, for reading and for writing', async () => {
      const conversationId = await openConversation(
        await createApprovedEquipment(actors),
      );
      const outsider = as((await loginAsOutsider(app)).accessToken);

      const read = await outsider.get(`/chat/conversations/${conversationId}`);
      const write = await send(outsider, conversationId, 'Olá.');

      expect([read.status, write.status]).toEqual([403, 403]);
    });

    it('returns 429 after 30 messages in a minute, and counts the first of the conversation', async () => {
      const conversationId = await openConversation(
        await createApprovedEquipment(actors),
      );

      for (let sent = 1; sent < MESSAGES_PER_MINUTE; sent += 1) {
        await send(client(), conversationId, `Mensagem ${sent}`).expect(201);
      }
      const overLimit = await send(client(), conversationId, 'Mais uma.');
      const otherAccount = await send(provider(), conversationId, 'Recebi.');

      expect(overLimit.status).toBe(429);
      expect(otherAccount.status).toBe(201);
      expect(
        await prisma().message.count({
          where: { senderId: actors.client.userId },
        }),
      ).toBe(MESSAGES_PER_MINUTE);
    }, 60000);
  });

  describe('reading', () => {
    it('counts the unread messages of each conversation and clears them when read', async () => {
      const conversationId = await openConversation(
        await createApprovedEquipment(actors),
      );
      await send(provider(), conversationId, 'Está livre, sim.').expect(201);
      await send(provider(), conversationId, 'Quer reservar?').expect(201);

      const list = await client().get('/chat/conversations').expect(200);

      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0]).toMatchObject({
        id: conversationId,
        unreadCount: 2,
      });
      expect(list.body.meta).toMatchObject({ page: 1, limit: 30, total: 1 });
      expect(await unreadOf(client())).toBe(2);
      // O que o cliente escreveu continua por ler do lado do provider.
      expect(await unreadOf(provider())).toBe(1);

      await client().get(`/chat/conversations/${conversationId}`).expect(200);

      expect(await unreadOf(client())).toBe(0);
    });

    it('leaves unread what an older page did not deliver', async () => {
      const conversationId = await openConversation(
        await createApprovedEquipment(actors),
      );
      for (const content of ['Primeira.', 'Segunda.', 'Terceira.']) {
        await send(provider(), conversationId, content).expect(201);
      }

      // A segunda página, de uma mensagem cada, traz a «Segunda.».
      const older = await client()
        .get(`/chat/conversations/${conversationId}?page=2&limit=1`)
        .expect(200);

      expect(older.body.data.messages[0].content).toBe('Segunda.');
      expect(await unreadOf(client())).toBe(1);
      const stillUnread = await prisma().message.findMany({
        where: {
          conversationId,
          isRead: false,
          senderId: actors.provider.userId,
        },
        select: { content: true },
      });
      expect(stillUnread).toEqual([{ content: 'Terceira.' }]);
    });

    it.each([
      ['more than 100 messages per page', '?limit=101'],
      ['a fractional page', '?page=1.5'],
    ])('returns 400 for %s', async (_label, query) => {
      const conversationId = await openConversation(
        await createApprovedEquipment(actors),
      );

      const response = await client().get(
        `/chat/conversations/${conversationId}${query}`,
      );

      expect(response.status).toBe(400);
    });

    it('returns 400 for more than 100 conversations per page', async () => {
      const response = await client().get('/chat/conversations?limit=101');

      expect(response.status).toBe(400);
    });
  });
});
