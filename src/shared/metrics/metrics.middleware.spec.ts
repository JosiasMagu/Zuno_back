import { EventEmitter } from 'events';
import type { Request, Response } from 'express';

import { MetricsMiddleware } from './metrics.middleware';
import { MetricsService } from './metrics.service';

const metricsMock = {
  httpRequestsTotal: { inc: jest.fn() },
  httpRequestDurationSeconds: { observe: jest.fn() },
};

/** Uma resposta que se pode "acabar de enviar" à mão. */
function makeResponse(statusCode = 200) {
  const response = new EventEmitter() as EventEmitter & { statusCode: number };
  response.statusCode = statusCode;
  return response;
}

const makeRequest = (route?: string) =>
  ({
    method: 'GET',
    url: '/api/v1/equipment/3f2a?x=1',
    ...(route ? { route: { path: route } } : {}),
  }) as unknown as Request;

describe('MetricsMiddleware', () => {
  let middleware: MetricsMiddleware;

  beforeEach(() => {
    jest.resetAllMocks();
    middleware = new MetricsMiddleware(
      metricsMock as unknown as MetricsService,
    );
  });

  const handle = (
    request: Request,
    response: ReturnType<typeof makeResponse>,
  ) => {
    const next = jest.fn();
    middleware.use(request, response as unknown as Response, next);
    return next;
  };

  it('lets the request through without counting anything yet', () => {
    const next = handle(makeRequest('/api/v1/equipment/:id'), makeResponse());

    expect(next).toHaveBeenCalledTimes(1);
    expect(metricsMock.httpRequestsTotal.inc).not.toHaveBeenCalled();
  });

  it('counts the request when the response is sent, with the status the client got', () => {
    const response = makeResponse();
    handle(makeRequest('/api/v1/equipment/:id'), response);

    // O filtro de erros muda o estado depois de o pedido passar aqui.
    response.statusCode = 404;
    response.emit('finish');

    expect(metricsMock.httpRequestsTotal.inc).toHaveBeenCalledWith({
      method: 'GET',
      route: '/api/v1/equipment/:id',
      status: '404',
    });
  });

  it('times the request with the same labels', () => {
    const response = makeResponse(200);
    handle(makeRequest('/api/v1/equipment/:id'), response);

    response.emit('finish');

    const [labels, seconds] = metricsMock.httpRequestDurationSeconds.observe
      .mock.calls[0] as [Record<string, string>, number];
    expect(labels).toEqual({
      method: 'GET',
      route: '/api/v1/equipment/:id',
      status: '200',
    });
    expect(seconds).toBeGreaterThanOrEqual(0);
    expect(seconds).toBeLessThan(1);
  });

  it('labels a request that matched no route as unmatched, never with its URL', () => {
    const response = makeResponse(404);
    handle(makeRequest(), response);

    response.emit('finish');

    expect(metricsMock.httpRequestsTotal.inc).toHaveBeenCalledWith({
      method: 'GET',
      route: 'unmatched',
      status: '404',
    });
  });

  it('does not take the catch-all pattern of the middleware itself for a route', () => {
    const response = makeResponse(404);
    handle(makeRequest('/api/v1/{*splat}'), response);

    response.emit('finish');

    expect(metricsMock.httpRequestsTotal.inc).toHaveBeenCalledWith(
      expect.objectContaining({ route: 'unmatched' }),
    );
  });

  it('counts each request once', () => {
    const response = makeResponse();
    handle(makeRequest('/api/v1/equipment/:id'), response);

    response.emit('finish');
    response.emit('finish');

    expect(metricsMock.httpRequestsTotal.inc).toHaveBeenCalledTimes(1);
  });
});
