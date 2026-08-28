import {
  PrismaClient,
  UserRole,
  EquipmentStatus,
  EquipmentCondition,
  CategoryKind,
} from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as bcrypt from 'bcrypt';

if (process.env.NODE_ENV === 'production' && !process.env.SEED_PASSWORD) {
  throw new Error('Define SEED_PASSWORD antes de correr o seed em producao.');
}
const SEED_PASSWORD = process.env.SEED_PASSWORD ?? 'dev-only-password';
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
  { slug: 'construcao', name: 'Construção', kind: CategoryKind.BOTH },
  { slug: 'agricultura', name: 'Agricultura', kind: CategoryKind.EQUIPMENT },
  { slug: 'transporte', name: 'Transporte', kind: CategoryKind.BOTH },
  { slug: 'eventos', name: 'Eventos', kind: CategoryKind.EQUIPMENT },
  { slug: 'limpeza', name: 'Limpeza', kind: CategoryKind.BOTH },
  { slug: 'jardinagem', name: 'Jardinagem', kind: CategoryKind.BOTH },
  {
    slug: 'electricidade',
    name: 'Electricidade',
    kind: CategoryKind.SERVICE,
  },
  { slug: 'canalizacao', name: 'Canalização', kind: CategoryKind.SERVICE },
] as const;

async function seedCategories() {
  log('📦', 'A criar categorias...');

  for (const cat of CATEGORIES) {
    await prisma.category.upsert({
      where: { slug: cat.slug },
      create: {
        name: cat.name,
        slug: cat.slug,
        isActive: true,
        kind: cat.kind,
      },
      update: { name: cat.name, isActive: true, kind: cat.kind },
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
  const catLimpeza = await prisma.category.findUniqueOrThrow({
    where: { slug: 'limpeza' },
    select: { id: true },
  });

  const CL = 'https://res.cloudinary.com/dojumw0as/image/upload';
  const equipment = [
    {
      ownerId: provider1.id,
      categoryId: catConstrucao.id,
      title: 'Bomba de Água Periférica INGCO 0.5HP',
      imageUrl: `${CL}/v1779720991/zuno/equipment/f2a55da0-6446-4340-8043-2b1c038e50fd/j4p5odlvmiev8gmjey0v.jpg`,
      description:
        'Bomba de água periférica INGCO de 0.5HP. Ideal para abastecimento doméstico, rega e pequenas obras. Inclui transporte dentro de Maputo Cidade.',
      pricePerDay: 350,
      pricePerWeek: 2000,
      depositAmount: 1500,
      location: 'Maputo, Cidade',
      condition: EquipmentCondition.EXCELLENT,
      deliveryIncluded: true,
    },
    {
      ownerId: provider1.id,
      categoryId: catConstrucao.id,
      title: 'Bomba de Água Centrífuga INGCO 1HP',
      imageUrl: `${CL}/v1779715260/zuno/equipment/f7712034-0ec4-4aea-841a-ba21582b4b30/sbe8wiq87u0i2witm0q1.jpg`,
      description:
        'Bomba centrífuga INGCO de 1HP, alto caudal. Ideal para irrigação e transferência de água em estaleiros. Material em excelente estado.',
      pricePerDay: 450,
      pricePerWeek: 2600,
      depositAmount: 2000,
      location: 'Maputo, Matola',
      condition: EquipmentCondition.GOOD,
    },
    {
      ownerId: provider2.id,
      categoryId: catConstrucao.id,
      title: 'Escavadora Hidráulica de Esteiras',
      imageUrl: `${CL}/v1779709734/zuno/equipment/837b541d-1e2e-4d68-aca3-51bb17bd855d/nyjxcubpuunavv6wh9fh.jpg`,
      description:
        'Escavadora hidráulica sobre esteiras para movimentação de terras, escavações e demolições. Operador certificado disponível mediante pedido.',
      pricePerDay: 12000,
      pricePerWeek: 75000,
      depositAmount: 40000,
      location: 'Gaza, Chókwè',
      condition: EquipmentCondition.GOOD,
      operatorAvailable: true,
    },
    {
      ownerId: provider1.id,
      categoryId: catLimpeza.id,
      title: 'Máquina de Lavar Industrial Miele',
      imageUrl: `${CL}/v1779706267/zuno/equipment/3f8952b4-dddd-44f9-be95-5d546596ecb7/cyb3f0uwduuejl8xa2nw.jpg`,
      description:
        'Máquina de lavar roupa Miele de uso intensivo. Ideal para lavandarias, eventos e alojamentos. Inclui transporte e instalação em Maputo Cidade.',
      pricePerDay: 600,
      pricePerWeek: 3500,
      pricePerMonth: 11000,
      depositAmount: 3000,
      location: 'Maputo, Cidade',
      condition: EquipmentCondition.EXCELLENT,
      deliveryIncluded: true,
    },
    {
      ownerId: provider2.id,
      categoryId: catConstrucao.id,
      title: 'Escavadora CAT 345BL',
      imageUrl: `${CL}/v1779397012/zuno/equipment/53fa2393-801e-4016-a859-14fc502d1830/cj3gjjd0anbko0oovyh0.jpg`,
      description:
        'Escavadora Caterpillar 345BL de grande porte para obras pesadas, terraplanagem e mineração ligeira. Operador incluído. Combustível por conta do cliente.',
      pricePerDay: 18000,
      pricePerWeek: 110000,
      depositAmount: 60000,
      location: 'Gaza, Chókwè',
      condition: EquipmentCondition.GOOD,
      operatorAvailable: true,
    },
  ];

  for (const eq of equipment) {
    const existing = await prisma.equipment.findFirst({
      where: { title: eq.title, ownerId: eq.ownerId },
      select: { id: true },
    });

    let equipmentId: string;
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
      equipmentId = existing.id;
    } else {
      const created = await prisma.equipment.create({
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
        select: { id: true },
      });
      equipmentId = created.id;
    }

    // Foto principal (idempotente): remove as existentes e recria
    await prisma.equipmentPhoto.deleteMany({ where: { equipmentId } });
    await prisma.equipmentPhoto.create({
      data: {
        equipmentId,
        url: eq.imageUrl,
        isPrimary: true,
        order: 0,
      },
    });
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
  console.log('------------------------------------------------------------');
  console.log('  Estado da BD');
  console.log('------------------------------------------------------------');
  console.log(`  Utilizadores:   ${users}`);
  console.log(`  Categorias:     ${categories}`);
  console.log(`  Equipamentos:   ${equipment}`);
  console.log('------------------------------------------------------------');
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
  console.log('Zuno - Seed da base de dados');
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