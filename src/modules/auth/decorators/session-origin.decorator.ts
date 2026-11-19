import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import type { SessionOrigin } from '../services/sessions.service';

/** O IP e o user-agent do pedido, para ficarem registados na sessão. */
export const RequestOrigin = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): SessionOrigin => {
    const request = ctx.switchToHttp().getRequest<Request>();

    return {
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    };
  },
);
