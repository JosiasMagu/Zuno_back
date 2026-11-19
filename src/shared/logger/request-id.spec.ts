import type { IncomingMessage, ServerResponse } from 'http';

import { assignRequestId } from './request-id';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function exchange(incoming?: string | string[]) {
  const setHeader = jest.fn();
  const request = {
    headers: incoming === undefined ? {} : { 'x-request-id': incoming },
  } as unknown as IncomingMessage;
  const response = { setHeader } as unknown as ServerResponse;

  return { request, response, setHeader };
}

describe('assignRequestId', () => {
  it('gives a request without an id a new UUID', () => {
    const { request, response } = exchange();

    expect(assignRequestId(request, response)).toMatch(UUID);
  });

  it('gives each request its own id', () => {
    const first = exchange();
    const second = exchange();

    expect(assignRequestId(first.request, first.response)).not.toBe(
      assignRequestId(second.request, second.response),
    );
  });

  it('keeps the id the caller sent, so it can be followed across systems', () => {
    const { request, response } = exchange('app-7f3c2a91-b');

    expect(assignRequestId(request, response)).toBe('app-7f3c2a91-b');
  });

  it('sends the id back in the X-Request-Id header', () => {
    const { request, response, setHeader } = exchange('app-7f3c2a91-b');

    assignRequestId(request, response);

    expect(setHeader).toHaveBeenCalledWith('X-Request-Id', 'app-7f3c2a91-b');
  });

  it.each([
    ['too short', 'abc'],
    ['too long', 'a'.repeat(65)],
    ['with a line break', 'pedido-0001\nlinha forjada'],
    ['with spaces', 'pedido 0001 extra'],
    ['with markup', '<script>alert(1)</script>'],
  ])('ignores an incoming id %s', (_label, incoming) => {
    const { request, response } = exchange(incoming);

    const id = assignRequestId(request, response);

    expect(id).toMatch(UUID);
    expect(id).not.toBe(incoming);
  });

  it('ignores a header sent more than once', () => {
    const { request, response } = exchange(['pedido-0001', 'pedido-0002']);

    expect(assignRequestId(request, response)).toMatch(UUID);
  });
});
