import { CategoryKind } from '@prisma/client';

import {
  kindFitsParent,
  takesEquipment,
  takesServices,
  withDescendants,
  wouldCreateCycle,
} from './category-tree';

// construcao
//   ├─ betoneiras
//   │    └─ betoneiras-electricas
//   └─ andaimes
// jardinagem
const TREE = [
  { id: 'construcao', parentId: null },
  { id: 'betoneiras', parentId: 'construcao' },
  { id: 'betoneiras-electricas', parentId: 'betoneiras' },
  { id: 'andaimes', parentId: 'construcao' },
  { id: 'jardinagem', parentId: null },
];

describe('withDescendants', () => {
  it('devolve a categoria e tudo o que está debaixo dela', () => {
    expect(withDescendants(TREE, 'construcao').sort()).toEqual([
      'andaimes',
      'betoneiras',
      'betoneiras-electricas',
      'construcao',
    ]);
  });

  it('devolve só a própria quando não tem subcategorias', () => {
    expect(withDescendants(TREE, 'jardinagem')).toEqual(['jardinagem']);
  });

  it('não sobe para o pai nem passa para as irmãs', () => {
    expect(withDescendants(TREE, 'betoneiras').sort()).toEqual([
      'betoneiras',
      'betoneiras-electricas',
    ]);
  });

  it('não se perde num ciclo que já exista nos dados', () => {
    const looped = [
      { id: 'a', parentId: 'b' },
      { id: 'b', parentId: 'a' },
    ];

    expect(withDescendants(looped, 'a').sort()).toEqual(['a', 'b']);
  });
});

describe('wouldCreateCycle', () => {
  it('recusa a própria categoria como pai', () => {
    expect(wouldCreateCycle(TREE, 'construcao', 'construcao')).toBe(true);
  });

  it('recusa pôr uma categoria debaixo de uma filha', () => {
    expect(wouldCreateCycle(TREE, 'construcao', 'betoneiras')).toBe(true);
  });

  it('recusa pôr uma categoria debaixo de uma neta', () => {
    expect(wouldCreateCycle(TREE, 'construcao', 'betoneiras-electricas')).toBe(
      true,
    );
  });

  it('aceita mudar uma categoria para outro ramo', () => {
    expect(wouldCreateCycle(TREE, 'betoneiras', 'jardinagem')).toBe(false);
  });

  it('aceita pôr uma categoria debaixo de uma irmã', () => {
    expect(wouldCreateCycle(TREE, 'andaimes', 'betoneiras')).toBe(false);
  });
});

describe('kindFitsParent', () => {
  it.each([
    [CategoryKind.EQUIPMENT, CategoryKind.EQUIPMENT, true],
    [CategoryKind.SERVICE, CategoryKind.SERVICE, true],
    [CategoryKind.EQUIPMENT, CategoryKind.BOTH, true],
    [CategoryKind.SERVICE, CategoryKind.BOTH, true],
    [CategoryKind.BOTH, CategoryKind.BOTH, true],
    [CategoryKind.SERVICE, CategoryKind.EQUIPMENT, false],
    [CategoryKind.EQUIPMENT, CategoryKind.SERVICE, false],
    [CategoryKind.BOTH, CategoryKind.EQUIPMENT, false],
  ])('uma subcategoria %s debaixo de um pai %s: %s', (child, parent, fits) => {
    expect(kindFitsParent(child, parent)).toBe(fits);
  });
});

describe('o que cada tipo de categoria leva', () => {
  it.each([
    [CategoryKind.EQUIPMENT, true, false],
    [CategoryKind.SERVICE, false, true],
    [CategoryKind.BOTH, true, true],
  ])('%s: equipamentos %s, serviços %s', (kind, equipment, services) => {
    expect(takesEquipment(kind)).toBe(equipment);
    expect(takesServices(kind)).toBe(services);
  });
});
