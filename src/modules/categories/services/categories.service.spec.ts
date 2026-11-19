import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AuditAction, CategoryKind } from '@prisma/client';

import { AuditService } from '../../../shared/audit/audit.service';
import { PrismaService } from '../../../shared/db/prisma.service';
import { CategoriesService } from './categories.service';

// IDs FIXOS

const CAT_ID = 'cat-uuid-001';
const PARENT_ID = 'cat-uuid-parent';
const OTHER_CAT_ID = 'cat-uuid-other';
const ADMIN_ID = 'admin-uuid-001';

// FACTORIES

const makeCategory = (overrides: Record<string, unknown> = {}) => ({
  id: CAT_ID,
  name: 'Construção',
  slug: 'construcao',
  iconUrl: undefined,
  parentId: undefined,
  isActive: true,
  kind: CategoryKind.EQUIPMENT,
  createdAt: new Date(),
  updatedAt: new Date(),
  parent: null,
  children: [],
  equipment: [],
  services: [],
  ...overrides,
});

// MOCK DO AUDIT

const auditMock = { record: jest.fn() };

// MOCK DO PRISMA

const makePrisma = () => ({
  category: {
    findUnique: jest.fn(),
    // Por omissão a árvore está vazia e a categoria não tem subcategorias.
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    create: jest.fn(),
    update: jest.fn(),
  },
  // Por omissão a categoria não tem anúncios.
  equipment: { count: jest.fn().mockResolvedValue(0) },
  service: { count: jest.fn().mockResolvedValue(0) },
});

// SUITE

describe('CategoriesService', () => {
  let service: CategoriesService;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(async () => {
    prisma = makePrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CategoriesService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: auditMock },
      ],
    }).compile();

    service = module.get<CategoriesService>(CategoriesService);
  });

  afterEach(() => jest.clearAllMocks());

  // create()

  describe('create()', () => {
    const dto = { name: 'Construção', iconUrl: undefined, parentId: undefined };

    it('cria categoria com sucesso e devolve a categoria criada', async () => {
      prisma.category.findUnique.mockResolvedValue(null);
      prisma.category.create.mockResolvedValue(makeCategory());

      const result = await service.create(ADMIN_ID, dto);

      expect(result.message).toBe('Categoria criada com sucesso.');
      expect(result.data.id).toBe(CAT_ID);
      expect(prisma.category.create).toHaveBeenCalledTimes(1);
    });

    it('gera o slug a partir do nome — remove acentos e converte para lowercase', async () => {
      prisma.category.findUnique.mockResolvedValue(null);
      prisma.category.create.mockResolvedValue(makeCategory());

      await service.create(ADMIN_ID, {
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

      await service.create(ADMIN_ID, {
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

      await service.create(ADMIN_ID, dto);

      const createCall = prisma.category.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(createCall.data.isActive).toBe(true);
    });

    it('guarda iconUrl como null quando não fornecido', async () => {
      prisma.category.findUnique.mockResolvedValue(null);
      prisma.category.create.mockResolvedValue(makeCategory());

      await service.create(ADMIN_ID, {
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

      await service.create(ADMIN_ID, {
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
        service.create(ADMIN_ID, {
          name: '!!!',
          iconUrl: undefined,
          parentId: undefined,
        }),
      ).rejects.toThrow(new BadRequestException('Nome de categoria inválido.'));
      expect(prisma.category.create).not.toHaveBeenCalled();
    });

    it('lança BadRequestException se já existe categoria com o mesmo slug', async () => {
      prisma.category.findUnique.mockResolvedValue(makeCategory());

      await expect(service.create(ADMIN_ID, dto)).rejects.toThrow(
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

      const result = await service.create(ADMIN_ID, {
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
        service.create(ADMIN_ID, {
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
        service.create(ADMIN_ID, {
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

    it('regista auditoria CATEGORY_CREATED com o actorId do admin', async () => {
      prisma.category.findUnique.mockResolvedValue(null);
      prisma.category.create.mockResolvedValue(makeCategory());

      await service.create(ADMIN_ID, dto);

      expect(auditMock.record).toHaveBeenCalledTimes(1);
      expect(auditMock.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.CATEGORY_CREATED,
          actorId: ADMIN_ID,
          targetType: 'Category',
          targetId: CAT_ID,
        }),
      );
    });

    it('não regista auditoria quando a criação falha', async () => {
      prisma.category.findUnique.mockResolvedValue(makeCategory());

      await expect(service.create(ADMIN_ID, dto)).rejects.toThrow(
        BadRequestException,
      );
      expect(auditMock.record).not.toHaveBeenCalled();
    });
  });

  // findAll()

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

    it('filtro kind=EQUIPMENT inclui categorias EQUIPMENT e BOTH', async () => {
      prisma.category.findMany.mockResolvedValue([]);

      await service.findAll({ kind: CategoryKind.EQUIPMENT });

      const whereArg = (
        prisma.category.findMany.mock.calls[0][0] as {
          where: Record<string, unknown>;
        }
      ).where;
      expect(whereArg.kind).toEqual({
        in: [CategoryKind.EQUIPMENT, CategoryKind.BOTH],
      });
    });

    it('filtro kind=BOTH devolve apenas categorias BOTH', async () => {
      prisma.category.findMany.mockResolvedValue([]);

      await service.findAll({ kind: CategoryKind.BOTH });

      const whereArg = (
        prisma.category.findMany.mock.calls[0][0] as {
          where: Record<string, unknown>;
        }
      ).where;
      expect(whereArg.kind).toBe(CategoryKind.BOTH);
    });
  });

  // findOne()

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

  // update()

  describe('update()', () => {
    it('actualiza o nome com sucesso — regenera o slug', async () => {
      prisma.category.findUnique
        .mockResolvedValueOnce(makeCategory()) // categoria a actualizar
        .mockResolvedValueOnce(null); // slug novo não colide

      prisma.category.update.mockResolvedValue(
        makeCategory({ name: 'Agricultura', slug: 'agricultura' }),
      );

      const result = await service.update(ADMIN_ID, CAT_ID, {
        name: 'Agricultura',
      });

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

      await service.update(ADMIN_ID, CAT_ID, { name: '  Logística  ' });

      const updateCall = prisma.category.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(updateCall.data.name).toBe('Logística');
    });

    it('lança BadRequestException se novo nome gera slug vazio', async () => {
      prisma.category.findUnique.mockResolvedValue(makeCategory());

      await expect(
        service.update(ADMIN_ID, CAT_ID, { name: '!!!' }),
      ).rejects.toThrow(new BadRequestException('Nome de categoria inválido.'));
      expect(prisma.category.update).not.toHaveBeenCalled();
    });

    it('lança BadRequestException se novo slug pertence a outra categoria', async () => {
      const outra = makeCategory({ id: OTHER_CAT_ID, slug: 'agricultura' });

      prisma.category.findUnique
        .mockResolvedValueOnce(makeCategory()) // categoria actual
        .mockResolvedValueOnce(outra); // slug em uso por outra

      await expect(
        service.update(ADMIN_ID, CAT_ID, { name: 'Agricultura' }),
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

      const result = await service.update(ADMIN_ID, CAT_ID, {
        name: 'Construção',
      });
      expect(result.message).toBe('Categoria atualizada com sucesso.');
    });

    it('lança NotFoundException se categoria não existe', async () => {
      prisma.category.findUnique.mockResolvedValue(null);

      await expect(
        service.update(ADMIN_ID, CAT_ID, { name: 'Novo' }),
      ).rejects.toThrow(new NotFoundException('Categoria não encontrada.'));
      expect(prisma.category.update).not.toHaveBeenCalled();
    });

    it('lança NotFoundException se categoria está inactiva', async () => {
      prisma.category.findUnique.mockResolvedValue(
        makeCategory({ isActive: false }),
      );

      await expect(
        service.update(ADMIN_ID, CAT_ID, { name: 'Novo' }),
      ).rejects.toThrow(new NotFoundException('Categoria não encontrada.'));
    });

    it('lança BadRequestException se parentId é o próprio id da categoria', async () => {
      prisma.category.findUnique.mockResolvedValue(makeCategory());

      await expect(
        service.update(ADMIN_ID, CAT_ID, { parentId: CAT_ID }),
      ).rejects.toThrow(
        new BadRequestException('Uma categoria não pode ser pai dela mesma.'),
      );
    });

    it('lança BadRequestException se novo parentId não existe', async () => {
      prisma.category.findUnique
        .mockResolvedValueOnce(makeCategory()) // categoria a editar
        .mockResolvedValueOnce(null); // parent não encontrado

      await expect(
        service.update(ADMIN_ID, CAT_ID, { parentId: 'pai-invalido' }),
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
        service.update(ADMIN_ID, CAT_ID, { parentId: PARENT_ID }),
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

      await service.update(ADMIN_ID, CAT_ID, { iconUrl: '   ' });

      const updateCall = prisma.category.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(updateCall.data.iconUrl).toBeNull();
    });

    it('não inclui campos no data quando não foram fornecidos no dto', async () => {
      prisma.category.findUnique.mockResolvedValue(makeCategory());
      prisma.category.update.mockResolvedValue(makeCategory());

      await service.update(ADMIN_ID, CAT_ID, {}); // dto vazio

      const updateCall = prisma.category.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(updateCall.data).not.toHaveProperty('name');
      expect(updateCall.data).not.toHaveProperty('slug');
      expect(updateCall.data).not.toHaveProperty('iconUrl');
      expect(updateCall.data).not.toHaveProperty('parentId');
    });
  });

  // remove()

  describe('remove()', () => {
    it('remove categoria com sucesso (soft delete — isActive=false)', async () => {
      prisma.category.findUnique.mockResolvedValue(
        makeCategory({ children: [], equipment: [] }),
      );
      prisma.category.update.mockResolvedValue({});

      const result = await service.remove(ADMIN_ID, CAT_ID);

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

      await service.remove(ADMIN_ID, CAT_ID);

      // Se delete fosse chamado, o mock sem delete rebentaria.
      // Confirmamos que update foi chamado em vez disso.
      expect(prisma.category.update).toHaveBeenCalledTimes(1);
    });

    it('lança NotFoundException se categoria não existe', async () => {
      prisma.category.findUnique.mockResolvedValue(null);

      await expect(service.remove(ADMIN_ID, CAT_ID)).rejects.toThrow(
        new NotFoundException('Categoria não encontrada.'),
      );
      expect(prisma.category.update).not.toHaveBeenCalled();
    });

    it('lança NotFoundException se categoria já está inactiva', async () => {
      prisma.category.findUnique.mockResolvedValue(
        makeCategory({ isActive: false }),
      );

      await expect(service.remove(ADMIN_ID, CAT_ID)).rejects.toThrow(
        new NotFoundException('Categoria não encontrada.'),
      );
    });

    it('lança BadRequestException se categoria tem subcategorias activas', async () => {
      prisma.category.findUnique.mockResolvedValue(makeCategory());
      prisma.category.count.mockResolvedValue(1);

      await expect(service.remove(ADMIN_ID, CAT_ID)).rejects.toThrow(
        new BadRequestException(
          'Não é possível remover uma categoria que possui subcategorias ativas.',
        ),
      );
      expect(prisma.category.update).not.toHaveBeenCalled();
    });

    it('lança BadRequestException se categoria tem equipamentos vinculados', async () => {
      prisma.category.findUnique.mockResolvedValue(makeCategory());
      prisma.equipment.count.mockResolvedValue(1);

      await expect(service.remove(ADMIN_ID, CAT_ID)).rejects.toThrow(
        new BadRequestException(
          'Não é possível remover uma categoria que possui equipamentos vinculados.',
        ),
      );
      expect(prisma.category.update).not.toHaveBeenCalled();
    });

    it('lança BadRequestException se categoria tem serviços vinculados', async () => {
      prisma.category.findUnique.mockResolvedValue(makeCategory());
      prisma.service.count.mockResolvedValue(1);

      await expect(service.remove(ADMIN_ID, CAT_ID)).rejects.toThrow(
        new BadRequestException(
          'Não é possível remover uma categoria que possui serviços vinculados.',
        ),
      );
      expect(prisma.category.update).not.toHaveBeenCalled();
    });

    it('regista auditoria CATEGORY_DEACTIVATED com o actorId do admin', async () => {
      prisma.category.findUnique.mockResolvedValue(makeCategory());
      prisma.category.update.mockResolvedValue({});

      await service.remove(ADMIN_ID, CAT_ID);

      expect(auditMock.record).toHaveBeenCalledTimes(1);
      expect(auditMock.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.CATEGORY_DEACTIVATED,
          actorId: ADMIN_ID,
          targetType: 'Category',
          targetId: CAT_ID,
        }),
      );
    });
  });

  // A árvore, o tipo e a reactivação

  describe('árvore de categorias', () => {
    const CHILD_ID = 'child-uuid-001';
    const GRANDCHILD_ID = 'grandchild-uuid-001';

    /** construcao > betoneiras > betoneiras eléctricas */
    const tree = [
      { id: CAT_ID, parentId: null },
      { id: CHILD_ID, parentId: CAT_ID },
      { id: GRANDCHILD_ID, parentId: CHILD_ID },
    ];

    it('recusa pôr uma categoria debaixo de uma das suas subcategorias', async () => {
      prisma.category.findUnique.mockResolvedValue(makeCategory());
      prisma.category.findMany.mockResolvedValue(tree);

      await expect(
        service.update(ADMIN_ID, CAT_ID, { parentId: GRANDCHILD_ID }),
      ).rejects.toThrow(
        new BadRequestException(
          'Uma categoria não pode ficar debaixo de uma das suas subcategorias.',
        ),
      );
      expect(prisma.category.update).not.toHaveBeenCalled();
    });

    it('aceita mudar uma subcategoria para outro ramo', async () => {
      const OTHER_ID = 'other-uuid-001';
      prisma.category.findUnique
        .mockResolvedValueOnce(makeCategory({ id: CHILD_ID, parentId: CAT_ID }))
        .mockResolvedValueOnce(makeCategory({ id: OTHER_ID }));
      prisma.category.findMany.mockResolvedValue([
        ...tree,
        { id: OTHER_ID, parentId: null },
      ]);
      prisma.category.update.mockResolvedValue(makeCategory({ id: CHILD_ID }));

      await service.update(ADMIN_ID, CHILD_ID, { parentId: OTHER_ID });

      expect(prisma.category.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { parentId: OTHER_ID } }),
      );
    });

    it('tira a categoria de debaixo do pai com parentId null', async () => {
      prisma.category.findUnique.mockResolvedValue(
        makeCategory({ id: CHILD_ID, parentId: CAT_ID }),
      );
      prisma.category.update.mockResolvedValue(makeCategory({ id: CHILD_ID }));

      await service.update(ADMIN_ID, CHILD_ID, { parentId: null });

      expect(prisma.category.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { parentId: null } }),
      );
    });

    it('tira o ícone com iconUrl null', async () => {
      prisma.category.findUnique.mockResolvedValue(
        makeCategory({ iconUrl: 'https://exemplo.com/icone.png' }),
      );
      prisma.category.update.mockResolvedValue(makeCategory());

      await service.update(ADMIN_ID, CAT_ID, { iconUrl: null });

      expect(prisma.category.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { iconUrl: null } }),
      );
    });

    it('não volta a olhar para o pai quando só muda o nome', async () => {
      prisma.category.findUnique
        .mockResolvedValueOnce(makeCategory({ id: CHILD_ID, parentId: CAT_ID }))
        .mockResolvedValueOnce(null);
      prisma.category.update.mockResolvedValue(makeCategory({ id: CHILD_ID }));

      await service.update(ADMIN_ID, CHILD_ID, { name: 'Betoneiras e afins' });

      // Só a categoria e a verificação do nome: o pai não é lido.
      expect(prisma.category.findUnique).toHaveBeenCalledTimes(2);
      expect(prisma.category.findMany).not.toHaveBeenCalled();
    });
  });

  describe('tipo da categoria', () => {
    const PARENT_ID = 'parent-uuid-001';

    it('recusa criar uma subcategoria de serviços debaixo de um pai de equipamentos', async () => {
      prisma.category.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(
          makeCategory({ id: PARENT_ID, kind: CategoryKind.EQUIPMENT }),
        );

      await expect(
        service.create(ADMIN_ID, {
          name: 'Canalização',
          parentId: PARENT_ID,
          kind: CategoryKind.SERVICE,
        }),
      ).rejects.toThrow(
        new BadRequestException(
          'Uma subcategoria tem de ser do mesmo tipo da categoria pai, salvo se o pai servir para equipamentos e serviços.',
        ),
      );
      expect(prisma.category.create).not.toHaveBeenCalled();
    });

    it('aceita qualquer subcategoria debaixo de um pai que serve para os dois', async () => {
      prisma.category.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(
          makeCategory({ id: PARENT_ID, kind: CategoryKind.BOTH }),
        );
      prisma.category.create.mockResolvedValue(makeCategory());

      await expect(
        service.create(ADMIN_ID, {
          name: 'Canalização',
          parentId: PARENT_ID,
          kind: CategoryKind.SERVICE,
        }),
      ).resolves.toBeDefined();
    });

    it('muda o tipo de uma categoria vazia', async () => {
      prisma.category.findUnique.mockResolvedValue(makeCategory());
      prisma.category.update.mockResolvedValue(
        makeCategory({ kind: CategoryKind.BOTH }),
      );

      await service.update(ADMIN_ID, CAT_ID, { kind: CategoryKind.BOTH });

      expect(prisma.category.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { kind: CategoryKind.BOTH } }),
      );
    });

    it('recusa passar a só de serviços uma categoria com equipamentos', async () => {
      prisma.category.findUnique.mockResolvedValue(makeCategory());
      prisma.equipment.count.mockResolvedValue(3);

      await expect(
        service.update(ADMIN_ID, CAT_ID, { kind: CategoryKind.SERVICE }),
      ).rejects.toThrow(
        new BadRequestException(
          'Esta categoria tem equipamentos. Não pode passar a ser só de serviços.',
        ),
      );
    });

    it('recusa passar a só de equipamentos uma categoria com serviços', async () => {
      prisma.category.findUnique.mockResolvedValue(
        makeCategory({ kind: CategoryKind.BOTH }),
      );
      prisma.service.count.mockResolvedValue(1);

      await expect(
        service.update(ADMIN_ID, CAT_ID, { kind: CategoryKind.EQUIPMENT }),
      ).rejects.toThrow(
        new BadRequestException(
          'Esta categoria tem serviços. Não pode passar a ser só de equipamentos.',
        ),
      );
    });

    it('recusa um tipo que deixa de fora as subcategorias', async () => {
      prisma.category.findUnique.mockResolvedValue(
        makeCategory({ kind: CategoryKind.BOTH }),
      );
      prisma.category.findMany.mockResolvedValue([
        { kind: CategoryKind.SERVICE },
      ]);

      await expect(
        service.update(ADMIN_ID, CAT_ID, { kind: CategoryKind.EQUIPMENT }),
      ).rejects.toThrow(
        new BadRequestException(
          'Esta categoria tem subcategorias de outro tipo. Muda primeiro o tipo delas.',
        ),
      );
    });

    it('guarda o nome e o tipo juntos, como o painel do admin os envia', async () => {
      prisma.category.findUnique
        .mockResolvedValueOnce(makeCategory())
        .mockResolvedValueOnce(null);
      prisma.category.update.mockResolvedValue(makeCategory());

      await service.update(ADMIN_ID, CAT_ID, {
        name: 'Construção civil',
        kind: CategoryKind.BOTH,
      });

      expect(prisma.category.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            name: 'Construção civil',
            slug: 'construcao-civil',
            kind: CategoryKind.BOTH,
          },
        }),
      );
    });
  });

  describe('activar e desactivar', () => {
    it('desactiva pela edição com as mesmas condições da remoção', async () => {
      prisma.category.findUnique.mockResolvedValue(makeCategory());
      prisma.equipment.count.mockResolvedValue(2);

      await expect(
        service.update(ADMIN_ID, CAT_ID, { isActive: false }),
      ).rejects.toThrow(
        new BadRequestException(
          'Não é possível remover uma categoria que possui equipamentos vinculados.',
        ),
      );
    });

    it('desactiva uma categoria vazia e fica em auditoria como desactivação', async () => {
      prisma.category.findUnique.mockResolvedValue(makeCategory());
      prisma.category.update.mockResolvedValue(
        makeCategory({ isActive: false }),
      );

      await service.update(ADMIN_ID, CAT_ID, { isActive: false });

      expect(prisma.category.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { isActive: false } }),
      );
      expect(auditMock.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'CATEGORY_DEACTIVATED' }),
      );
    });

    it('reactiva uma categoria desactivada', async () => {
      prisma.category.findUnique.mockResolvedValue(
        makeCategory({ isActive: false }),
      );
      prisma.category.update.mockResolvedValue(makeCategory());

      await service.update(ADMIN_ID, CAT_ID, { isActive: true });

      expect(prisma.category.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { isActive: true } }),
      );
      expect(auditMock.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'CATEGORY_REACTIVATED' }),
      );
    });

    it('recusa reactivar debaixo de um pai desactivado', async () => {
      prisma.category.findUnique
        .mockResolvedValueOnce(
          makeCategory({ isActive: false, parentId: 'parent-uuid-001' }),
        )
        .mockResolvedValueOnce({ isActive: false });

      await expect(
        service.update(ADMIN_ID, CAT_ID, { isActive: true }),
      ).rejects.toThrow(
        new BadRequestException(
          'A categoria pai está desactivada. Reactiva-a primeiro, ou tira esta categoria de debaixo dela.',
        ),
      );
    });

    it('continua a responder 404 a outra edição de uma categoria desactivada', async () => {
      prisma.category.findUnique.mockResolvedValue(
        makeCategory({ isActive: false }),
      );

      await expect(
        service.update(ADMIN_ID, CAT_ID, { name: 'Outro nome' }),
      ).rejects.toThrow(new NotFoundException('Categoria não encontrada.'));
    });

    it('diz que o nome pertence a uma categoria desactivada', async () => {
      prisma.category.findUnique.mockResolvedValue(
        makeCategory({ id: 'outra-uuid', isActive: false }),
      );

      await expect(
        service.create(ADMIN_ID, { name: 'Construção' }),
      ).rejects.toThrow(
        new BadRequestException(
          'Já existe uma categoria desactivada com esse nome. Reactiva-a em vez de criar outra.',
        ),
      );
    });

    it('a lista do admin traz também as desactivadas, com as activas primeiro', async () => {
      prisma.category.findMany.mockResolvedValue([
        makeCategory(),
        makeCategory({ id: 'outra-uuid', isActive: false }),
      ]);

      const result = await service.findAllForAdmin();

      expect(result.data).toHaveLength(2);
      expect(prisma.category.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
        }),
      );
      expect(
        (prisma.category.findMany.mock.calls[0][0] as { where?: unknown })
          .where,
      ).toBeUndefined();
    });
  });
});
