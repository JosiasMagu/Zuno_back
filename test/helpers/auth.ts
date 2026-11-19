import { INestApplication } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import request from 'supertest';

import { getTestPrisma } from './db';
import { hashTestPassword, TEST_PASSWORD } from './seed-test-data';

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

/**
 * Cria e autentica um utilizador que não é parte de nenhuma reserva do teste,
 * para provar que as rotas recusam quem não é cliente, dono nem admin.
 */
export async function loginAsOutsider(
  app: INestApplication,
  role: UserRole = UserRole.CLIENT,
): Promise<LoginResult> {
  const phone = '+258840000999';

  await getTestPrisma().user.create({
    data: {
      phone,
      name: 'Outsider E2E',
      passwordHash: await hashTestPassword(),
      role,
      isVerified: true,
    },
  });

  return loginViaApi(app, phone, TEST_PASSWORD);
}

export function authHeader(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}
