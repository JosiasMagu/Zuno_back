import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard';

const contextWith = (headers: Record<string, string>) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  }) as unknown as ExecutionContext;

describe('OptionalJwtAuthGuard', () => {
  const guard = new OptionalJwtAuthGuard();
  // O guard herda do mesmo AuthGuard('jwt') que o JwtAuthGuard usa.
  const jwtCheck = jest.spyOn(AuthGuard('jwt').prototype, 'canActivate');

  afterEach(() => jwtCheck.mockReset());
  afterAll(() => jwtCheck.mockRestore());

  it('deixa passar como visitante um pedido sem cabeçalho Authorization', async () => {
    const allowed = await guard.canActivate(contextWith({}));

    expect(allowed).toBe(true);
    expect(jwtCheck).not.toHaveBeenCalled();
  });

  it('valida o token quando o pedido traz um', async () => {
    jwtCheck.mockResolvedValue(true);
    const context = contextWith({ authorization: 'Bearer token-valido' });

    const allowed = await guard.canActivate(context);

    expect(allowed).toBe(true);
    expect(jwtCheck).toHaveBeenCalledWith(context);
  });

  it('responde 401 a um token inválido, sem o tratar como visitante', async () => {
    jwtCheck.mockRejectedValue(new UnauthorizedException());

    await expect(
      guard.canActivate(contextWith({ authorization: 'Bearer expirado' })),
    ).rejects.toThrow(UnauthorizedException);
  });
});
