import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createTestApp } from './helpers/app';
import { authHeader } from './helpers/auth';
import { BookingFlowActors, resetBookingFlow } from './helpers/booking-flow';
import { disconnectTestPrisma } from './helpers/db';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Labels = { method: string; route: string; status: string };

/** Valor do contador de pedidos para estas etiquetas, lido de /metrics. */
function requestsCounted(exposition: string, labels: Labels): number {
  const line = exposition
    .split('\n')
    .find(
      (candidate) =>
        candidate.startsWith('zuno_http_requests_total{') &&
        candidate.includes(`method="${labels.method}"`) &&
        candidate.includes(`route="${labels.route}"`) &&
        candidate.includes(`status="${labels.status}"`),
    );

  return line ? Number(line.split(' ').pop()) : 0;
}

describe('Observability E2E', () => {
  let app: INestApplication;
  let actors: BookingFlowActors;

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

  const readMetrics = async () =>
    (await request(actors.httpServer).get('/metrics').expect(200)).text;

  /** Quanto o contador destas etiquetas subiu durante `action`. */
  async function countedDuring(labels: Labels, action: () => Promise<unknown>) {
    const before = requestsCounted(await readMetrics(), labels);
    await action();
    return requestsCounted(await readMetrics(), labels) - before;
  }

  describe('request metrics', () => {
    it('count a 404 as a 404, under the route pattern', async () => {
      const notFound = {
        method: 'GET',
        route: '/api/v1/equipment/:id',
        status: '404',
      };
      const asSuccess = { ...notFound, status: '200' };
      const successesBefore = requestsCounted(await readMetrics(), asSuccess);

      const counted = await countedDuring(notFound, () =>
        request(actors.httpServer)
          .get(`/api/v1/equipment/${randomUUID()}`)
          .expect(404),
      );

      expect(counted).toBe(1);
      expect(requestsCounted(await readMetrics(), asSuccess)).toBe(
        successesBefore,
      );
    });

    it('count a request refused by the authentication guard', async () => {
      const counted = await countedDuring(
        { method: 'GET', route: '/api/v1/payments/me', status: '401' },
        () => request(actors.httpServer).get('/api/v1/payments/me').expect(401),
      );

      expect(counted).toBe(1);
    });

    it('count a request refused for lack of permission', async () => {
      const counted = await countedDuring(
        {
          method: 'GET',
          route: '/api/v1/payments/admin/reconciliation',
          status: '403',
        },
        () =>
          request(actors.httpServer)
            .get('/api/v1/payments/admin/reconciliation')
            .set(authHeader(actors.client.accessToken))
            .expect(403),
      );

      expect(counted).toBe(1);
    });

    it('put every address that matches no route under one label', async () => {
      const counted = await countedDuring(
        { method: 'GET', route: 'unmatched', status: '404' },
        async () => {
          await request(actors.httpServer)
            .get(`/api/v1/nao-existe-${randomUUID()}`)
            .expect(404);
          await request(actors.httpServer)
            .get(`/api/v1/outra-${randomUUID()}/coisa`)
            .expect(404);
        },
      );

      expect(counted).toBe(2);
      expect(await readMetrics()).not.toContain('nao-existe-');
    });

    it('count successful requests too', async () => {
      const counted = await countedDuring(
        { method: 'GET', route: '/api/v1/equipment', status: '200' },
        () => request(actors.httpServer).get('/api/v1/equipment').expect(200),
      );

      expect(counted).toBe(1);
    });
  });

  describe('request id', () => {
    it('comes back in a header on every response', async () => {
      const response = await request(actors.httpServer)
        .get('/api/v1/equipment')
        .expect(200);

      expect(response.headers['x-request-id']).toMatch(UUID);
    });

    it('is different for each request', async () => {
      const first = await request(actors.httpServer).get('/api/v1/equipment');
      const second = await request(actors.httpServer).get('/api/v1/equipment');

      expect(first.headers['x-request-id']).not.toBe(
        second.headers['x-request-id'],
      );
    });

    it('is in the body of an error, the same as in the header', async () => {
      const response = await request(actors.httpServer)
        .get(`/api/v1/equipment/${randomUUID()}`)
        .expect(404);

      expect(response.body.requestId).toMatch(UUID);
      expect(response.body.requestId).toBe(response.headers['x-request-id']);
    });

    it('is the one the caller sent, when it has an acceptable format', async () => {
      const response = await request(actors.httpServer)
        .get('/api/v1/payments/me')
        .set('X-Request-Id', 'app-7f3c2a91-b')
        .expect(401);

      expect(response.headers['x-request-id']).toBe('app-7f3c2a91-b');
      expect(response.body.requestId).toBe('app-7f3c2a91-b');
    });

    it('is replaced when the caller sends something that is not an id', async () => {
      const response = await request(actors.httpServer)
        .get('/api/v1/equipment')
        .set('X-Request-Id', 'um pedido com espaços')
        .expect(200);

      expect(response.headers['x-request-id']).toMatch(UUID);
    });
  });
});

describe('Observability E2E: /metrics with a token', () => {
  const TOKEN = 'm'.repeat(40);
  let app: INestApplication;
  let httpServer: ReturnType<INestApplication['getHttpServer']>;
  const previousToken = process.env.METRICS_TOKEN;

  beforeAll(async () => {
    process.env.METRICS_TOKEN = TOKEN;
    app = await createTestApp();
    httpServer = app.getHttpServer();
  }, 30000);

  afterAll(async () => {
    await app.close();
    await disconnectTestPrisma();

    if (previousToken === undefined) {
      delete process.env.METRICS_TOKEN;
    } else {
      process.env.METRICS_TOKEN = previousToken;
    }
  });

  it('refuses a scrape without the token', async () => {
    const response = await request(httpServer).get('/metrics');

    expect(response.status).toBe(401);
    expect(response.text).not.toContain('zuno_http_requests_total');
  });

  it.each([
    ['a wrong token', `Bearer ${'x'.repeat(40)}`],
    ['a token that is too short', 'Bearer mmmm'],
    ['the token without the Bearer prefix', TOKEN],
  ])('refuses %s', async (_label, authorization) => {
    await request(httpServer)
      .get('/metrics')
      .set('Authorization', authorization)
      .expect(401);
  });

  it('answers the scraper that sends the token', async () => {
    const response = await request(httpServer)
      .get('/metrics')
      .set('Authorization', `Bearer ${TOKEN}`)
      .expect(200);

    expect(response.text).toContain('zuno_http_requests_total');
    // As falhas dos jobs têm de estar expostas para um alerta as vigiar.
    expect(response.text).toContain('zuno_job_failures_total');
  });
});
