import { Prisma } from '@prisma/client';

import {
  carriesOnWork,
  changedFields,
  ListingEdit,
  ListingStatus,
  returnsToReview,
} from './listing-moderation';

const edit = (overrides: Partial<ListingEdit> = {}): ListingEdit => ({
  status: ListingStatus.ACTIVE,
  editor: 'owner',
  changed: true,
  moderatedContentChanged: true,
  ...overrides,
});

describe('returnsToReview', () => {
  describe('anúncio activo', () => {
    it('volta à revisão quando o dono muda o conteúdo aprovado', () => {
      expect(returnsToReview(edit())).toBe(true);
    });

    it('fica activo quando o dono só muda preço, quantidade ou localização', () => {
      expect(returnsToReview(edit({ moderatedContentChanged: false }))).toBe(
        false,
      );
    });

    it('fica activo quando o dono é de confiança', () => {
      expect(returnsToReview(edit({ editor: 'trusted-owner' }))).toBe(false);
    });

    it('fica activo quando é um admin a editar', () => {
      expect(returnsToReview(edit({ editor: 'admin' }))).toBe(false);
    });
  });

  describe('anúncio rejeitado', () => {
    const rejected = (overrides: Partial<ListingEdit> = {}) =>
      edit({ status: ListingStatus.REJECTED, ...overrides });

    it('volta à revisão quando o dono muda qualquer coisa, mesmo só o preço', () => {
      expect(
        returnsToReview(rejected({ moderatedContentChanged: false })),
      ).toBe(true);
    });

    it('volta à revisão mesmo com um dono de confiança, porque foi um admin que o rejeitou', () => {
      expect(returnsToReview(rejected({ editor: 'trusted-owner' }))).toBe(true);
    });

    it('fica rejeitado quando a edição não muda nada', () => {
      expect(
        returnsToReview(
          rejected({ changed: false, moderatedContentChanged: false }),
        ),
      ).toBe(false);
    });

    it('fica rejeitado quando é um admin a editar', () => {
      expect(returnsToReview(rejected({ editor: 'admin' }))).toBe(false);
    });
  });

  it.each([ListingStatus.PENDING_REVIEW, ListingStatus.PAUSED])(
    'não mexe num anúncio %s',
    (status) => {
      expect(returnsToReview(edit({ status }))).toBe(false);
    },
  );
});

describe('carriesOnWork', () => {
  it.each([
    [ListingStatus.ACTIVE, true],
    [ListingStatus.PENDING_REVIEW, true],
    [ListingStatus.REJECTED, false],
    [ListingStatus.PAUSED, false],
    [ListingStatus.DELETED, false],
  ])('%s leva adiante o que estava em curso: %s', (status, expected) => {
    expect(carriesOnWork(status)).toBe(expected);
  });
});

describe('changedFields', () => {
  const current = {
    title: 'Betoneira 300L',
    description: 'Betoneira eléctrica em bom estado.',
    pricePerDay: new Prisma.Decimal('1500.00'),
    pricePerWeek: null,
    deliveryIncluded: false,
  };

  it('não dá por mudado um formulário enviado inteiro sem alterações', () => {
    expect(
      changedFields(current, {
        title: 'Betoneira 300L',
        description: 'Betoneira eléctrica em bom estado.',
        pricePerDay: 1500,
        deliveryIncluded: false,
      }),
    ).toEqual([]);
  });

  it('aponta só os campos cujo valor muda', () => {
    expect(
      changedFields(current, {
        title: 'Gerador 50 kVA',
        description: 'Betoneira eléctrica em bom estado.',
        pricePerDay: 1800,
      }),
    ).toEqual(['title', 'pricePerDay']);
  });

  it('ignora os campos que não foram enviados', () => {
    expect(
      changedFields(current, { title: undefined, pricePerDay: undefined }),
    ).toEqual([]);
  });

  it('dá por mudado um valor que antes estava vazio', () => {
    expect(changedFields(current, { pricePerWeek: 9000 })).toEqual([
      'pricePerWeek',
    ]);
  });

  it('compara o dinheiro pelo valor e não pela forma como vem da base', () => {
    expect(changedFields(current, { pricePerDay: 1500.0 })).toEqual([]);
    expect(changedFields(current, { pricePerDay: 1500.01 })).toEqual([
      'pricePerDay',
    ]);
  });
});
