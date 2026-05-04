import {
  PrismaClient,
  UserRole,
  EquipmentStatus,
  EquipmentCondition,
} from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as bcrypt from 'bcrypt';

const SEED_PASSWORD = 'Zuno@2026!';
const BCRYPT_ROUNDS = 10;

function buildPrisma(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    console.error('');
    console.error('DATABASE_URL nao definida no .env');
    console.error('');
    process.exit(1);
  }

  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

const prisma = buildPrisma();

function log(emoji: string, message: string): void {
  console.log(`${emoji}  ${message}`);
}

async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

function abortIfProduction(): void {
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.FORCE_PROD_SEED !== '1'
  ) {
    console.error('');
    console.error('Seed bloqueado: NODE_ENV=production.');
    console.error('Forcar com: FORCE_PROD_SEED=1 npx prisma db seed');
    console.error('');
    process.exit(1);
  }
}

const CATEGORIES = [
  { slug: 'construcao', name: 'Construção' },
  { slug: 'agricultura', name: 'Agricultura' },
  { slug: 'transporte', name: 'Transporte' },
  { slug: 'eventos', name: 'Eventos' },
  { slug: 'limpeza', name: 'Limpeza' },
  { slug: 'jardinagem', name: 'Jardinagem' },
] as const;

async function seedCategories() {
  log('📦', 'A criar categorias...');

  for (const cat of CATEGORIES) {
    await prisma.category.upsert({
      where: { slug: cat.slug },
      create: { name: cat.name, slug: cat.slug, isActive: true },
      update: { name: cat.name, isActive: true },
    });
  }

  log('✅', `${CATEGORIES.length} categorias prontas.`);
}

const SEED_USERS = [
  {
    phone: '+258840000000',
    email: 'admin@zuno.co.mz',
    name: 'Administrador Zuno',
    role: UserRole.ADMIN,
    isVerified: true,
  },
  {
    phone: '+258840000001',
    email: 'provider1@zuno.co.mz',
    name: 'João Macamo',
    role: UserRole.PROVIDER,
    isVerified: true,
    bio: 'Aluguer de equipamentos de construção em Maputo. Mais de 8 anos no mercado.',
  },
  {
    phone: '+258840000002',
    email: 'provider2@zuno.co.mz',
    name: 'Maria Tembe',
    role: UserRole.PROVIDER,
    isVerified: true,
    bio: 'Tractores e maquinaria agrícola para zonas rurais. Entrega incluída.',
  },
  {
    phone: '+258840000003',
    email: 'client1@zuno.co.mz',
    name: 'Carlos Sitoe',
    role: UserRole.CLIENT,
    isVerified: true,
  },
  {
    phone: '+258840000004',
    email: 'client2@zuno.co.mz',
    name: 'Ana Mondlane',
    role: UserRole.CLIENT,
    isVerified: false,
  },
] as const;

async function seedUsers(passwordHash: string) {
  log('👤', 'A criar utilizadores...');

  for (const u of SEED_USERS) {
    await prisma.user.upsert({
      where: { phone: u.phone },
      create: {
        phone: u.phone,
        email: u.email,
        name: u.name,
        passwordHash,
        role: u.role,
        isVerified: u.isVerified,
        isActive: true,
        bio: 'bio' in u ? u.bio : null,
      },
      update: {
        email: u.email,
        name: u.name,
        role: u.role,
        isVerified: u.isVerified,
      },
    });
  }

  log(
    '✅',
    `${SEED_USERS.length} utilizadores prontos (password: ${SEED_PASSWORD}).`,
  );
}

async function seedEquipment() {
  log('🚜', 'A criar equipamentos...');

  const provider1 = await prisma.user.findUniqueOrThrow({
    where: { phone: '+258840000001' },
    select: { id: true },
  });
  const provider2 = await prisma.user.findUniqueOrThrow({
    where: { phone: '+258840000002' },
    select: { id: true },
  });

  const catConstrucao = await prisma.category.findUniqueOrThrow({
    where: { slug: 'construcao' },
    select: { id: true },
  });
  const catAgricultura = await prisma.category.findUniqueOrThrow({
    where: { slug: 'agricultura' },
    select: { id: true },
  });
  const catTransporte = await prisma.category.findUniqueOrThrow({
    where: { slug: 'transporte' },
    select: { id: true },
  });

  const equipment = [
    {
      ownerId: provider1.id,
      categoryId: catConstrucao.id,
      title: 'Betoneira 300L',
      description:
        'Betoneira eléctrica de 300L em excelente estado. Ideal para pequenas e médias obras. Inclui transporte dentro de Maputo Cidade.',
      pricePerDay: 1500,
      pricePerWeek: 8500,
      depositAmount: 5000,
      location: 'Maputo, Cidade',
      condition: EquipmentCondition.EXCELLENT,
      deliveryIncluded: true,
    },
    {
      ownerId: provider1.id,
      categoryId: catConstrucao.id,
      title: 'Andaime Modular 6m',
      description:
        'Conjunto de andaimes modulares com altura ajustável até 6 metros. Material certificado, montagem rápida.',
      pricePerDay: 800,
      pricePerWeek: 4500,
      pricePerMonth: 14000,
      depositAmount: 3000,
      location: 'Maputo, Matola',
      condition: EquipmentCondition.GOOD,
    },
    {
      ownerId: provider2.id,
      categoryId: catAgricultura.id,
      title: 'Tractor John Deere 5050D',
      description:
        'Tractor agrícola 50HP. Ideal para preparação de terreno e transporte. Operador disponível mediante pedido.',
      pricePerDay: 4500,
      pricePerWeek: 28000,
      depositAmount: 15000,
      location: 'Gaza, Chókwè',
      condition: EquipmentCondition.GOOD,
      operatorAvailable: true,
    },
    {
      ownerId: provider2.id,
      categoryId: catAgricultura.id,
      title: 'Arado de Discos (3 corpos)',
      description:
        'Arado de discos para acoplar a tractor. Profundidade ajustável. Ideal para terras pesadas.',
      pricePerDay: 1200,
      pricePerWeek: 7000,
      depositAmount: 4000,
      location: 'Gaza, Chókwè',
      condition: EquipmentCondition.USED,
    },
    {
      ownerId: provider1.id,
      categoryId: catTransporte.id,
      title: 'Camião Iveco 3 Toneladas',
      description:
        'Camião de caixa aberta para transporte de materiais de construção. Combustível por conta do cliente.',
      pricePerDay: 3500,
      pricePerWeek: 22000,
      depositAmount: 10000,
      location: 'Maputo, Cidade',
      condition: EquipmentCondition.GOOD,
      operatorAvailable: true,
    },
  ];

  for (const eq of equipment) {
    const existing = await prisma.equipment.findFirst({
      where: { title: eq.title, ownerId: eq.ownerId },
      select: { id: true },
    });

    if (existing) {
      await prisma.equipment.update({
        where: { id: existing.id },
        data: {
          description: eq.description,
          pricePerDay: eq.pricePerDay,
          pricePerWeek: eq.pricePerWeek ?? null,
          pricePerMonth: eq.pricePerMonth ?? null,
          depositAmount: eq.depositAmount,
          location: eq.location,
          condition: eq.condition,
          deliveryIncluded: eq.deliveryIncluded ?? false,
          operatorAvailable: eq.operatorAvailable ?? false,
          status: EquipmentStatus.ACTIVE,
          isAvailable: true,
        },
      });
    } else {
      await prisma.equipment.create({
        data: {
          ownerId: eq.ownerId,
          categoryId: eq.categoryId,
          title: eq.title,
          description: eq.description,
          pricePerDay: eq.pricePerDay,
          pricePerWeek: eq.pricePerWeek ?? null,
          pricePerMonth: eq.pricePerMonth ?? null,
          depositAmount: eq.depositAmount,
          location: eq.location,
          condition: eq.condition,
          deliveryIncluded: eq.deliveryIncluded ?? false,
          operatorAvailable: eq.operatorAvailable ?? false,
          status: EquipmentStatus.ACTIVE,
          isAvailable: true,
        },
      });
    }
  }

  log('✅', `${equipment.length} equipamentos prontos.`);
}

async function printSummary() {
  const [users, categories, equipment] = await Promise.all([
    prisma.user.count(),
    prisma.category.count(),
    prisma.equipment.count(),
  ]);

  console.log('');
  console.log(
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  );
  console.log('  Estado da BD');
  console.log(
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  );
  console.log(`  Utilizadores:   ${users}`);
  console.log(`  Categorias:     ${categories}`);
  console.log(`  Equipamentos:   ${equipment}`);
  console.log(
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  );
  console.log('');
  console.log(`  Password de teste: ${SEED_PASSWORD}`);
  console.log('  admin:        +258840000000  (admin@zuno.co.mz)');
  console.log('  provider 1:   +258840000001  (provider1@zuno.co.mz)');
  console.log('  provider 2:   +258840000002  (provider2@zuno.co.mz)');
  console.log('  client 1:     +258840000003  (client1@zuno.co.mz)');
  console.log('  client 2:     +258840000004  (client2@zuno.co.mz, nao verificado)');
  console.log('');
}

async function main() {
  abortIfProduction();

  console.log('');
  console.log('Zuno — Seed da base de dados');
  console.log('');

  const passwordHash = await hashPassword(SEED_PASSWORD);

  await seedCategories();
  await seedUsers(passwordHash);
  await seedEquipment();

  await printSummary();
}

main()
  .catch((err) => {
    console.error('');
    console.error('Seed falhou:', err);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });