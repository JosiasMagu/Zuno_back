import { corsOrigin } from './cors';

const decide = (origin: string | undefined) => {
  const callback = jest.fn();
  corsOrigin(['https://app.zuno.co.mz'])(origin, callback);
  return callback.mock.calls[0] as [Error | null, boolean];
};

describe('corsOrigin', () => {
  it('aceita uma origem da lista', () => {
    expect(decide('https://app.zuno.co.mz')).toEqual([null, true]);
  });

  it('aceita um pedido sem Origin, como os da app nativa', () => {
    expect(decide(undefined)).toEqual([null, true]);
  });

  it('recusa outra origem sem erro, para a resposta não ser um 500', () => {
    expect(decide('https://outro-site.example')).toEqual([null, false]);
  });
});
