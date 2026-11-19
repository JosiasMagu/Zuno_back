import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';

import { PasswordHasher } from './password-hasher.service';

const PASSWORD = 'gerador-amarelo';

// Custo mínimo do bcrypt, para o teste não demorar.
const makeHasher = (rounds = '4') =>
  new PasswordHasher({
    get: () => rounds,
  } as unknown as ConfigService);

describe('PasswordHasher', () => {
  it('faz o hash com o custo configurado', async () => {
    const hash = await makeHasher('5').hash(PASSWORD);

    expect(hash).not.toContain(PASSWORD);
    expect(bcrypt.getRounds(hash)).toBe(5);
  });

  it('usa o custo 12 quando não há configuração', () => {
    const hasher = new PasswordHasher({
      get: () => undefined,
    } as unknown as ConfigService);

    expect(hasher.needsRehash(bcrypt.hashSync(PASSWORD, 11))).toBe(true);
    expect(hasher.needsRehash(bcrypt.hashSync(PASSWORD, 12))).toBe(false);
  });

  describe('matches()', () => {
    it('reconhece a password certa e recusa a errada', async () => {
      const hasher = makeHasher();
      const hash = await hasher.hash(PASSWORD);

      await expect(hasher.matches(PASSWORD, hash)).resolves.toBe(true);
      await expect(hasher.matches('outra-password', hash)).resolves.toBe(false);
    });

    it('responde que não quando a conta não existe', async () => {
      await expect(makeHasher().matches(PASSWORD, undefined)).resolves.toBe(
        false,
      );
    });
  });

  describe('needsRehash()', () => {
    it('pede novo hash só quando o custo guardado é inferior ao actual', () => {
      const hasher = makeHasher('6');

      expect(hasher.needsRehash(bcrypt.hashSync(PASSWORD, 4))).toBe(true);
      expect(hasher.needsRehash(bcrypt.hashSync(PASSWORD, 6))).toBe(false);
      expect(hasher.needsRehash(bcrypt.hashSync(PASSWORD, 7))).toBe(false);
    });
  });
});
