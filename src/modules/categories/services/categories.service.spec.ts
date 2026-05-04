import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { PrismaService } from '../../../shared/db/prisma.service';
import { CategoriesService } from './categories.service';

// ─────────────────────────────────────────────────────────────────────────────
// IDs FIXOS
// ─────────────────────────────────────────────────────────────────────────────

const CAT_ID = 'cat-uuid-001';
const PARENT_ID = 'cat-uuid-parent';
const OTHER_CAT_ID = 'cat-uuid-other';

// ─────────────────────────────────────────────────────────────────────────────
// FACTORIES
// ─────────────────────────────────────────────────────────────────────────────

const makeCategory = (overrides: Record<string, unknown> = {}) => ({
  id: CAT_ID,
  name: 'Construção',
  slug: 'construcao',
  iconUrl: undefined,
  parentId: undefined,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  parent: null,
  children: [],
  equipment: [],
  ...overrides,
});

// ─────────────────────────────────────────────────────────────────────────────
// MOCK DO PRISMA
// ─────────────────────────────────────────────────────────────────────────────

const makePrisma = () => ({
  category: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE
// ─────────────────────────────────────────────────────────────────────────────

describe('CategoriesService', () => {
  let service: CategoriesService;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(async () => {
    prisma = makePrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CategoriesService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<CategoriesService>(CategoriesService);
  });

  afterEach(() => jest.clearAllMocks());

  // ───────────────────────────────────────────────────────────────────────────
  // create()
  // ───────────────────────────────────────────────────────────────────────────

  describe('create()', () => {
    const dto = { name: 'Construção', iconUrl: undefined, parentId: undefined };

    it('cria categoria com sucesso e devolve a categoria criada', async () => {
      prisma.category.findUnique.mockResolvedValue(null);
      prisma.category.create.mockResolvedValue(makeCategory());

      const result = await service.create(dto);

      expect(result.message).toBe('Categoria criada com sucesso.');
      expect(result.data.id).toBe(CAT_ID);
      expect(prisma.category.create).toHaveBeenCalledTimes(1);
    });

    it('gera o slug a partir do nome — remove acentos e converte para lowercase', async () => {
      prisma.category.findUnique.mockResolvedValue(null);
      prisma.category.create.mockResolvedValue(makeCategory());

      await service.create({
        name: 'Construção Civil',
        iconUrl: undefined,
        parentId: undefined,
      });

      const createCall = prisma.category.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(createCall.data.slug).toBe('construcao-civil');
    });

    it('faz trim() no nome antes de criar o slug', async () => {
      prisma.category.findUnique.mockResolvedValue(null);
      prisma.category.create.mockResolvedValue(makeCategory());

      await service.create({
        name: '  Agricultura  ',
        iconUrl: undefined,
        parentId: undefined,
      });

      const createCall = prisma.category.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(createCall.data.name).toBe('Agricultura');
      expect(createCall.data.slug).toBe('agricultura');
    });

    it('cria sempre com isActive=true', async () => {
      prisma.category.findUnique.mockResolvedValue(null);
      prisma.category.create.mockResolvedValue(makeCategory());

      await service.create(dto);

      const createCall = prisma.category.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(createCall.data.isActive).toBe(true);
    });

    it('guarda iconUrl como null quando não fornecido', async () => {
      prisma.category.findUnique.mockResolvedValue(null);
      prisma.category.create.mockResolvedValue(makeCategory());

      await service.create({
        name: 'Construção',
        iconUrl: undefined,
        parentId: undefined,
      });

      const createCall = prisma.category.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(createCall.data.iconUrl).toBeNull();
    });

    it('guarda iconUrl quando fornecido', async () => {
      prisma.category.findUnique.mockResolvedValue(null);
      prisma.category.create.mockResolvedValue(
        makeCategory({ iconUrl: 'https://cdn.zuno.co.mz/icon.svg' }),
      );

      await service.create({
        name: 'Construção',
        iconUrl: 'https://cdn.zuno.co.mz/icon.svg',
        parentId: undefined,
      });

      const createCall = prisma.category.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(createCall.data.iconUrl).toBe('https://cdn.zuno.co.mz/icon.svg');
    });

    it('lança BadRequestException se nome gera slug vazio (ex: só caracteres especiais)', async () => {
      await expect(
        service.create({
          name: '!!!',
          iconUrl: undefined,
          parentId: undefined,
        }),
      ).rejects.toThrow(new BadRequestException('Nome de categoria inválido.'));
      expect(prisma.category.create).not.toHaveBeenCalled();
    });

    it('lança BadRequestException se já existe categoria com o mesmo slug', async () => {
      prisma.category.findUnique.mockResolvedValue(makeCategory());

      await expect(service.create(dto)).rejects.toThrow(
        new BadRequestException('Já existe uma categoria com esse nome.'),
      );
      expect(prisma.category.create).not.toHaveBeenCalled();
    });

    it('aceita parentId válido e activo', async () => {
      const parent = makeCategory({
        id: PARENT_ID,
        name: 'Equipamentos',
        slug: 'equipamentos',
      });

      // 1ª chamada: verificar slug (null = livre)
      // 2ª chamada: verificar parentId
      prisma.category.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(parent);

      prisma.category.create.mockResolvedValue(
        makeCategory({ parentId: PARENT_ID }),
      );

      const result = await service.create({
        name: 'Construção',
        iconUrl: undefined,
        parentId: PARENT_ID,
      });
      expect(result.message).toBe('Categoria criada com sucesso.');
    });

    it('lança BadRequestException se parentId não existe', async () => {
      prisma.category.findUnique
        .mockResolvedValueOnce(null) // slug livre
        .mockResolvedValueOnce(null); // parent não encontrado

      await expect(
        service.create({
          name: 'Construção',
          iconUrl: undefined,
          parentId: 'pai-inexistente',
        }),
      ).rejects.toThrow(
        new BadRequestException('Categoria pai não encontrada.'),
      );
    });

    it('lança BadRequestException se categoria pai está inativa', async () => {
      prisma.category.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(
          makeCategory({ id: PARENT_ID, isActive: false }),
        );

      await expect(
        service.create({
          name: 'Construção',
          iconUrl: undefined,
          parentId: PARENT_ID,
        }),
      ).rejects.toThrow(
        new BadRequestException(
          'Não é permitido vincular a uma categoria pai inativa.',
        ),
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // findAll()
  // ───────────────────────────────────────────────────────────────────────────

  describe('findAll()', () => {
    it('devolve apenas categorias activas', async () => {
      prisma.category.findMany.mockResolvedValue([makeCategory()]);

      await service.findAll();

      const whereArg = (
        prisma.category.findMany.mock.calls[0][0] as {
          where: Record<string, unknown>;
        }
      ).where;
      expect(whereArg).toMatchObject({ isActive: true });
    });

    it('ordena por nome ascendente', async () => {
      prisma.category.findMany.mockResolvedValue([]);

      await service.findAll();

      const orderByArg = (
        prisma.category.findMany.mock.calls[0][0] as { orderBy: unknown[] }
      ).orderBy;
      expect(orderByArg[0]).toMatchObject({ name: 'asc' });
    });

    it('devolve lista correcta com mensagem', async () => {
      prisma.category.findMany.mockResolvedValue([
        makeCategory(),
        makeCategory({
          id: OTHER_CAT_ID,
          name: 'Transporte',
          slug: 'transporte',
        }),
      ]);

      const result = await service.findAll();

      expect(result.message).toBe('Categorias obtidas com sucesso.');
      expect(result.data).toHaveLength(2);
    });

    it('devolve lista vazia quando não há categorias activas', async () => {
      prisma.category.findMany.mockResolvedValue([]);

      const result = await service.findAll();
      expect(result.data).toHaveLength(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // findOne()
  // ───────────────────────────────────────────────────────────────────────────

  describe('findOne()', () => {
    it('devolve categoria activa com sucesso', async () => {
      prisma.category.findUnique.mockResolvedValue(makeCategory());

      const result = await service.findOne(CAT_ID);

      expect(result.message).toBe('Categoria obtida com sucesso.');
      expect(result.data.id).toBe(CAT_ID);
    });

    it('lança NotFoundException se categoria não existe (findUnique devolve null)', async () => {
      prisma.category.findUnique.mockResolvedValue(null);

      await expect(service.findOne(CAT_ID)).rejects.toThrow(
        new NotFoundException('Categoria não encontrada.'),
      );
    });

    it('lança NotFoundException se categoria está inactiva — mesmo que exista na BD', async () => {
      prisma.category.findUnique.mockResolvedValue(
        makeCategory({ isActive: false }),
      );

      await expect(service.findOne(CAT_ID)).rejects.toThrow(
        new NotFoundException('Categoria não encontrada.'),
      );
    });

    it('a mensagem de erro é a mesma para inexistente e inactiva — não revela estado', async () => {
      prisma.category.findUnique.mockResolvedValue(null);
      const err1 = await service.findOne(CAT_ID).catch((e) => e);

      prisma.category.findUnique.mockResolvedValue(
        makeCategory({ isActive: false }),
      );
      const err2 = await service.findOne(CAT_ID).catch((e) => e);

      expect(err1.message).toBe(err2.message);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // update()
  // ───────────────────────────────────────────────────────────────────────────

  describe('update()', () => {
    it('actualiza o nome com sucesso — regenera o slug', async () => {
      prisma.category.findUnique
        .mockResolvedValueOnce(makeCategory()) // categoria a actualizar
        .mockResolvedValueOnce(null); // slug novo não colide

      prisma.category.update.mockResolvedValue(
        makeCategory({ name: 'Agricultura', slug: 'agricultura' }),
      );

      const result = await service.update(CAT_ID, { name: 'Agricultura' });

      expect(result.message).toBe('Categoria atualizada com sucesso.');
      const updateCall = prisma.category.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(updateCall.data.slug).toBe('agricultura');
    });

    it('faz trim no nome durante update', async () => {
      prisma.category.findUnique
        .mockResolvedValueOnce(makeCategory())
        .mockResolvedValueOnce(null);

      prisma.category.update.mockResolvedValue(makeCategory());

      await service.update(CAT_ID, { name: '  Logística  ' });

      const updateCall = prisma.category.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(updateCall.data.name).toBe('Logística');
    });

    it('lança BadRequestException se novo nome gera slug vazio', async () => {
      prisma.category.findUnique.mockResolvedValue(makeCategory());

      await expect(service.update(CAT_ID, { name: '!!!' })).rejects.toThrow(
        new BadRequestException('Nome de categoria inválido.'),
      );
      expect(prisma.category.update).not.toHaveBeenCalled();
    });

    it('lança BadRequestException se novo slug pertence a outra categoria', async () => {
      const outra = makeCategory({ id: OTHER_CAT_ID, slug: 'agricultura' });

      prisma.category.findUnique
        .mockResolvedValueOnce(makeCategory()) // categoria actual
        .mockResolvedValueOnce(outra); // slug em uso por outra

      await expect(
        service.update(CAT_ID, { name: 'Agricultura' }),
      ).rejects.toThrow(
        new BadRequestException('Já existe uma categoria com esse nome.'),
      );
    });

    it('não lança erro de slug duplicado se o slug pertence à própria categoria (sem mudança de nome)', async () => {
      const same = makeCategory({ id: CAT_ID, slug: 'construcao' });

      prisma.category.findUnique
        .mockResolvedValueOnce(makeCategory()) // categoria actual
        .mockResolvedValueOnce(same); // slug é da mesma categoria — permitido

      prisma.category.update.mockResolvedValue(makeCategory());

      const result = await service.update(CAT_ID, { name: 'Construção' });
      expect(result.message).toBe('Categoria atualizada com sucesso.');
    });

    it('lança NotFoundException se categoria não existe', async () => {
      prisma.category.findUnique.mockResolvedValue(null);

      await expect(service.update(CAT_ID, { name: 'Novo' })).rejects.toThrow(
        new NotFoundException('Categoria não encontrada.'),
      );
      expect(prisma.category.update).not.toHaveBeenCalled();
    });

    it('lança NotFoundException se categoria está inactiva', async () => {
      prisma.category.findUnique.mockResolvedValue(
        makeCategory({ isActive: false }),
      );

      await expect(service.update(CAT_ID, { name: 'Novo' })).rejects.toThrow(
        new NotFoundException('Categoria não encontrada.'),
      );
    });

    it('lança BadRequestException se parentId é o próprio id da categoria', async () => {
      prisma.category.findUnique.mockResolvedValue(makeCategory());

      await expect(
        service.update(CAT_ID, { parentId: CAT_ID }),
      ).rejects.toThrow(
        new BadRequestException('Uma categoria não pode ser pai dela mesma.'),
      );
    });

    it('lança BadRequestException se novo parentId não existe', async () => {
      prisma.category.findUnique
        .mockResolvedValueOnce(makeCategory()) // categoria a editar
        .mockResolvedValueOnce(null); // parent não encontrado

      await expect(
        service.update(CAT_ID, { parentId: 'pai-invalido' }),
      ).rejects.toThrow(
        new BadRequestException('Categoria pai não encontrada.'),
      );
    });

    it('lança BadRequestException se novo parentId está inactivo', async () => {
      prisma.category.findUnique
        .mockResolvedValueOnce(makeCategory())
        .mockResolvedValueOnce(
          makeCategory({ id: PARENT_ID, isActive: false }),
        );

      await expect(
        service.update(CAT_ID, { parentId: PARENT_ID }),
      ).rejects.toThrow(
        new BadRequestException(
          'Não é permitido vincular a uma categoria pai inativa.',
        ),
      );
    });

    it('actualiza iconUrl para null quando string vazia fornecida', async () => {
      prisma.category.findUnique.mockResolvedValue(makeCategory());
      prisma.category.update.mockResolvedValue(
        makeCategory({ iconUrl: undefined }),
      );

      await service.update(CAT_ID, { iconUrl: '   ' });

      const updateCall = prisma.category.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(updateCall.data.iconUrl).toBeNull();
    });

    it('não inclui campos no data quando não foram fornecidos no dto', async () => {
      prisma.category.findUnique.mockResolvedValue(makeCategory());
      prisma.category.update.mockResolvedValue(makeCategory());

      await service.update(CAT_ID, {}); // dto vazio

      const updateCall = prisma.category.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(updateCall.data).not.toHaveProperty('name');
      expect(updateCall.data).not.toHaveProperty('slug');
      expect(updateCall.data).not.toHaveProperty('iconUrl');
      expect(updateCall.data).not.toHaveProperty('parentId');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // remove()
  // ───────────────────────────────────────────────────────────────────────────

  describe('remove()', () => {
    it('remove categoria com sucesso (soft delete — isActive=false)', async () => {
      prisma.category.findUnique.mockResolvedValue(
        makeCategory({ children: [], equipment: [] }),
      );
      prisma.category.update.mockResolvedValue({});

      const result = await service.remove(CAT_ID);

      expect(result.message).toBe('Categoria removida com sucesso.');
      expect(prisma.category.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { isActive: false } }),
      );
    });

    it('nunca chama prisma.category.delete — é soft delete', async () => {
      prisma.category.findUnique.mockResolvedValue(
        makeCategory({ children: [], equipment: [] }),
      );
      prisma.category.update.mockResolvedValue({});

      await service.remove(CAT_ID);

      // Se delete fosse chamado, o mock sem delete rebentaria.
      // Confirmamos que update foi chamado em vez disso.
      expect(prisma.category.update).toHaveBeenCalledTimes(1);
    });

    it('lança NotFoundException se categoria não existe', async () => {
      prisma.category.findUnique.mockResolvedValue(null);

      await expect(service.remove(CAT_ID)).rejects.toThrow(
        new NotFoundException('Categoria não encontrada.'),
      );
      expect(prisma.category.update).not.toHaveBeenCalled();
    });

    it('lança NotFoundException se categoria já está inactiva', async () => {
      prisma.category.findUnique.mockResolvedValue(
        makeCategory({ isActive: false }),
      );

      await expect(service.remove(CAT_ID)).rejects.toThrow(
        new NotFoundException('Categoria não encontrada.'),
      );
    });

    it('lança BadRequestException se categoria tem subcategorias activas', async () => {
      prisma.category.findUnique.mockResolvedValue(
        makeCategory({
          children: [
            { id: 'child-1', name: 'Sub', slug: 'sub', isActive: true },
          ],
          equipment: [],
        }),
      );

      await expect(service.remove(CAT_ID)).rejects.toThrow(
        new BadRequestException(
          'Não é possível remover uma categoria que possui subcategorias ativas.',
        ),
      );
      expect(prisma.category.update).not.toHaveBeenCalled();
    });

    it('lança BadRequestException se categoria tem equipamentos vinculados', async () => {
      prisma.category.findUnique.mockResolvedValue(
        makeCategory({
          children: [],
          equipment: [{ id: 'equip-1', status: 'ACTIVE' }],
        }),
      );

      await expect(service.remove(CAT_ID)).rejects.toThrow(
        new BadRequestException(
          'Não é possível remover uma categoria que possui equipamentos vinculados.',
        ),
      );
      expect(prisma.category.update).not.toHaveBeenCalled();
    });
  });
});
