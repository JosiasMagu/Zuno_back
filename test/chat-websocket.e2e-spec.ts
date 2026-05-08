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
});
