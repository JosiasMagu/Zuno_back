import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AddressInfo } from 'net';
import { io as ioClient } from 'socket.io-client';

import { AppModule } from '../src/app.module';
import { loginViaApi } from './helpers/auth';
import { disconnectTestPrisma, truncateAllTables } from './helpers/db';
import { seedMinimalTestData, TEST_PASSWORD } from './helpers/seed-test-data';

const TIMEOUT_MS = 5_000;

/**
 * Liga ao socket e devolve o que aconteceu: a mensagem de erro que o servidor
 * enviou antes de fechar, ou null se a ligação ficou aberta.
 */
function connectAndWaitForRefusal(
  url: string,
  token: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = ioClient(url, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
      timeout: TIMEOUT_MS,
    });
    let refusal: string | undefined;

    const timer = setTimeout(() => {
      socket.close();
      resolve(null);
    }, TIMEOUT_MS);

    socket.on('error', (payload: { message?: string }) => {
      refusal = payload?.message;
    });
    socket.once('disconnect', () => {
      clearTimeout(timer);
      socket.close();
      resolve(refusal ?? 'ligação fechada');
    });
    socket.once('connect_error', (error: Error) => {
      clearTimeout(timer);
      socket.close();
      resolve(error.message);
    });
  });
}

// O socket do chat vem desligado por omissão: a app usa só o REST.
describe('Chat WebSocket desligado E2E', () => {
  let app: INestApplication;
  let chatUrl: string;

  beforeAll(async () => {
    delete process.env.CHAT_GATEWAY_ENABLED;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.listen(0);

    const address = (
      app.getHttpServer() as { address(): AddressInfo | string }
    ).address();
    if (typeof address === 'string' || !address) {
      throw new Error('Nao foi possivel obter a porta do servidor de teste.');
    }
    chatUrl = `http://127.0.0.1:${address.port}/chat`;
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await disconnectTestPrisma();
  });

  it('recusa a ligação mesmo com um token válido', async () => {
    await truncateAllTables();
    const seed = await seedMinimalTestData();
    const client = await loginViaApi(app, seed.client.phone, TEST_PASSWORD);

    const refusal = await connectAndWaitForRefusal(chatUrl, client.accessToken);

    expect(refusal).toBe('O chat em tempo real está desligado.');
  });

  it('recusa a ligação sem token da mesma maneira', async () => {
    const refusal = await connectAndWaitForRefusal(chatUrl, '');

    expect(refusal).toBe('O chat em tempo real está desligado.');
  });
});
