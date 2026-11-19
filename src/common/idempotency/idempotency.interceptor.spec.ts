import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of, throwError } from 'rxjs';

import { ApiException } from '../exceptions/api.exception';
import { ErrorCode } from '../exceptions/error-codes';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { IdempotencyService } from './idempotency.service';

const USER_ID = 'client-uuid-001';

const idempotencyMock = {
  hashRequest: jest.fn(),
  tryAcquire: jest.fn(),
  complete: jest.fn(),
  release: jest.fn(),
};
const reflectorMock = { get: jest.fn() };
const responseMock = { statusCode: 201, status: jest.fn() };

interface FakeRequest {
  method?: string;
  originalUrl?: string;
  headers?: Record<string, string>;
  user?: { id: string };
  body?: unknown;
  query?: unknown;
}

function contextFor(request: FakeRequest = {}): ExecutionContext {
  const full = {
    method: 'PATCH',
    originalUrl: '/api/v1/payments/payment-a/release?source=app',
    headers: { 'idempotency-key': 'chave-001' },
    user: { id: USER_ID },
    body: { note: 'ok' },
    query: { source: 'app' },
    ...request,
  };

  return {
    getHandler: () => () => undefined,
    switchToHttp: () => ({
      getRequest: () => full,
      getResponse: () => responseMock,
    }),
  } as unknown as ExecutionContext;
}

const handlerReturning = (body: unknown): CallHandler => ({
  handle: jest.fn(() => of(body)),
});

describe('IdempotencyInterceptor', () => {
  let interceptor: IdempotencyInterceptor;

  beforeEach(() => {
    jest.resetAllMocks();
    reflectorMock.get.mockReturnValue({ ttlHours: 24 });
    idempotencyMock.hashRequest.mockReturnValue('hash-a');
    idempotencyMock.tryAcquire.mockResolvedValue({ status: 'acquired' });
    idempotencyMock.complete.mockResolvedValue(undefined);
    idempotencyMock.release.mockResolvedValue(undefined);
    responseMock.statusCode = 201;

    interceptor = new IdempotencyInterceptor(
      reflectorMock as unknown as Reflector,
      idempotencyMock as unknown as IdempotencyService,
    );
  });

  const run = async (context: ExecutionContext, handler: CallHandler) =>
    firstValueFrom(await interceptor.intercept(context, handler));

  it('stays out of the way on routes that are not idempotent', async () => {
    reflectorMock.get.mockReturnValue(undefined);
    const handler = handlerReturning({ ok: true });

    expect(await run(contextFor(), handler)).toEqual({ ok: true });
    expect(idempotencyMock.tryAcquire).not.toHaveBeenCalled();
  });

  it('requires the Idempotency-Key header', async () => {
    await expect(
      run(contextFor({ headers: {} }), handlerReturning({})),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('requires an authenticated user', async () => {
    await expect(
      run(contextFor({ user: undefined }), handlerReturning({})),
    ).rejects.toMatchObject({ status: 401 });
  });

  describe('what identifies a request', () => {
    it('is the key, the user and the real path, without the query string', async () => {
      await run(contextFor(), handlerReturning({}));

      expect(idempotencyMock.tryAcquire).toHaveBeenCalledWith({
        key: 'chave-001',
        userId: USER_ID,
        endpoint: 'PATCH /api/v1/payments/payment-a/release',
        requestHash: 'hash-a',
        ttlHours: 24,
      });
    });

    it('treats the same key on another resource as another request', async () => {
      await run(contextFor(), handlerReturning({}));
      await run(
        contextFor({ originalUrl: '/api/v1/payments/payment-b/release' }),
        handlerReturning({}),
      );

      const endpoints = idempotencyMock.tryAcquire.mock.calls.map(
        ([args]: [{ endpoint: string }]) => args.endpoint,
      );
      expect(endpoints).toEqual([
        'PATCH /api/v1/payments/payment-a/release',
        'PATCH /api/v1/payments/payment-b/release',
      ]);
    });

    it('hashes the body together with the query', async () => {
      await run(contextFor(), handlerReturning({}));

      expect(idempotencyMock.hashRequest).toHaveBeenCalledWith(
        { note: 'ok' },
        { source: 'app' },
      );
    });
  });

  describe('a key that is free', () => {
    it('runs the request and stores the answer before sending it', async () => {
      const order: string[] = [];
      idempotencyMock.complete.mockImplementation(() => {
        order.push('guardada');
        return Promise.resolve();
      });

      const body = await run(contextFor(), handlerReturning({ id: 'b-1' }));
      order.push('enviada');

      expect(body).toEqual({ id: 'b-1' });
      expect(order).toEqual(['guardada', 'enviada']);
      expect(idempotencyMock.complete).toHaveBeenCalledWith({
        key: 'chave-001',
        userId: USER_ID,
        endpoint: 'PATCH /api/v1/payments/payment-a/release',
        statusCode: 201,
        body: { id: 'b-1' },
      });
    });

    it('frees the key when the request fails, and passes the error on', async () => {
      const failure = new Error('reserva já não existe');
      const handler: CallHandler = { handle: () => throwError(() => failure) };

      await expect(run(contextFor(), handler)).rejects.toBe(failure);

      expect(idempotencyMock.release).toHaveBeenCalledWith({
        key: 'chave-001',
        userId: USER_ID,
        endpoint: 'PATCH /api/v1/payments/payment-a/release',
      });
      expect(idempotencyMock.complete).not.toHaveBeenCalled();
    });
  });

  describe('a key that was already used', () => {
    it('repeats the stored answer without running the request again', async () => {
      idempotencyMock.tryAcquire.mockResolvedValue({
        status: 'replay',
        response: { statusCode: 201, body: { id: 'b-1' } },
      });
      const handler = handlerReturning({ id: 'outra' });

      expect(await run(contextFor(), handler)).toEqual({ id: 'b-1' });
      expect(handler.handle).not.toHaveBeenCalled();
      expect(responseMock.status).toHaveBeenCalledWith(201);
    });

    it.each([
      ['in-progress', ErrorCode.IDEMPOTENCY_KEY_REUSED],
      ['mismatch', ErrorCode.IDEMPOTENCY_KEY_MISMATCH],
    ])('answers 409 when the key is %s', async (status, errorCode) => {
      idempotencyMock.tryAcquire.mockResolvedValue({ status });
      const handler = handlerReturning({});

      const attempt = run(contextFor(), handler);

      await expect(attempt).rejects.toThrow(ApiException);
      await expect(attempt).rejects.toMatchObject({
        status: 409,
        response: { errorCode },
      });
      expect(handler.handle).not.toHaveBeenCalled();
    });
  });
});
