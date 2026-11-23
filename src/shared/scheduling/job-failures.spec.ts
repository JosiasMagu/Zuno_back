import { ConflictException } from '@nestjs/common';

import * as sentry from '../sentry/sentry';
import {
  itemFailureOf,
  jobFailuresTotal,
  reportJobFailure,
  runJobStep,
} from './job-failures';

const countOf = async (job: string, scope: 'run' | 'item') => {
  const { values } = await jobFailuresTotal.get();
  return (
    values.find(({ labels }) => labels.job === job && labels.scope === scope)
      ?.value ?? 0
  );
};

describe('falhas dos jobs', () => {
  let toSentry: jest.SpyInstance;

  beforeEach(() => {
    toSentry = jest.spyOn(sentry, 'captureUnhandled').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it('conta a falha de uma execução e manda o erro inesperado para o Sentry', async () => {
    const error = new TypeError('undefined is not a function');
    const before = await countOf('auto-release', 'run');

    reportJobFailure('auto-release', 'run', error);

    expect(await countOf('auto-release', 'run')).toBe(before + 1);
    expect(toSentry).toHaveBeenCalledWith(error);
  });

  it('conta o conflito com outro pedido, mas não o manda para o Sentry', async () => {
    const before = await countOf('auto-release', 'item');

    itemFailureOf('auto-release')(
      { id: 'pagamento-1' },
      new ConflictException('O pagamento mudou. Tenta de novo.'),
    );

    expect(await countOf('auto-release', 'item')).toBe(before + 1);
    expect(toSentry).not.toHaveBeenCalled();
  });

  describe('runJobStep()', () => {
    it('devolve o que o passo devolveu', async () => {
      expect(await runJobStep('passo', () => Promise.resolve(3))).toBe(3);
    });

    it('apanha a falha, para os passos seguintes correrem', async () => {
      const before = await countOf('passo', 'run');

      const result = await runJobStep('passo', () =>
        Promise.reject(new Error('falhou')),
      );

      expect(result).toBeUndefined();
      expect(await countOf('passo', 'run')).toBe(before + 1);
    });
  });
});
