import { CategoryKind } from '@prisma/client';

/** Uma categoria como a árvore precisa de a ver. */
export interface CategoryNode {
  id: string;
  parentId: string | null;
}

/**
 * A categoria `rootId` e todas as que estão debaixo dela. É o que o catálogo
 * mostra quando alguém escolhe uma categoria: quem escolhe «Construção» quer
 * ver também o que está em «Betoneiras».
 *
 * Não se perde num ciclo que já exista nos dados: cada categoria entra uma vez.
 */
export function withDescendants(
  categories: CategoryNode[],
  rootId: string,
): string[] {
  const childrenOf = new Map<string, string[]>();
  for (const category of categories) {
    if (category.parentId) {
      const siblings = childrenOf.get(category.parentId) ?? [];
      siblings.push(category.id);
      childrenOf.set(category.parentId, siblings);
    }
  }

  const found = new Set<string>([rootId]);
  const pending = [rootId];

  while (pending.length > 0) {
    const current = pending.pop() as string;
    for (const child of childrenOf.get(current) ?? []) {
      if (!found.has(child)) {
        found.add(child);
        pending.push(child);
      }
    }
  }

  return [...found];
}

/**
 * Pôr `categoryId` debaixo de `parentId` fechava um ciclo? Fecha quando o
 * novo pai é a própria categoria ou está algures debaixo dela.
 */
export function wouldCreateCycle(
  categories: CategoryNode[],
  categoryId: string,
  parentId: string,
): boolean {
  return withDescendants(categories, categoryId).includes(parentId);
}

/**
 * O tipo de uma subcategoria tem de caber no do pai. Um pai de equipamentos
 * só tem subcategorias de equipamentos, um de serviços só de serviços, e um
 * que serve para os dois aceita qualquer uma.
 */
export function kindFitsParent(
  childKind: CategoryKind,
  parentKind: CategoryKind,
): boolean {
  return parentKind === CategoryKind.BOTH || parentKind === childKind;
}

/** Uma categoria deste tipo pode ter equipamentos? */
export function takesEquipment(kind: CategoryKind): boolean {
  return kind !== CategoryKind.SERVICE;
}

/** Uma categoria deste tipo pode ter serviços? */
export function takesServices(kind: CategoryKind): boolean {
  return kind !== CategoryKind.EQUIPMENT;
}
