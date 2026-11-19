import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { ACCESS_TOKEN_TYPE, AccessTokenPayload } from '../access-token';
import { SessionsService } from '../services/sessions.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private readonly sessions: SessionsService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
    });
  }

  /**
   * A assinatura e a validade do token já foram verificadas. Falta confirmar
   * que a sessão a que ele pertence continua aberta, para que um logout, uma
   * troca de password ou uma suspensão cortem o acesso de imediato.
   */
  async validate(payload: Partial<AccessTokenPayload>) {
    if (payload.typ !== ACCESS_TOKEN_TYPE || !payload.sid) {
      throw new UnauthorizedException('Token inválido.');
    }

    const session = await this.sessions.findUsable(payload.sid);

    if (!session || session.userId !== payload.sub) {
      throw new UnauthorizedException('Sessão inválida ou revogada.');
    }

    if (!session.user.isActive) {
      throw new UnauthorizedException('Conta desativada.');
    }

    return { ...session.user, sessionId: session.id };
  }
}
