import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createTestApp } from './helpers/app';
import { authHeader, loginAsOutsider } from './helpers/auth';
import {
  BookingFlowActors,
  confirmBooking,
  createApprovedEquipment,
  createBooking,
  holdPayment,
  releasePayment,
  resetBookingFlow,
} from './helpers/booking-flow';
import { disconnectTestPrisma, getTestPrisma } from './helpers/db';

describe('Reviews and categories E2E', () => {
  let app: INestApplication;
  let actors: BookingFlowActors;
  const prisma = () => getTestPrisma();

  beforeAll(async () => {
    process.env.AUTO_APPROVE_EQUIPMENT = 'false';
    app = await createTestApp();
  }, 30000);

  beforeEach(async () => {
    actors = await resetBookingFlow(app);
  });

  afterAll(async () => {
    await app.close();
    await disconnectTestPrisma();
  });

  const as = (token: string) => ({
    get: (path: string) =>
      request(actors.httpServer).get(`/api/v1${path}`).set(authHeader(token)),
    patch: (path: string, body: object = {}) =>
      request(actors.httpServer)
        .patch(`/api/v1${path}`)
        .set(authHeader(token))
        .send(body),
    post: (path: string, body: object = {}) =>
      request(actors.httpServer)
        .post(`/api/v1${path}`)
        .set(authHeader(token))
        .send(body),
    delete: (path: string) =>
      request(actors.httpServer)
        .delete(`/api/v1${path}`)
        .set(authHeader(token)),
  });

  const admin = () => as(actors.admin.accessToken);
  const publicGet = (path: string) =>
    request(actors.httpServer).get(`/api/v1${path}`);

  const readUser = (id: string) =>
    prisma().user.findUniqueOrThrow({ where: { id } });

  const readEquipment = (id: string) =>
    prisma().equipment.findUniqueOrThrow({ where: { id } });

  /**
   * Os mesmos intervenientes com os papéis trocados: o cliente publica e o
   * provider aluga. Serve para pôr uma conta dos dois lados.
   */
  const swapped = (): BookingFlowActors => ({
    ...actors,
    provider: actors.client,
    client: actors.provider,
  });

  /** Aluguer pago, entregue e devolvido: os dois lados já podem avaliar. */
  async function completeRental(
    flow: BookingFlowActors,
    equipmentId: string,
    startsInDays: number,
  ): Promise<string> {
    const bookingId = await createBooking(flow, equipmentId, startsInDays);
    await confirmBooking(flow, bookingId);
    const paymentId = await holdPayment(flow, bookingId);
    await releasePayment(flow, paymentId);
    await as(flow.provider.accessToken)
      .patch(`/bookings/${bookingId}/confirm-return`)
      .expect(200);

    return bookingId;
  }

  const review = (
    token: string,
    bookingId: string,
    authorRole: 'CLIENT' | 'PROVIDER',
    rating: number,
  ) => as(token).post('/reviews', { bookingId, authorRole, rating });

  describe('the two ratings of an account', () => {
    it('keeps what clients said of a provider apart from what providers said of them as a client', async () => {
      // A conta "provider" aluga uma betoneira a um cliente, que lhe dá 5.
      const equipmentId = await createApprovedEquipment(actors);
      const rental = await completeRental(actors, equipmentId, 5);
      await review(actors.client.accessToken, rental, 'CLIENT', 5).expect(201);

      // A mesma conta aluga depois como cliente, e leva 1 de quem lhe alugou.
      const reversed = swapped();
      const otherEquipmentId = await createApprovedEquipment(reversed);
      const otherRental = await completeRental(reversed, otherEquipmentId, 5);
      await review(
        reversed.provider.accessToken,
        otherRental,
        'PROVIDER',
        1,
      ).expect(201);

      const account = await readUser(actors.provider.userId);
      expect(Number(account.providerRating)).toBe(5);
      expect(account.providerReviews).toBe(1);
      expect(Number(account.clientRating)).toBe(1);
      expect(account.clientReviews).toBe(1);

      // Ao lado do anúncio sai a nota como provider, sem a de cliente à mistura.
      const detail = await publicGet(`/equipment/${equipmentId}`).expect(200);
      expect(detail.body.data.owner).toMatchObject({
        totalRating: 5,
        totalReviews: 1,
      });

      const profile = await as(actors.client.accessToken)
        .get(`/users/${actors.provider.userId}`)
        .expect(200);
      expect(profile.body.data).toMatchObject({
        totalRating: 5,
        totalReviews: 1,
        clientRating: 1,
        clientReviews: 1,
      });
    });

    it('lists the reviews an account received on each side', async () => {
      const equipmentId = await createApprovedEquipment(actors);
      const rental = await completeRental(actors, equipmentId, 5);
      await review(actors.client.accessToken, rental, 'CLIENT', 5).expect(201);
      const reversed = swapped();
      const otherEquipmentId = await createApprovedEquipment(reversed);
      const otherRental = await completeRental(reversed, otherEquipmentId, 5);
      await review(
        reversed.provider.accessToken,
        otherRental,
        'PROVIDER',
        1,
      ).expect(201);

      const path = `/users/${actors.provider.userId}/reviews`;
      const all = await publicGet(path).expect(200);
      const fromClients = await publicGet(`${path}?authorRole=CLIENT`).expect(
        200,
      );
      const fromProviders = await publicGet(
        `${path}?authorRole=PROVIDER`,
      ).expect(200);

      const ratings = (response: request.Response) =>
        (response.body.data as Array<{ rating: number }>)
          .map(({ rating }) => rating)
          .sort();
      expect(ratings(all)).toEqual([1, 5]);
      expect(ratings(fromClients)).toEqual([5]);
      expect(ratings(fromProviders)).toEqual([1]);
    });
  });

  describe('ratings in the catalog', () => {
    it('shows the rating and the finished rentals of a listing in the public list', async () => {
      const equipmentId = await createApprovedEquipment(actors);
      const rental = await completeRental(actors, equipmentId, 5);
      await review(actors.client.accessToken, rental, 'CLIENT', 4).expect(201);

      const list = await publicGet('/equipment').expect(200);

      const listed = (
        list.body.data as Array<{
          id: string;
          totalRating: number | null;
          totalReviews: number;
          totalBookings: number;
        }>
      ).find((item) => item.id === equipmentId);
      expect(listed).toMatchObject({
        totalRating: 4,
        totalReviews: 1,
        totalBookings: 1,
      });
    });

    it('puts the reviewed listings first when sorting by relevance', async () => {
      const reviewedId = await createApprovedEquipment(actors);
      const rental = await completeRental(actors, reviewedId, 5);
      await review(actors.client.accessToken, rental, 'CLIENT', 5).expect(201);
      const newerId = await createApprovedEquipment(actors);

      const newest = await publicGet('/equipment?sortBy=newest').expect(200);
      const relevant = await publicGet('/equipment?sortBy=relevant').expect(
        200,
      );

      const order = (response: request.Response) =>
        (response.body.data as Array<{ id: string }>).map(({ id }) => id);
      expect(order(newest)).toEqual([newerId, reviewedId]);
      expect(order(relevant)).toEqual([reviewedId, newerId]);
    });
  });

  describe('reviews at the same time', () => {
    it('counts both when two clients review the same listing at once', async () => {
      const equipmentId = await createApprovedEquipment(actors);
      const firstRental = await completeRental(actors, equipmentId, 5);
      const second: BookingFlowActors = {
        ...actors,
        client: await loginAsOutsider(app),
      };
      const secondRental = await completeRental(second, equipmentId, 12);

      const responses = await Promise.all([
        review(actors.client.accessToken, firstRental, 'CLIENT', 5),
        review(second.client.accessToken, secondRental, 'CLIENT', 3),
      ]);

      expect(responses.map(({ status }) => status)).toEqual([201, 201]);
      const equipment = await readEquipment(equipmentId);
      expect(equipment.totalReviews).toBe(2);
      expect(Number(equipment.totalRating)).toBe(4);
      const owner = await readUser(actors.provider.userId);
      expect(owner.providerReviews).toBe(2);
      expect(Number(owner.providerRating)).toBe(4);
    });

    it('accepts one and refuses the other when the same review is sent twice at once', async () => {
      const equipmentId = await createApprovedEquipment(actors);
      const rental = await completeRental(actors, equipmentId, 5);

      const responses = await Promise.all([
        review(actors.client.accessToken, rental, 'CLIENT', 5),
        review(actors.client.accessToken, rental, 'CLIENT', 5),
      ]);

      expect(responses.map(({ status }) => status).sort()).toEqual([201, 400]);
      expect(await prisma().review.count()).toBe(1);
      expect((await readEquipment(equipmentId)).totalReviews).toBe(1);
    });
  });

  describe('category tree', () => {
    const CONSTRUCTION = () => actors.seed.categories.construcao;

    async function createCategory(body: object): Promise<string> {
      const response = await admin().post('/categories', body).expect(201);
      return response.body.data.id as string;
    }

    it('shows what is in a subcategory when the parent is chosen', async () => {
      const mixersId = await createCategory({
        name: 'Betoneiras',
        parentId: CONSTRUCTION().id,
      });
      const created = await as(actors.provider.accessToken)
        .post('/equipment', {
          title: 'Betoneira 500L',
          description: 'Betoneira a gasolina, com reboque, pronta a trabalhar.',
          categoryId: mixersId,
          pricePerDay: 2000,
          depositAmount: 3000,
          location: 'Matola',
        })
        .expect(201);
      const equipmentId = created.body.data.id as string;
      await admin().patch(`/equipment/${equipmentId}/approve`).expect(200);

      const ids = async (query: string) => {
        const response = await publicGet(`/equipment?${query}`).expect(200);
        return (response.body.data as Array<{ id: string }>).map(
          ({ id }) => id,
        );
      };

      expect(await ids(`categoryId=${CONSTRUCTION().id}`)).toEqual([
        equipmentId,
      ]);
      expect(await ids(`categorySlug=${CONSTRUCTION().slug}`)).toEqual([
        equipmentId,
      ]);
      expect(await ids(`categoryId=${mixersId}`)).toEqual([equipmentId]);
      expect(
        await ids(`categoryId=${actors.seed.categories.electricidade.id}`),
      ).toEqual([]);
    });

    it('returns 400 when a category is put under itself or under one of its subcategories', async () => {
      const mixersId = await createCategory({
        name: 'Betoneiras',
        parentId: CONSTRUCTION().id,
      });
      const electricMixersId = await createCategory({
        name: 'Betoneiras eléctricas',
        parentId: mixersId,
      });

      const underItself = await admin().patch(
        `/categories/${CONSTRUCTION().id}`,
        { parentId: CONSTRUCTION().id },
      );
      const underGrandchild = await admin().patch(
        `/categories/${CONSTRUCTION().id}`,
        { parentId: electricMixersId },
      );

      expect([underItself.status, underGrandchild.status]).toEqual([400, 400]);
      const construction = await prisma().category.findUniqueOrThrow({
        where: { id: CONSTRUCTION().id },
      });
      expect(construction.parentId).toBeNull();
    });

    it('takes a category out from under its parent with a null, and returns 400 for a null name', async () => {
      const mixersId = await createCategory({
        name: 'Betoneiras',
        parentId: CONSTRUCTION().id,
      });

      const detached = await admin().patch(`/categories/${mixersId}`, {
        parentId: null,
        iconUrl: null,
      });
      const nameless = await admin().patch(`/categories/${mixersId}`, {
        name: null,
      });

      expect(detached.status).toBe(200);
      expect(detached.body.data.parentId).toBeNull();
      expect(nameless.status).toBe(400);
    });
  });

  describe('category kind and activation', () => {
    const CONSTRUCTION = () => actors.seed.categories.construcao;

    it('saves the name and the kind together, as the admin panel sends them', async () => {
      const response = await admin().patch(`/categories/${CONSTRUCTION().id}`, {
        name: 'Construção civil',
        kind: 'BOTH',
      });

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        name: 'Construção civil',
        kind: 'BOTH',
      });
    });

    it('returns 400 when the kind would leave out the listings the category has', async () => {
      await createApprovedEquipment(actors);

      const response = await admin().patch(`/categories/${CONSTRUCTION().id}`, {
        kind: 'SERVICE',
      });

      expect(response.status).toBe(400);
      expect(response.body.message).toBe(
        'Esta categoria tem equipamentos. Não pode passar a ser só de serviços.',
      );
    });

    it('returns 400 for a service subcategory under an equipment category', async () => {
      const response = await admin().post('/categories', {
        name: 'Canalização',
        parentId: CONSTRUCTION().id,
        kind: 'SERVICE',
      });

      expect(response.status).toBe(400);
    });

    it('returns 400 for an unknown kind in the public list', async () => {
      const response = await publicGet('/categories?kind=xyz');

      expect(response.status).toBe(400);
      expect(response.body.message).toBe(
        'kind tem de ser EQUIPMENT, SERVICE ou BOTH.',
      );
    });

    it('deactivates an empty category, hides it from the public list and brings it back', async () => {
      const created = await admin()
        .post('/categories', { name: 'Jardinagem' })
        .expect(201);
      const categoryId = created.body.data.id as string;
      const publicIds = async () =>
        (
          (await publicGet('/categories').expect(200)).body.data as Array<{
            id: string;
          }>
        ).map(({ id }) => id);

      await admin()
        .patch(`/categories/${categoryId}`, { isActive: false })
        .expect(200);

      expect(await publicIds()).not.toContain(categoryId);
      const forAdmin = await admin().get('/categories/admin/all').expect(200);
      expect(forAdmin.body.data).toContainEqual(
        expect.objectContaining({ id: categoryId, isActive: false }),
      );

      const sameName = await admin().post('/categories', {
        name: 'Jardinagem',
      });
      expect(sameName.status).toBe(400);
      expect(sameName.body.message).toContain('desactivada');

      await admin()
        .patch(`/categories/${categoryId}`, { isActive: true })
        .expect(200);
      expect(await publicIds()).toContain(categoryId);
    });

    it('returns 400 when deactivating a category that has listings', async () => {
      await createApprovedEquipment(actors);

      const response = await admin().patch(`/categories/${CONSTRUCTION().id}`, {
        isActive: false,
      });

      expect(response.status).toBe(400);
    });

    it('returns 403 when someone who is not an admin asks for the full list', async () => {
      const response = await as(actors.client.accessToken).get(
        '/categories/admin/all',
      );

      expect(response.status).toBe(403);
    });
  });
});
