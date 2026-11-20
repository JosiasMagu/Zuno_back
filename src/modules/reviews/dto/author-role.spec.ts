import { ReviewAuthorRole } from '@prisma/client';

import { toAuthorRole } from './author-role';

describe('toAuthorRole', () => {
  it('trata OWNER, o nome antigo, como PROVIDER', () => {
    expect(toAuthorRole('OWNER')).toBe(ReviewAuthorRole.PROVIDER);
  });

  it.each([ReviewAuthorRole.CLIENT, ReviewAuthorRole.PROVIDER])(
    'deixa %s como veio',
    (role) => {
      expect(toAuthorRole(role)).toBe(role);
    },
  );

  it.each(['owner', 'ADMIN', '', undefined, 3])(
    'não converte %p, que fica para a validação recusar',
    (value) => {
      expect(toAuthorRole(value)).toBe(value);
    },
  );
});
