import { PrismaService } from '../db/prisma.service';
import { withDescendants } from './category-tree';

/**
 * As categorias que o filtro do catálogo apanha: a que foi pedida, por id ou
 * por slug, e todas as que estão debaixo dela. Quem escolhe «Construção» vê
 * também o que está em «Betoneiras».
 *
 * Devolve null quando o filtro não foi usado, e uma lista vazia quando a
 * categoria pedida não existe ou está desactivada.
 */
export async function categoryScope(
  prisma: Pick<PrismaService, 'category'>,
  filter: { categoryId?: string; categorySlug?: string },
): Promise<string[] | null> {
  const id = filter.categoryId?.trim();
  const slug = filter.categorySlug?.trim();

  if (!id && !slug) {
    return null;
  }

  const categories = await prisma.category.findMany({
    where: { isActive: true },
    select: { id: true, slug: true, parentId: true },
  });
  const root = categories.find((category) =>
    id ? category.id === id : category.slug === slug,
  );

  return root ? withDescendants(categories, root.id) : [];
}
