import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  Category,
  CategoryKind,
  EquipmentStatus,
  Prisma,
  ServiceStatus,
} from '@prisma/client';

import { AuditService } from '../../../shared/audit/audit.service';
import {
  kindFitsParent,
  takesEquipment,
  takesServices,
  wouldCreateCycle,
} from '../../../shared/categories/category-tree';
import { PrismaService } from '../../../shared/db/prisma.service';
import { CreateCategoryDto } from '../dto/create-category.dto';
import { UpdateCategoryDto } from '../dto/update-category.dto';

const WITH_PARENT = {
  parent: { select: { id: true, name: true, slug: true } },
} satisfies Prisma.CategoryInclude;

const WITH_FAMILY = {
  ...WITH_PARENT,
  children: {
    where: { isActive: true },
    select: { id: true, name: true, slug: true, isActive: true },
    orderBy: { name: 'asc' },
  },
} satisfies Prisma.CategoryInclude;

const NOT_FOUND = 'Categoria não encontrada.';

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(adminId: string, dto: CreateCategoryDto) {
    const name = dto.name.trim();
    const slug = this.slugify(name);
    const iconUrl = dto.iconUrl?.trim() || null;
    const parentId = dto.parentId?.trim() || null;
    const kind = dto.kind ?? CategoryKind.EQUIPMENT;

    if (!slug) {
      throw new BadRequestException('Nome de categoria inválido.');
    }

    await this.assertNameIsFree(slug);

    if (parentId) {
      await this.assertParentAccepts(parentId, kind);
    }

    const category = await this.prisma.category.create({
      data: { name, slug, iconUrl, parentId, isActive: true, kind },
      include: WITH_PARENT,
    });

    await this.audit.record({
      action: AuditAction.CATEGORY_CREATED,
      actorId: adminId,
      targetType: 'Category',
      targetId: category.id,
      metadata: {
        name: category.name,
        slug: category.slug,
        kind: category.kind,
      },
    });

    return {
      message: 'Categoria criada com sucesso.',
      data: category,
    };
  }

  async findAll(filter?: { kind?: CategoryKind }) {
    const where: Prisma.CategoryWhereInput = { isActive: true };

    if (filter?.kind) {
      // EQUIPMENT match → kind in [EQUIPMENT, BOTH]
      // SERVICE match → kind in [SERVICE, BOTH]
      // BOTH match → only BOTH
      if (filter.kind === CategoryKind.EQUIPMENT) {
        where.kind = { in: [CategoryKind.EQUIPMENT, CategoryKind.BOTH] };
      } else if (filter.kind === CategoryKind.SERVICE) {
        where.kind = { in: [CategoryKind.SERVICE, CategoryKind.BOTH] };
      } else {
        where.kind = CategoryKind.BOTH;
      }
    }

    const items = await this.prisma.category.findMany({
      where,
      orderBy: [{ name: 'asc' }],
      include: WITH_PARENT,
    });

    return {
      message: 'Categorias obtidas com sucesso.',
      data: items,
    };
  }

  /**
   * Todas as categorias, activas e desactivadas, para o painel do admin. A
   * lista pública só traz as activas, e sem esta uma categoria desactivada
   * deixava de se ver e não havia como a reactivar.
   */
  async findAllForAdmin() {
    const items = await this.prisma.category.findMany({
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      include: WITH_PARENT,
    });

    return {
      message: 'Categorias obtidas com sucesso.',
      data: items,
    };
  }

  async findOne(id: string) {
    const category = await this.prisma.category.findUnique({
      where: { id },
      include: WITH_FAMILY,
    });

    if (!category || !category.isActive) {
      throw new NotFoundException(NOT_FOUND);
    }

    return {
      message: 'Categoria obtida com sucesso.',
      data: category,
    };
  }

  /**
   * Edita uma categoria: nome, ícone, pai, tipo e se está activa. Uma
   * categoria desactivada só aceita um pedido que a reactive.
   */
  async update(adminId: string, id: string, dto: UpdateCategoryDto) {
    const existing = await this.prisma.category.findUnique({ where: { id } });

    if (!existing || (!existing.isActive && dto.isActive !== true)) {
      throw new NotFoundException(NOT_FOUND);
    }

    const data: Prisma.CategoryUncheckedUpdateInput = {};

    if (dto.name !== undefined) {
      const name = dto.name.trim();
      const slug = this.slugify(name);

      if (!slug) {
        throw new BadRequestException('Nome de categoria inválido.');
      }

      await this.assertNameIsFree(slug, id);

      data.name = name;
      data.slug = slug;
    }

    if (dto.iconUrl !== undefined) {
      // null ou vazio tiram o ícone.
      data.iconUrl = dto.iconUrl?.trim() || null;
    }

    const kind = dto.kind ?? existing.kind;
    const parentId =
      dto.parentId === undefined
        ? existing.parentId
        : dto.parentId?.trim() || null;
    const parentChanged = parentId !== existing.parentId;
    const kindChanged = kind !== existing.kind;

    if (parentChanged) {
      await this.assertNoCycle(id, parentId);
      data.parentId = parentId;
    }

    if (kindChanged) {
      await this.assertKindFitsContents(id, kind);
      data.kind = kind;
    }

    // Só se volta a olhar para o pai quando a ligação ou o tipo mudam: uma
    // categoria antiga que não cumpra a regra continua a poder mudar de nome.
    if (parentId && (parentChanged || kindChanged)) {
      await this.assertParentAccepts(parentId, kind);
    }

    const deactivating = dto.isActive === false && existing.isActive;
    const reactivating = dto.isActive === true && !existing.isActive;

    if (deactivating) {
      await this.assertCanDeactivate(id);
      data.isActive = false;
    }

    if (reactivating) {
      await this.assertParentIsActive(parentId);
      data.isActive = true;
    }

    const category = await this.prisma.category.update({
      where: { id },
      data,
      include: WITH_FAMILY,
    });

    await this.audit.record({
      action: this.auditActionFor({ deactivating, reactivating }),
      actorId: adminId,
      targetType: 'Category',
      targetId: category.id,
      metadata: {
        name: category.name,
        slug: category.slug,
        changedFields: Object.keys(data),
      },
    });

    return {
      message: 'Categoria atualizada com sucesso.',
      data: category,
    };
  }

  async remove(adminId: string, id: string) {
    const existing = await this.prisma.category.findUnique({ where: { id } });

    if (!existing || !existing.isActive) {
      throw new NotFoundException(NOT_FOUND);
    }

    await this.assertCanDeactivate(id);

    await this.prisma.category.update({
      where: { id },
      data: { isActive: false },
    });

    await this.audit.record({
      action: AuditAction.CATEGORY_DEACTIVATED,
      actorId: adminId,
      targetType: 'Category',
      targetId: id,
      metadata: { name: existing.name, slug: existing.slug },
    });

    return {
      message: 'Categoria removida com sucesso.',
    };
  }

  private auditActionFor(change: {
    deactivating: boolean;
    reactivating: boolean;
  }): AuditAction {
    if (change.reactivating) return AuditAction.CATEGORY_REACTIVATED;
    if (change.deactivating) return AuditAction.CATEGORY_DEACTIVATED;
    return AuditAction.CATEGORY_UPDATED;
  }

  /**
   * O nome não pode repetir o de outra categoria. Quando a outra está
   * desactivada, a mensagem diz que o caminho é reactivá-la.
   */
  private async assertNameIsFree(slug: string, exceptId?: string) {
    const taken = await this.prisma.category.findUnique({ where: { slug } });

    if (!taken || taken.id === exceptId) {
      return;
    }

    throw new BadRequestException(
      taken.isActive
        ? 'Já existe uma categoria com esse nome.'
        : 'Já existe uma categoria desactivada com esse nome. Reactiva-a em vez de criar outra.',
    );
  }

  /** O pai existe, está activo e aceita subcategorias deste tipo. */
  private async assertParentAccepts(parentId: string, kind: CategoryKind) {
    const parent = await this.prisma.category.findUnique({
      where: { id: parentId },
    });

    if (!parent) {
      throw new BadRequestException('Categoria pai não encontrada.');
    }

    if (!parent.isActive) {
      throw new BadRequestException(
        'Não é permitido vincular a uma categoria pai inativa.',
      );
    }

    if (!kindFitsParent(kind, parent.kind)) {
      throw new BadRequestException(
        'Uma subcategoria tem de ser do mesmo tipo da categoria pai, salvo se o pai servir para equipamentos e serviços.',
      );
    }
  }

  /**
   * Uma categoria não pode ficar debaixo de si própria nem de uma das suas
   * subcategorias. Com um ciclo, quem percorre a árvore nunca chega ao fim e
   * nenhuma das categorias do ciclo se consegue remover.
   */
  private async assertNoCycle(id: string, parentId: string | null) {
    if (!parentId) {
      return;
    }

    if (parentId === id) {
      throw new BadRequestException(
        'Uma categoria não pode ser pai dela mesma.',
      );
    }

    const categories = await this.prisma.category.findMany({
      select: { id: true, parentId: true },
    });

    if (wouldCreateCycle(categories, id, parentId)) {
      throw new BadRequestException(
        'Uma categoria não pode ficar debaixo de uma das suas subcategorias.',
      );
    }
  }

  /**
   * Mudar o tipo não pode deixar de fora o que a categoria já tem: as
   * subcategorias activas, os equipamentos e os serviços.
   */
  private async assertKindFitsContents(id: string, kind: CategoryKind) {
    const [children, equipment, services] = await Promise.all([
      this.prisma.category.findMany({
        where: { parentId: id, isActive: true },
        select: { kind: true },
      }),
      this.prisma.equipment.count({
        where: { categoryId: id, status: { not: EquipmentStatus.DELETED } },
      }),
      this.prisma.service.count({
        where: { categoryId: id, status: { not: ServiceStatus.DELETED } },
      }),
    ]);

    if (children.some((child) => !kindFitsParent(child.kind, kind))) {
      throw new BadRequestException(
        'Esta categoria tem subcategorias de outro tipo. Muda primeiro o tipo delas.',
      );
    }

    if (equipment > 0 && !takesEquipment(kind)) {
      throw new BadRequestException(
        'Esta categoria tem equipamentos. Não pode passar a ser só de serviços.',
      );
    }

    if (services > 0 && !takesServices(kind)) {
      throw new BadRequestException(
        'Esta categoria tem serviços. Não pode passar a ser só de equipamentos.',
      );
    }
  }

  /** Só se desactiva uma categoria vazia: sem subcategorias activas nem anúncios. */
  private async assertCanDeactivate(id: string) {
    const [children, equipment, services] = await Promise.all([
      this.prisma.category.count({ where: { parentId: id, isActive: true } }),
      this.prisma.equipment.count({
        where: { categoryId: id, status: { not: EquipmentStatus.DELETED } },
      }),
      this.prisma.service.count({
        where: { categoryId: id, status: { not: ServiceStatus.DELETED } },
      }),
    ]);

    if (children > 0) {
      throw new BadRequestException(
        'Não é possível remover uma categoria que possui subcategorias ativas.',
      );
    }

    if (equipment > 0) {
      throw new BadRequestException(
        'Não é possível remover uma categoria que possui equipamentos vinculados.',
      );
    }

    if (services > 0) {
      throw new BadRequestException(
        'Não é possível remover uma categoria que possui serviços vinculados.',
      );
    }
  }

  /** Uma categoria só volta a ficar activa debaixo de um pai activo. */
  private async assertParentIsActive(parentId: string | null) {
    if (!parentId) {
      return;
    }

    const parent: Pick<Category, 'isActive'> | null =
      await this.prisma.category.findUnique({
        where: { id: parentId },
        select: { isActive: true },
      });

    if (!parent?.isActive) {
      throw new BadRequestException(
        'A categoria pai está desactivada. Reactiva-a primeiro, ou tira esta categoria de debaixo dela.',
      );
    }
  }

  private slugify(value: string) {
    return value
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-');
  }
}
