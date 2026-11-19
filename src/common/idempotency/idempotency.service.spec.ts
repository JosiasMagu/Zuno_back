import { Prisma } from '@prisma/client';

import { PrismaService } from '../../shared/db/prisma.service';
import {
  IdempotencyService,
  IN_PROGRESS_LEASE_MS,
} from './idempotency.service';

const NOW = new Date('2030-06-01T10:00:00.000Z');
const HOUR_MS = 3_600_000;

const REQUEST = {
  key: 'chave-001',
  userId: 'client-uuid-001',
  endpoint: 'POST /api/v1/bookings',
};
const ACQUIRE = { ...REQUEST, requestHash: 'hash-a', ttlHours: 24 };

const prismaMock = {
  idempotencyKey: {
    create: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  },
};

const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError('chave repetida', {
    code: 'P2002',
    clientVersion: 'test',
  });

/** Um registo já existente para a mesma chave. */
const makeRecord = (overrides: Record<string, unknown> = {}) => ({
  id: 'registo-001',
  ...REQUEST,
  requestHash: 'hash-a',
  responseStatus: 201,
  responseBody: { data: { id: 'booking-uuid-001' } },
  createdAt: new Date(NOW.getTime() - 5_000),
  expiresAt: new Date(NOW.getTime() + 23 * HOUR_MS),
  ...overrides,
});

describe('IdempotencyService', () => {
  let service: IdempotencyService;

  beforeEach(() => {
    jest.resetAllMocks();
    // O relógio falso do Jest só aceita o instante em milissegundos.
    jest.useFakeTimers().setSystemTime(NOW.getTime());
    service = new IdempotencyService(prismaMock as unknown as PrismaService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('hashRequest', () => {
    it('is the same for the same body and query', () => {
      expect(service.hashRequest({ a: 1 }, { page: '2' })).toBe(
        service.hashRequest({ a: 1 }, { page: '2' }),
      );
    });

    it('changes with the body', () => {
      expect(service.hashRequest({ a: 1 })).not.toBe(
        service.hashRequest({ a: 2 }),
      );
    });

    it('changes with the query', () => {
      expect(service.hashRequest({ a: 1 }, { page: '1' })).not.toBe(
        service.hashRequest({ a: 1 }, { page: '2' }),
      );
    });

    it('does not depend on the order of the query parameters', () => {
      expect(service.hashRequest({}, { page: '1', limit: '10' })).toBe(
        service.hashRequest({}, { limit: '10', page: '1' }),
      );
    });

    it('treats a missing body as an empty one', () => {
      expect(service.hashRequest(undefined)).toBe(service.hashRequest({}));
    });
  });

  describe('tryAcquire', () => {
    it('takes a free key and marks the request as running', async () => {
      prismaMock.idempotencyKey.create.mockResolvedValue({});

      const result = await service.tryAcquire(ACQUIRE);

      expect(result).toEqual({ status: 'acquired' });
      expect(prismaMock.idempotencyKey.create).toHaveBeenCalledWith({
        data: {
          ...REQUEST,
          requestHash: 'hash-a',
          expiresAt: new Date(NOW.getTime() + 24 * HOUR_MS),
        },
      });
    });

    describe('when the key was already used', () => {
      beforeEach(() => {
        prismaMock.idempotencyKey.create.mockRejectedValue(uniqueViolation());
      });

      it('replays the stored answer for the same request', async () => {
        prismaMock.idempotencyKey.findUnique.mockResolvedValue(makeRecord());

        const result = await service.tryAcquire(ACQUIRE);

        expect(result).toEqual({
          status: 'replay',
          response: {
            statusCode: 201,
            body: { data: { id: 'booking-uuid-001' } },
          },
        });
      });

      it('refuses the same key with different data', async () => {
        prismaMock.idempotencyKey.findUnique.mockResolvedValue(
          makeRecord({ requestHash: 'hash-b' }),
        );

        expect(await service.tryAcquire(ACQUIRE)).toEqual({
          status: 'mismatch',
        });
      });

      it('makes the second request wait while the first is still running', async () => {
        prismaMock.idempotencyKey.findUnique.mockResolvedValue(
          makeRecord({ responseStatus: 0, responseBody: null }),
        );

        expect(await service.tryAcquire(ACQUIRE)).toEqual({
          status: 'in-progress',
        });
        expect(prismaMock.idempotencyKey.updateMany).not.toHaveBeenCalled();
      });

      it('takes the key again when the first request freed it in the meantime', async () => {
        prismaMock.idempotencyKey.findUnique.mockResolvedValue(null);
        prismaMock.idempotencyKey.create
          .mockRejectedValueOnce(uniqueViolation())
          .mockResolvedValueOnce({});

        expect(await service.tryAcquire(ACQUIRE)).toEqual({
          status: 'acquired',
        });
        expect(prismaMock.idempotencyKey.create).toHaveBeenCalledTimes(2);
      });
    });

    describe('a request that never finished', () => {
      const orphan = makeRecord({
        responseStatus: 0,
        responseBody: null,
        createdAt: new Date(NOW.getTime() - IN_PROGRESS_LEASE_MS - 1),
      });

      beforeEach(() => {
        prismaMock.idempotencyKey.create.mockRejectedValue(uniqueViolation());
        prismaMock.idempotencyKey.findUnique.mockResolvedValue(orphan);
      });

      it('stops blocking the key after a minute', async () => {
        prismaMock.idempotencyKey.updateMany.mockResolvedValue({ count: 1 });

        const result = await service.tryAcquire({
          ...ACQUIRE,
          requestHash: 'hash-b',
        });

        expect(result).toEqual({ status: 'acquired' });
        expect(prismaMock.idempotencyKey.updateMany).toHaveBeenCalledWith({
          where: {
            id: 'registo-001',
            createdAt: orphan.createdAt,
            responseStatus: 0,
          },
          data: {
            requestHash: 'hash-b',
            responseStatus: 0,
            responseBody: Prisma.JsonNull,
            createdAt: NOW,
            expiresAt: new Date(NOW.getTime() + 24 * HOUR_MS),
          },
        });
      });

      it('lets only one of two late requests take the key', async () => {
        prismaMock.idempotencyKey.updateMany.mockResolvedValue({ count: 0 });

        expect(await service.tryAcquire(ACQUIRE)).toEqual({
          status: 'in-progress',
        });
      });

      it('still blocks while the minute has not passed', async () => {
        prismaMock.idempotencyKey.findUnique.mockResolvedValue(
          makeRecord({
            responseStatus: 0,
            createdAt: new Date(NOW.getTime() - IN_PROGRESS_LEASE_MS + 1_000),
          }),
        );

        expect(await service.tryAcquire(ACQUIRE)).toEqual({
          status: 'in-progress',
        });
      });
    });

    it('runs the request again once the stored answer expired', async () => {
      prismaMock.idempotencyKey.create.mockRejectedValue(uniqueViolation());
      prismaMock.idempotencyKey.findUnique.mockResolvedValue(
        makeRecord({ expiresAt: new Date(NOW.getTime() - 1) }),
      );
      prismaMock.idempotencyKey.updateMany.mockResolvedValue({ count: 1 });

      expect(await service.tryAcquire(ACQUIRE)).toEqual({ status: 'acquired' });
    });

    it('does not hide a database error behind an answer', async () => {
      prismaMock.idempotencyKey.create.mockRejectedValue(
        new Error('base em baixo'),
      );

      await expect(service.tryAcquire(ACQUIRE)).rejects.toThrow(
        'base em baixo',
      );
    });
  });

  describe('complete', () => {
    const completion = { ...REQUEST, statusCode: 201, body: { ok: true } };

    it('stores the status and the body of the answer', async () => {
      prismaMock.idempotencyKey.update.mockResolvedValue({});

      await service.complete(completion);

      expect(prismaMock.idempotencyKey.update).toHaveBeenCalledWith({
        where: { key_userId_endpoint: REQUEST },
        data: { responseStatus: 201, responseBody: { ok: true } },
      });
    });

    it('tries again when the first write fails', async () => {
      prismaMock.idempotencyKey.update
        .mockRejectedValueOnce(new Error('ligação perdida'))
        .mockResolvedValueOnce({});

      const completing = service.complete(completion);
      await jest.runAllTimersAsync();
      await completing;

      expect(prismaMock.idempotencyKey.update).toHaveBeenCalledTimes(2);
    });

    it('gives up after three attempts without failing the request', async () => {
      prismaMock.idempotencyKey.update.mockRejectedValue(
        new Error('base em baixo'),
      );

      const completing = service.complete(completion);
      await jest.runAllTimersAsync();

      await expect(completing).resolves.toBeUndefined();
      expect(prismaMock.idempotencyKey.update).toHaveBeenCalledTimes(3);
    });
  });

  describe('release', () => {
    it('frees the key', async () => {
      prismaMock.idempotencyKey.delete.mockResolvedValue({});

      await service.release(REQUEST);

      expect(prismaMock.idempotencyKey.delete).toHaveBeenCalledWith({
        where: { key_userId_endpoint: REQUEST },
      });
    });

    it('never fails the request when the key cannot be freed', async () => {
      prismaMock.idempotencyKey.delete.mockRejectedValue(
        new Error('já não existe'),
      );

      await expect(service.release(REQUEST)).resolves.toBeUndefined();
    });
  });

  describe('purgeExpired', () => {
    it('deletes what is past its deadline and says how many', async () => {
      prismaMock.idempotencyKey.deleteMany.mockResolvedValue({ count: 7 });

      expect(await service.purgeExpired()).toBe(7);
      expect(prismaMock.idempotencyKey.deleteMany).toHaveBeenCalledWith({
        where: { expiresAt: { lt: NOW } },
      });
    });
  });
});
