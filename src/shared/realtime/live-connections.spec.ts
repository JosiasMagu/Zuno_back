import { LiveConnections } from './live-connections';

describe('LiveConnections', () => {
  let live: LiveConnections;

  const connect = (sessionId: string, userId: string) => {
    const close = jest.fn();
    const unregister = live.register({ sessionId, userId, close });
    return { close, unregister };
  };

  beforeEach(() => {
    live = new LiveConnections();
  });

  it('fecha as ligações da sessão que acabou e deixa as outras', () => {
    const phone = connect('sessao-telemovel', 'ana');
    const tablet = connect('sessao-tablet', 'ana');

    const closed = live.closeSession('sessao-telemovel');

    expect(closed).toBe(1);
    expect(phone.close).toHaveBeenCalledTimes(1);
    expect(tablet.close).not.toHaveBeenCalled();
    expect(live.size).toBe(1);
  });

  it('fecha todas as ligações de uma conta suspensa', () => {
    const phone = connect('sessao-telemovel', 'ana');
    const tablet = connect('sessao-tablet', 'ana');
    const other = connect('sessao-do-rui', 'rui');

    const closed = live.closeUser('ana');

    expect(closed).toBe(2);
    expect(phone.close).toHaveBeenCalled();
    expect(tablet.close).toHaveBeenCalled();
    expect(other.close).not.toHaveBeenCalled();
  });

  it('poupa a sessão de quem pediu para terminar as outras', () => {
    const current = connect('sessao-actual', 'ana');
    const old = connect('sessao-antiga', 'ana');

    live.closeUser('ana', 'sessao-actual');

    expect(current.close).not.toHaveBeenCalled();
    expect(old.close).toHaveBeenCalled();
  });

  it('fecha os vários sockets abertos na mesma sessão', () => {
    const first = connect('sessao-telemovel', 'ana');
    const second = connect('sessao-telemovel', 'ana');

    expect(live.closeSession('sessao-telemovel')).toBe(2);
    expect(first.close).toHaveBeenCalled();
    expect(second.close).toHaveBeenCalled();
  });

  it('esquece uma ligação que caiu sozinha', () => {
    const phone = connect('sessao-telemovel', 'ana');

    phone.unregister();

    expect(live.size).toBe(0);
    expect(live.closeSession('sessao-telemovel')).toBe(0);
    expect(phone.close).not.toHaveBeenCalled();
  });

  it('não fecha nada quando a sessão não tem ligações', () => {
    connect('sessao-telemovel', 'ana');

    expect(live.closeSession('outra-sessao')).toBe(0);
    expect(live.size).toBe(1);
  });
});
