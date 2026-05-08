import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

let prismaInstance: PrismaClient | null = null;

export function getTestPrisma(): PrismaClient {
  if (prismaInstance) return prismaInstance;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL nao definida no contexto de teste');
  }
  if (!connectionString.includes('zuno_db_test')) {
    throw new Error(
      'Recusado: DATABASE_URL nao aponta para zuno_db_test. ' +
        'Os helpers de teste so correm em BDs com "zuno_db_test" no nome.',
    );
  }

  const adapter = new PrismaPg({ connectionString });
  prismaInstance = new PrismaClient({ adapter });
  return prismaInstance;
}

const TABLES_IN_TRUNCATE_ORDER = [
  'Message',
  'Conversation',
  'Review',
  'Dispute',
  'Payment',
  'Booking',
  'EquipmentPhoto',
  'Equipment',
  'Category',
  'AuthSession',
  'User',
];

export async function truncateAllTables(): Promise<void> {
  const prisma = getTestPrisma();
  const tableList = TABLES_IN_TRUNCATE_ORDER.map((t) => `"${t}"`).join(', ');
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE;`,
  );
}

export async function disconnectTestPrisma(): Promise<void> {
  if (prismaInstance) {
    await prismaInstance.$disconnect();
    prismaInstance = null;
  }
}
