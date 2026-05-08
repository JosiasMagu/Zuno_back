import * as bcrypt from 'bcrypt';
import { UserRole } from '@prisma/client';
import { getTestPrisma } from './db';

export const TEST_PASSWORD = 'TestPass@2026!';

export interface TestUserSeed {
  id: string;
  phone: string;
  email: string;
  name: string;
  role: UserRole;
}

export interface TestCategorySeed {
  id: string;
  slug: string;
  name: string;
}

export interface TestSeedResult {
  admin: TestUserSeed;
  provider: TestUserSeed;
  client: TestUserSeed;
  categories: {
    construcao: TestCategorySeed;
  };
}

export async function seedMinimalTestData(): Promise<TestSeedResult> {
  const prisma = getTestPrisma();
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);

  const admin = await prisma.user.create({
    data: {
      phone: '+258840000900',
      email: 'admin-e2e@zuno.co.mz',
      name: 'Admin E2E',
      passwordHash,
      role: UserRole.ADMIN,
      isVerified: true,
      isActive: true,
    },
  });

  const provider = await prisma.user.create({
    data: {
      phone: '+258840000901',
      email: 'provider-e2e@zuno.co.mz',
      name: 'Provider E2E',
      passwordHash,
      role: UserRole.PROVIDER,
      isVerified: true,
      isActive: true,
    },
  });

  const client = await prisma.user.create({
    data: {
      phone: '+258840000902',
      email: 'client-e2e@zuno.co.mz',
      name: 'Client E2E',
      passwordHash,
      role: UserRole.CLIENT,
      isVerified: true,
      isActive: true,
    },
  });

  const construcao = await prisma.category.create({
    data: {
      slug: 'construcao-e2e',
      name: 'Construção (e2e)',
      isActive: true,
    },
  });

  return {
    admin: {
      id: admin.id,
      phone: admin.phone,
      email: admin.email!,
      name: admin.name,
      role: admin.role,
    },
    provider: {
      id: provider.id,
      phone: provider.phone,
      email: provider.email!,
      name: provider.name,
      role: provider.role,
    },
    client: {
      id: client.id,
      phone: client.phone,
      email: client.email!,
      name: client.name,
      role: client.role,
    },
    categories: {
      construcao: {
        id: construcao.id,
        slug: construcao.slug,
        name: construcao.name,
      },
    },
  };
}