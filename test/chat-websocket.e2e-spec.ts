import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { io as ioClient, Socket } from 'socket.io-client';
import { AddressInfo } from 'net';

import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import {
  truncateAllTables,
  disconnectTestPrisma,
  getTestPrisma,
} from './helpers/db';
import {
  seedMinimalTestData,
  TEST_PASSWORD,
  TestSeedResult,
} from './helpers/seed-test-data';
import { loginViaApi, authHeader, LoginResult } from './helpers/auth';

const CONNECT_TIMEOUT_MS = 5_000;
const EVENT_TIMEOUT_MS = 5_000;

function waitForEvent<T = unknown>(
  socket: Socket,
  event: string,
  timeoutMs = EVENT_TIMEOUT_MS,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event);
      reject(new Error(`Timeout aguardando evento "${event}"`));
    }, timeoutMs);

    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function connectSocket(url: string, token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(url, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
      timeout: CONNECT_TIMEOUT_MS,
    });

    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`Timeout a conectar ao socket ${url}`));
    }, CONNECT_TIMEOUT_MS);

    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });

    socket.once('connect_error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function expectAuthRejection(url: string, token: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(url, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
      timeout: CONNECT_TIMEOUT_MS,
    });

    const timer = setTimeout(() => {
      socket.close();
      reject(
        new Error(
          'Socket nao foi desconectado pelo gateway dentro do tempo esperado.',
        ),
      );
    }, CONNECT_TIMEOUT_MS);

    socket.once('disconnect', () => {
      clearTimeout(timer);
      socket.close();
      resolve();
    });

    socket.once('connect_error', () => {
      clearTimeout(timer);
      socket.close();
      resolve();
    });
  });
}

describe('Chat WebSocket E2E', () => {
  let app: INestApplication;
  let baseUrl: string;
  let seed: TestSeedResult;
  let clientAuth: LoginResult;
  let providerAuth: LoginResult;
  let adminAuth: LoginResult;
  let equipmentId: string;
  let conversationId: string;

  beforeAll(async () => {
    // O socket vem desligado por omissão. Estes testes são os que o ligam.
    process.env.CHAT_GATEWAY_ENABLED = 'true';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());

    await app.listen(0);

    const server = app.getHttpServer() as { address(): AddressInfo | string };
    const address = server.address();
    if (typeof address === 'string' || !address) {
      throw new Error('Nao foi possivel obter a porta do servidor de teste.');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 30_000);

  beforeEach(async () => {
    await truncateAllTables();
    seed = await seedMinimalTestData();

    clientAuth = await loginViaApi(app, seed.client.phone, TEST_PASSWORD);
    providerAuth = await loginViaApi(app, seed.provider.phone, TEST_PASSWORD);
    adminAuth = await loginViaApi(app, seed.admin.phone, TEST_PASSWORD);

    const eqRes = await request(app.getHttpServer())
      .post('/api/v1/equipment')
      .set(authHeader(providerAuth.accessToken))
      .send({
        title: 'Betoneira para chat E2E',
        description:
          'Equipamento usado para testar o gateway de chat em tempo real.',
        categoryId: seed.categories.construcao.id,
        pricePerDay: 1500,
        depositAmount: 5000,
        location: 'Maputo, Cidade',
        condition: 'EXCELLENT',
      });
    equipmentId = eqRes.body?.data?.id as string;

    await request(app.getHttpServer())
      .patch(`/api/v1/equipment/${equipmentId}/approve`)
      .set(authHeader(adminAuth.accessToken))
      .send({});

    const startRes = await request(app.getHttpServer())
      .post('/api/v1/chat/conversations')
      .set(authHeader(clientAuth.accessToken))
      .send({
        equipmentId,
        firstMessage: 'Ola, este equipamento esta disponivel?',
      });
    conversationId = startRes.body?.data?.conversation?.id as string;
    expect(conversationId).toBeDefined();
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await disconnectTestPrisma();
  });

  it('rejeita conexao sem token', async () => {
    await expect(
      expectAuthRejection(`${baseUrl}/chat`, ''),
    ).resolves.toBeUndefined();
  });

  it('rejeita conexao com token invalido', async () => {
    await expect(
      expectAuthRejection(`${baseUrl}/chat`, 'invalid.jwt.token'),
    ).resolves.toBeUndefined();
  });

  it('cliente e provider conectam, entram na conversa e trocam mensagem em tempo real', async () => {
    const clientSocket = await connectSocket(
      `${baseUrl}/chat`,
      clientAuth.accessToken,
    );
    const providerSocket = await connectSocket(
      `${baseUrl}/chat`,
      providerAuth.accessToken,
    );

    try {
      const clientJoined = waitForEvent(clientSocket, 'joined_conversation');
      clientSocket.emit('join_conversation', { conversationId });
      await clientJoined;

      const providerJoined = waitForEvent(
        providerSocket,
        'joined_conversation',
      );
      providerSocket.emit('join_conversation', { conversationId });
      await providerJoined;

      const providerReceived = waitForEvent<{
        data: { content: string; senderId: string };
      }>(providerSocket, 'new_message');

      clientSocket.emit('send_message', {
        conversationId,
        content: 'Mensagem em tempo real',
      });

      const payload = await providerReceived;
      expect(payload.data.content).toBe('Mensagem em tempo real');
      expect(payload.data.senderId).toBe(clientAuth.userId);

      const prisma = getTestPrisma();
      const stored = await prisma.message.findFirst({
        where: { conversationId, content: 'Mensagem em tempo real' },
      });
      expect(stored).not.toBeNull();
      expect(stored?.senderId).toBe(clientAuth.userId);
    } finally {
      clientSocket.close();
      providerSocket.close();
    }
  }, 30_000);

  const chatUrl = () => `${baseUrl}/chat`;

  /** Entra na conversa e espera pela confirmação do servidor. */
  async function join(socket: Socket) {
    const joined = waitForEvent(socket, 'joined_conversation');
    socket.emit('join_conversation', { conversationId });
    await joined;
  }

  describe('sessão terminada', () => {
    it('fecha o socket de uma conta que é suspensa', async () => {
      const socket = await connectSocket(chatUrl(), clientAuth.accessToken);

      try {
        const closed = waitForEvent(socket, 'disconnect');

        await request(app.getHttpServer())
          .patch(`/api/v1/users/${clientAuth.userId}/suspend`)
          .set(authHeader(adminAuth.accessToken))
          .send({ reason: 'Queixas de providers.' })
          .expect(200);

        await closed;
        expect(socket.connected).toBe(false);
      } finally {
        socket.close();
      }
    });

    it('fecha o socket no logout e recusa uma ligação nova com o token dessa sessão', async () => {
      const socket = await connectSocket(chatUrl(), providerAuth.accessToken);

      try {
        const closed = waitForEvent(socket, 'disconnect');

        await request(app.getHttpServer())
          .post('/api/v1/auth/logout')
          .send({ refreshToken: providerAuth.refreshToken })
          .expect(201);

        await closed;
      } finally {
        socket.close();
      }

      await expect(
        expectAuthRejection(chatUrl(), providerAuth.accessToken),
      ).resolves.toBeUndefined();
    });
  });

  describe('o que o socket aceita', () => {
    it('recusa a entrada de quem não pertence à conversa', async () => {
      const socket = await connectSocket(chatUrl(), adminAuth.accessToken);

      try {
        const refused = waitForEvent<{ message: string }>(socket, 'exception');
        socket.emit('join_conversation', { conversationId });

        expect((await refused).message).toBe(
          'Não tens acesso a esta conversa.',
        );
      } finally {
        socket.close();
      }
    });

    it('não passa o aviso de escrita de quem não entrou na conversa', async () => {
      const provider = await connectSocket(chatUrl(), providerAuth.accessToken);
      const client = await connectSocket(chatUrl(), clientAuth.accessToken);
      const intruder = await connectSocket(chatUrl(), adminAuth.accessToken);

      try {
        await join(provider);
        await join(client);

        const firstTyping = waitForEvent<{ userId: string }>(
          provider,
          'user_typing',
        );
        // O intruso tenta primeiro. Se o aviso dele passasse, chegava antes.
        intruder.emit('typing', { conversationId });
        await new Promise((resolve) => setTimeout(resolve, 300));
        client.emit('typing', { conversationId });

        expect((await firstTyping).userId).toBe(clientAuth.userId);
      } finally {
        provider.close();
        client.close();
        intruder.close();
      }
    });

    it.each([
      [
        'um conteúdo que não é texto',
        { content: 12345 },
        'content tem de ser texto.',
      ],
      ['um conteúdo em falta', {}, 'content tem de ser texto.'],
    ])('recusa %s e não grava nada', async (_label, payload, message) => {
      const socket = await connectSocket(chatUrl(), clientAuth.accessToken);

      try {
        const refused = waitForEvent<{ message: string }>(socket, 'exception');
        socket.emit('send_message', { conversationId, ...payload });

        expect((await refused).message).toBe(message);
        expect(
          await getTestPrisma().message.count({ where: { conversationId } }),
        ).toBe(1);
      } finally {
        socket.close();
      }
    });

    it('recusa um conversationId que não é um id', async () => {
      const socket = await connectSocket(chatUrl(), clientAuth.accessToken);

      try {
        const refused = waitForEvent<{ message: string }>(socket, 'exception');
        socket.emit('send_message', {
          conversationId: { not: 'um id' },
          content: 'Olá.',
        });

        expect((await refused).message).toBe('conversationId inválido.');
      } finally {
        socket.close();
      }
    });

    it('trava quem passa o limite de mensagens por minuto', async () => {
      const socket = await connectSocket(chatUrl(), clientAuth.accessToken);

      try {
        const refused = waitForEvent<{ message: string }>(
          socket,
          'exception',
          15_000,
        );
        for (let sent = 1; sent <= 35; sent += 1) {
          socket.emit('send_message', {
            conversationId,
            content: `Mensagem ${sent}`,
          });
        }

        expect((await refused).message).toContain('depressa de mais');

        // A primeira mensagem da conversa, enviada pelo REST, conta para o
        // mesmo limite: ao todo ficam gravadas 30.
        await new Promise((resolve) => setTimeout(resolve, 1000));
        expect(
          await getTestPrisma().message.count({
            where: { senderId: clientAuth.userId },
          }),
        ).toBe(30);
      } finally {
        socket.close();
      }
    }, 30_000);

    it('entrega a quem está no socket uma mensagem enviada pelo REST', async () => {
      const provider = await connectSocket(chatUrl(), providerAuth.accessToken);

      try {
        await join(provider);
        const received = waitForEvent<{
          data: { content: string; senderId: string };
        }>(provider, 'new_message');

        await request(app.getHttpServer())
          .post(`/api/v1/chat/conversations/${conversationId}/messages`)
          .set(authHeader(clientAuth.accessToken))
          .send({ content: 'Escrevi isto pela app.' })
          .expect(201);

        const payload = await received;
        expect(payload.data).toMatchObject({
          content: 'Escrevi isto pela app.',
          senderId: clientAuth.userId,
        });
      } finally {
        provider.close();
      }
    });

    it('não marca mensagens como lidas ao entrar na conversa', async () => {
      const provider = await connectSocket(chatUrl(), providerAuth.accessToken);

      try {
        await join(provider);

        const unread = await getTestPrisma().message.count({
          where: { conversationId, isRead: false },
        });
        expect(unread).toBe(1);
      } finally {
        provider.close();
      }
    });
  });
});
