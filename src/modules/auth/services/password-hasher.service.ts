import { randomBytes } from 'crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';

import { DEFAULT_PASSWORD_HASH_ROUNDS } from '../auth.policy';

/** Hash e verificação de passwords de contas, com o custo do bcrypt num só sítio. */
@Injectable()
export class PasswordHasher {
  private readonly rounds: number;

  // Hash de uma password que ninguém conhece. Serve para o login de um número
  // sem conta demorar o mesmo que o de um número com conta.
  private readonly decoyHash: string;

  constructor(config: ConfigService) {
    this.rounds = Number(
      config.get('PASSWORD_HASH_ROUNDS') ?? DEFAULT_PASSWORD_HASH_ROUNDS,
    );
    this.decoyHash = bcrypt.hashSync(
      randomBytes(32).toString('hex'),
      this.rounds,
    );
  }

  hash(password: string): Promise<string> {
    return bcrypt.hash(password, this.rounds);
  }

  /**
   * Diz se a password corresponde ao hash guardado. Sem hash (a conta não
   * existe) faz a comparação na mesma, contra o hash de isco, e responde
   * que não.
   */
  async matches(
    password: string,
    storedHash: string | undefined,
  ): Promise<boolean> {
    const matches = await bcrypt.compare(
      password,
      storedHash ?? this.decoyHash,
    );

    return storedHash !== undefined && matches;
  }

  /** O hash foi feito com um custo mais baixo do que o actual. */
  needsRehash(storedHash: string): boolean {
    return bcrypt.getRounds(storedHash) < this.rounds;
  }
}
