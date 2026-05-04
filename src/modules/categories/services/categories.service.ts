import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../../../shared/db/prisma.service';
import { CreateCategoryDto } from '../dto/create-category.dto';
import { UpdateCategoryDto } from '../dto/update-category.dto';

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateCategoryDto) {
    const name = dto.name.trim();
    const slug = this.slugify(name);
    const iconUrl = dto.iconUrl?.trim() || null;
    const parentId = dto.parentId?.trim() || null;

    if (!slug) {
      throw new BadRequestException('Nome de categoria inválido.');
    }

    const existingCategory = await this.prisma.category.findUnique({
      where: { slug },
    });

    if (existingCategory) {
      throw new BadRequestException('Já existe uma categoria com esse nome.');
    }

    if (parentId) {
      const parentCategory = await this.prisma.category.findUnique({
        where: { id: parentId },
      });

      if (!parentCategory) {
        throw new BadRequestException('Categoria pai não encontrada.');
      }

      if (!parentCategory.isActive) {
        throw new BadRequestException(
          'Não é permitido vincular a uma categoria pai inativa.',
        );
      }
    }

    const category = await this.prisma.category.create({
      data: {
        name,
        slug,
        iconUrl,
        parentId,
        isActive: true,
      },
      include: {
        parent: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
      },
    });

    return {
      message: 'Categoria criada com sucesso.',
      data: category,
    };
  }

  async findAll() {
    const items = await this.prisma.category.findMany({
      where: {
        isActive: true,
      },
      orderBy: [{ name: 'asc' }],
      include: {
        parent: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
      },
    });

    return {
      message: 'Categorias obtidas com sucesso.',
      data: items,
    };
  }

  async findOne(id: string) {
    const category = await this.prisma.category.findUnique({
      where: { id },
      include: {
        parent: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
        children: {
          where: {
            isActive: true,
          },
          select: {
            id: true,
            name: true,
            slug: true,
            isActive: true,
          },
          orderBy: {
            name: 'asc',
          },
        },
      },
    });

    if (!category || !category.isActive) {
      throw new NotFoundException('Categoria não encontrada.');
    }

    return {
      message: 'Categoria obtida com sucesso.',
      data: category,
    };
  }

  async update(id: string, dto: UpdateCategoryDto) {
    const existingCategory = await this.prisma.category.findUnique({
      where: { id },
    });

    if (!existingCategory || !existingCategory.isActive) {
      throw new NotFoundException('Categoria não encontrada.');
    }

    const data: {
      name?: string;
      slug?: string;
      iconUrl?: string | null;
      parentId?: string | null;
    } = {};

    if (dto.name !== undefined) {
      const name = dto.name.trim();
      const slug = this.slugify(name);

      if (!slug) {
        throw new BadRequestException('Nome de categoria inválido.');
      }

      const categoryWithSameSlug = await this.prisma.category.findUnique({
        where: { slug },
      });

      if (categoryWithSameSlug && categoryWithSameSlug.id !== id) {
        throw new BadRequestException('Já existe uma categoria com esse nome.');
      }

      data.name = name;
      data.slug = slug;
    }

    if (dto.iconUrl !== undefined) {
      data.iconUrl = dto.iconUrl.trim() || null;
    }

    if (dto.parentId !== undefined) {
      const parentId = dto.parentId.trim() || null;

      if (parentId === id) {
        throw new BadRequestException(
          'Uma categoria não pode ser pai dela mesma.',
        );
      }

      if (parentId) {
        const parentCategory = await this.prisma.category.findUnique({
          where: { id: parentId },
        });

        if (!parentCategory) {
          throw new BadRequestException('Categoria pai não encontrada.');
        }

        if (!parentCategory.isActive) {
          throw new BadRequestException(
            'Não é permitido vincular a uma categoria pai inativa.',
          );
        }
      }

      data.parentId = parentId;
    }

    const category = await this.prisma.category.update({
      where: { id },
      data,
      include: {
        parent: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
        children: {
          where: {
            isActive: true,
          },
          select: {
            id: true,
            name: true,
            slug: true,
            isActive: true,
          },
          orderBy: {
            name: 'asc',
          },
        },
      },
    });

    return {
      message: 'Categoria atualizada com sucesso.',
      data: category,
    };
  }

  async remove(id: string) {
    const existingCategory = await this.prisma.category.findUnique({
      where: { id },
      include: {
        children: {
          where: { isActive: true },
        },
        equipment: {
          where: {
            status: {
              not: 'DELETED',
            },
          },
        },
      },
    });

    if (!existingCategory || !existingCategory.isActive) {
      throw new NotFoundException('Categoria não encontrada.');
    }

    if (existingCategory.children.length > 0) {
      throw new BadRequestException(
        'Não é possível remover uma categoria que possui subcategorias ativas.',
      );
    }

    if (existingCategory.equipment.length > 0) {
      throw new BadRequestException(
        'Não é possível remover uma categoria que possui equipamentos vinculados.',
      );
    }

    await this.prisma.category.update({
      where: { id },
      data: {
        isActive: false,
      },
    });

    return {
      message: 'Categoria removida com sucesso.',
    };
  }

  private slugify(value: string) {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-');
  }
}
