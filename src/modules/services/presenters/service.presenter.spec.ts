import { Prisma } from '@prisma/client';

import { ServicePresenter } from './service.presenter';

const service = {
  id: 'service-1',
  title: 'Reparação de quadros eléctricos',
  description: 'Diagnóstico e reparação no local.',
  location: 'Maputo',
  basePrice: new Prisma.Decimal(2500),
  pricingType: 'FIXED',
  estimatedHours: 3,
  acceptsUrgent: true,
  urgentSurcharge: new Prisma.Decimal(20),
  isActive: true,
  status: 'ACTIVE',
  totalRating: new Prisma.Decimal(4.5),
  totalReviews: 8,
  _count: { bookings: 5 },
  category: { id: 'cat-1', name: 'Electricidade', slug: 'electricidade' },
  provider: { id: 'provider-1', name: 'Carlos', avatarUrl: null },
  photos: [{ url: 'https://exemplo/foto.jpg', isPrimary: true, order: 0 }],
};

describe('ServicePresenter', () => {
  describe('toListItem()', () => {
    // É a forma que a app declara no seu tipo `Service`.
    it('dá a categoria e o provider como objectos, como o detalhe', () => {
      const item = ServicePresenter.toListItem(service);

      expect(item.category).toEqual(service.category);
      expect(item.provider).toEqual(service.provider);
    });

    it('converte os valores decimais em números', () => {
      expect(ServicePresenter.toListItem(service)).toMatchObject({
        basePrice: 2500,
        urgentSurcharge: 20,
        totalRating: 4.5,
        totalCompleted: 5,
        image: 'https://exemplo/foto.jpg',
      });
    });
  });
});
