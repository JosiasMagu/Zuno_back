import { INestApplication } from '@nestjs/common';
import request from 'supertest';

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  userId: string;
}

export async function loginViaApi(
  app: INestApplication,
  phone: string,
  password: string,
): Promise<LoginResult> {
  const response = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ phone, password });

  if (response.status !== 200 && response.status !== 201) {
    throw new Error(
      `Login falhou para ${phone} (status ${response.status}): ${JSON.stringify(response.body)}`,
    );
  }

  const body = response.body as {
    accessToken?: string;
    refreshToken?: string;
    user?: { id?: string };
  };

  if (!body.accessToken || !body.user?.id) {
    throw new Error(
      `Login devolveu payload inesperado: ${JSON.stringify(response.body)}`,
    );
  }

  return {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken ?? '',
    userId: body.user.id,
  };
}

export function authHeader(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}
