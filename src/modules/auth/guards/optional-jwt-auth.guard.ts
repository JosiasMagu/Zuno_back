import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';

/**
 * Para rotas públicas que respondem de outra maneira a quem tem sessão.
 * Sem cabeçalho Authorization o pedido segue como visitante. Com cabeçalho
 * vale o JwtAuthGuard: um token inválido responde 401, para a app renovar a
 * sessão e repetir o pedido.
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();

    if (!request.headers.authorization) return true;

    return super.canActivate(context);
  }
}
