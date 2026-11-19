import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createTestApp } from './helpers/app';
import { authHeader, loginAsOutsider } from './helpers/auth';
import {
  BookingFlowActors,
  confirmBooking,
  createApprovedEquipment,
  createBooking,
  createHeldBooking,
  PRICE_PER_DAY,
  releasePayment,
  resetBookingFlow,
} from './helpers/booking-flow';
import { disconnectTestPrisma, getTestPrisma } from './helpers/db';
import {
  acceptServiceQuote,
  createHeldServiceBooking,
  createServiceQuote,
} from './helpers/service-flow';

const STARTS_IN_DAYS = 5;

// O que o helper createApprovedEquipment publica. A app envia o formulário
// inteiro em cada gravação, por isso os testes também.
const TITLE = 'Betoneira E2E';
const DESCRIPTION =
  'Betoneira eletrica de 300L para testes E2E. Excelente estado de conservacao.';

describe('Catalog and moderation E2E', () => {
  let app: INestApplication;
  let actors: BookingFlowActors;
  const prisma = () => getTestPrisma();

  beforeAll(async () => {
    // Os testes provam a moderação: nada é aprovado sozinho.
    process.env.AUTO_APPROVE_EQUIPMENT = 'false';
    process.env.AUTO_APPROVE_SERVICES = 'false';
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

  const provider = () => as(actors.provider.accessToken);
  const client = () => as(actors.client.accessToken);
  const admin = () => as(actors.admin.accessToken);
  const publicGet = (path: string) =>
    request(actors.httpServer).get(`/api/v1${path}`);

  const wholeForm = (overrides: object = {}) => ({
    title: TITLE,
    description: DESCRIPTION,
    categoryId: actors.seed.categories.construcao.id,
    pricePerDay: PRICE_PER_DAY,
    depositAmount: 5000,
    location: 'Maputo, Cidade',
    ...overrides,
  });

  const readEquipment = (id: string) =>
    prisma().equipment.findUniqueOrThrow({ where: { id } });

  const readService = (id: string) =>
    prisma().service.findUniqueOrThrow({ where: { id } });

  const auditsOf = (targetId: string) =>
    prisma().auditLog.findMany({
      where: { targetId },
      select: { action: true, actorId: true, metadata: true },
    });

  const isInCatalog = async (equipmentId: string) => {
    const response = await publicGet('/equipment').expect(200);
    const listed = response.body.data as Array<{ id: string }>;
    return listed.some((item) => item.id === equipmentId);
  };

  describe('editing an approved equipment listing', () => {
    it('stays public when the whole form is saved with only a new price', async () => {
      const equipmentId = await createApprovedEquipment(actors);

      const response = await provider().patch(
        `/equipment/${equipmentId}`,
        wholeForm({ pricePerDay: 1800 }),
      );

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Equipamento atualizado com sucesso.');
      expect(response.body.data).toMatchObject({
        status: 'ACTIVE',
        pricePerDay: 1800,
      });
      expect(await isInCatalog(equipmentId)).toBe(true);
    });

    it('goes back to review when the title changes, and leaves the catalog until approved again', async () => {
      const equipmentId = await createApprovedEquipment(actors);

      const response = await provider().patch(
        `/equipment/${equipmentId}`,
        wholeForm({ title: 'Gerador 50 kVA' }),
      );

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('PENDING_REVIEW');
      expect(response.body.message).toContain('volta à revisão');
      expect(await isInCatalog(equipmentId)).toBe(false);
      await publicGet(`/equipment/${equipmentId}`).expect(404);

      const pending = await admin().get('/equipment/admin/pending').expect(200);
      expect(
        (pending.body.data as Array<{ id: string }>).map(({ id }) => id),
      ).toContain(equipmentId);
      expect(await auditsOf(equipmentId)).toContainEqual({
        action: 'EQUIPMENT_SENT_TO_REVIEW',
        actorId: actors.provider.userId,
        metadata: {
          previousStatus: 'ACTIVE',
          changed: ['title'],
          title: 'Gerador 50 kVA',
        },
      });

      await admin().patch(`/equipment/${equipmentId}/approve`).expect(200);
      expect(await isInCatalog(equipmentId)).toBe(true);
    });

    it('stays public when an admin edits the title', async () => {
      const equipmentId = await createApprovedEquipment(actors);

      const response = await admin().patch(`/equipment/${equipmentId}`, {
        title: 'Betoneira 300 litros',
      });

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('ACTIVE');
    });

    it('lets the owner read a listing under review, and nobody else', async () => {
      const equipmentId = await createApprovedEquipment(actors);
      await provider()
        .patch(`/equipment/${equipmentId}`, { title: 'Gerador 50 kVA' })
        .expect(200);

      const mine = await provider().get(
        `/equipment/me/listings/${equipmentId}`,
      );
      const theirs = await client().get(
        `/equipment/me/listings/${equipmentId}`,
      );

      expect(mine.status).toBe(200);
      expect(mine.body.data).toMatchObject({
        id: equipmentId,
        status: 'PENDING_REVIEW',
        title: 'Gerador 50 kVA',
      });
      expect(theirs.status).toBe(403);
    });
  });

  describe('bookings of a listing that went back to review', () => {
    it('lets the provider confirm a booking made before the edit', async () => {
      const equipmentId = await createApprovedEquipment(actors);
      const bookingId = await createBooking(
        actors,
        equipmentId,
        STARTS_IN_DAYS,
      );
      await provider()
        .patch(`/equipment/${equipmentId}`, { title: 'Gerador 50 kVA' })
        .expect(200);

      await confirmBooking(actors, bookingId);

      const booking = await prisma().booking.findUniqueOrThrow({
        where: { id: bookingId },
      });
      expect(booking.status).toBe('CONFIRMED');
    });

    it('takes no new bookings while under review', async () => {
      const equipmentId = await createApprovedEquipment(actors);
      await provider()
        .patch(`/equipment/${equipmentId}`, { title: 'Gerador 50 kVA' })
        .expect(200);

      const response = await client().post('/bookings', {
        equipmentId,
        startDate: new Date(Date.now() + 5 * 86_400_000).toISOString(),
        endDate: new Date(Date.now() + 8 * 86_400_000).toISOString(),
      });

      expect(response.status).toBe(400);
      expect(await prisma().booking.count()).toBe(0);
    });

    it('refuses to confirm a booking once the listing was rejected', async () => {
      const equipmentId = await createApprovedEquipment(actors);
      const bookingId = await createBooking(
        actors,
        equipmentId,
        STARTS_IN_DAYS,
      );
      await admin()
        .patch(`/equipment/${equipmentId}/reject`, { reason: 'Anúncio falso.' })
        .expect(200);

      const response = await provider().patch(`/bookings/${bookingId}/confirm`);

      expect(response.status).toBe(400);
    });
  });

  describe('a rejected equipment listing', () => {
    async function createRejected(reason = 'Fotos insuficientes.') {
      const equipmentId = await createApprovedEquipment(actors);
      await admin()
        .patch(`/equipment/${equipmentId}/reject`, { reason })
        .expect(200);
      return equipmentId;
    }

    it('tells the owner why, in the list and in the detail', async () => {
      const equipmentId = await createRejected();

      const list = await provider().get('/equipment/me/listings').expect(200);
      const detail = await provider()
        .get(`/equipment/me/listings/${equipmentId}`)
        .expect(200);

      const listed = (
        list.body.data as Array<{ id: string; rejectionReason: string | null }>
      ).find((item) => item.id === equipmentId);
      expect(listed?.rejectionReason).toBe('Fotos insuficientes.');
      expect(detail.body.data).toMatchObject({
        status: 'REJECTED',
        rejectionReason: 'Fotos insuficientes.',
      });
      expect((await readEquipment(equipmentId)).rejectedAt).not.toBeNull();
    });

    it('asks for a new review as soon as the owner changes anything', async () => {
      const equipmentId = await createRejected();

      const response = await provider().patch(
        `/equipment/${equipmentId}`,
        wholeForm({ pricePerDay: 1200 }),
      );

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('PENDING_REVIEW');
      expect(response.body.message).toContain('enviado de novo para revisão');
    });

    it('stays rejected when the form is saved without any change', async () => {
      const equipmentId = await createRejected();

      await provider()
        .patch(`/equipment/${equipmentId}`, wholeForm())
        .expect(200);

      expect((await readEquipment(equipmentId)).status).toBe('REJECTED');
    });

    it('forgets the reason once it is approved', async () => {
      const equipmentId = await createRejected();
      await provider()
        .patch(`/equipment/${equipmentId}`, { pricePerDay: 1200 })
        .expect(200);

      await admin().patch(`/equipment/${equipmentId}/approve`).expect(200);

      const equipment = await readEquipment(equipmentId);
      expect(equipment.status).toBe('ACTIVE');
      expect(equipment.rejectionReason).toBeNull();
      expect(equipment.rejectedAt).toBeNull();
    });
  });

  describe('removing an equipment listing', () => {
    it('returns 400 while a booking is in progress, and works once it is over', async () => {
      const equipmentId = await createApprovedEquipment(actors);
      const bookingId = await createBooking(
        actors,
        equipmentId,
        STARTS_IN_DAYS,
      );

      const blocked = await provider().delete(`/equipment/${equipmentId}`);

      expect(blocked.status).toBe(400);
      expect(blocked.body.message).toContain('reservas em curso');
      expect((await readEquipment(equipmentId)).status).toBe('ACTIVE');

      await client().patch(`/bookings/${bookingId}/cancel`).expect(200);
      await provider().delete(`/equipment/${equipmentId}`).expect(200);
      expect((await readEquipment(equipmentId)).status).toBe('DELETED');
    });

    it('returns 404 for anything done to a removed listing', async () => {
      const equipmentId = await createApprovedEquipment(actors);
      await provider().delete(`/equipment/${equipmentId}`).expect(200);

      const edit = await provider().patch(
        `/equipment/${equipmentId}`,
        wholeForm(),
      );
      const again = await provider().delete(`/equipment/${equipmentId}`);
      const detail = await provider().get(
        `/equipment/me/listings/${equipmentId}`,
      );

      expect([edit.status, again.status, detail.status]).toEqual([
        404, 404, 404,
      ]);
    });
  });

  describe('the number of units', () => {
    it('cannot go below the units booked at the same time', async () => {
      const equipmentId = await createApprovedEquipment(actors, {
        quantity: 2,
      });
      await createBooking(actors, equipmentId, STARTS_IN_DAYS);
      await createBooking(actors, equipmentId, STARTS_IN_DAYS + 1);

      const response = await provider().patch(`/equipment/${equipmentId}`, {
        quantity: 1,
      });

      expect(response.status).toBe(400);
      expect(response.body.message).toBe(
        'Este equipamento tem reservas para 2 unidades ao mesmo tempo. A quantidade não pode ficar abaixo disso.',
      );
      expect((await readEquipment(equipmentId)).quantity).toBe(2);
    });

    it('can go up, and down to what the bookings need, without a review', async () => {
      const equipmentId = await createApprovedEquipment(actors, {
        quantity: 2,
      });
      await createBooking(actors, equipmentId, STARTS_IN_DAYS);

      const up = await provider().patch(`/equipment/${equipmentId}`, {
        quantity: 5,
      });
      const down = await provider().patch(`/equipment/${equipmentId}`, {
        quantity: 1,
      });

      expect(up.body.data).toMatchObject({ quantity: 5, status: 'ACTIVE' });
      expect(down.body.data).toMatchObject({ quantity: 1, status: 'ACTIVE' });
    });
  });

  describe('listings of a suspended account', () => {
    const suspendProvider = () =>
      admin()
        .patch(`/users/${actors.provider.userId}/suspend`, {
          reason: 'Queixas de clientes.',
        })
        .expect(200);

    it('leave the catalog and take no bookings, and come back with the account', async () => {
      const equipmentId = await createApprovedEquipment(actors);
      await suspendProvider();

      expect(await isInCatalog(equipmentId)).toBe(false);
      await publicGet(`/equipment/${equipmentId}`).expect(404);
      const booking = await client().post('/bookings', {
        equipmentId,
        startDate: new Date(Date.now() + 5 * 86_400_000).toISOString(),
        endDate: new Date(Date.now() + 8 * 86_400_000).toISOString(),
      });
      expect(booking.status).toBe(400);

      await admin()
        .patch(`/users/${actors.provider.userId}/reactivate`)
        .expect(200);
      expect(await isInCatalog(equipmentId)).toBe(true);
    });

    it('hide the services too, and refuse new requests', async () => {
      const { requestId } = await createServiceQuote(actors);
      const { serviceId } = await prisma().serviceRequest.findUniqueOrThrow({
        where: { id: requestId },
      });
      await suspendProvider();

      const list = await publicGet('/services').expect(200);
      const detail = await publicGet(`/services/${serviceId}`);
      const newRequest = await client().post('/service-requests', {
        serviceId,
        description: 'Preciso de outra reparação no quadro eléctrico.',
        address: 'Av. Eduardo Mondlane, 123, Maputo',
      });

      expect(list.body.data).toEqual([]);
      expect(detail.status).toBe(404);
      expect(newRequest.status).toBe(400);
    });
  });

  describe('public limits', () => {
    it.each([
      ['a page beyond the limit', '/equipment?page=1001'],
      ['a fractional page size', '/equipment?limit=2.5'],
      [
        'a search term longer than 100 characters',
        `/equipment?search=${'a'.repeat(101)}`,
      ],
      [
        'a service search longer than 100 characters',
        `/services?search=${'a'.repeat(101)}`,
      ],
    ])('returns 400 for %s', async (_label, path) => {
      const response = await publicGet(path);

      expect(response.status).toBe(400);
    });

    it('still answers the last page allowed', async () => {
      await publicGet('/equipment?page=1000&limit=100').expect(200);
    });

    it('gives the location of an equipment to the zone, and the exact one only to its owner', async () => {
      const created = await provider()
        .post('/equipment', {
          ...wholeForm(),
          latitude: -25.9653217,
          longitude: 32.5892461,
        })
        .expect(201);
      const equipmentId = created.body.data.id as string;
      await admin().patch(`/equipment/${equipmentId}/approve`).expect(200);

      const open = await publicGet(`/equipment/${equipmentId}`).expect(200);
      const mine = await provider()
        .get(`/equipment/me/listings/${equipmentId}`)
        .expect(200);

      expect(open.body.data).toMatchObject({
        latitude: -25.97,
        longitude: 32.59,
      });
      expect(mine.body.data).toMatchObject({
        latitude: -25.9653217,
        longitude: 32.5892461,
      });
    });
  });

  describe('publishing an equipment', () => {
    it('returns 400 for a service category and leaves the account a client', async () => {
      const response = await client().post(
        '/equipment',
        wholeForm({ categoryId: actors.seed.categories.electricidade.id }),
      );

      expect(response.status).toBe(400);
      expect(response.body.message).toBe(
        'Esta categoria é de serviços. Escolhe uma categoria de equipamentos.',
      );
      const account = await prisma().user.findUniqueOrThrow({
        where: { id: actors.client.userId },
      });
      expect(account.role).toBe('CLIENT');
      expect(await prisma().equipment.count()).toBe(0);
    });

    it.each([
      ['a price above the ceiling', { pricePerDay: 10_000_001 }],
      ['a deposit above the ceiling', { depositAmount: 100_000_001 }],
      ['a fractional number of units', { quantity: 1.5 }],
    ])('returns 400 for %s', async (_label, overrides) => {
      const response = await provider().post(
        '/equipment',
        wholeForm(overrides),
      );

      expect(response.status).toBe(400);
      expect(await prisma().equipment.count()).toBe(0);
    });
  });

  describe('admin and provider lists', () => {
    it('pages the listings waiting for review', async () => {
      await provider().post('/equipment', wholeForm()).expect(201);
      await provider().post('/equipment', wholeForm()).expect(201);

      const response = await admin()
        .get('/equipment/admin/pending?page=1&limit=1')
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.meta).toMatchObject({
        page: 1,
        limit: 1,
        total: 2,
        totalPages: 2,
        hasNextPage: true,
      });
    });

    it('counts as revenue only what was paid out to the provider', async () => {
      const { paymentId } = await createHeldBooking(actors, {
        startsInDays: STARTS_IN_DAYS,
      });

      const held = await provider().get('/equipment/me/analytics').expect(200);
      await releasePayment(actors, paymentId);
      const released = await provider()
        .get('/equipment/me/analytics')
        .expect(200);

      // Com o dinheiro ainda retido, o provider não recebeu nada.
      expect(held.body.data.revenue).toMatchObject({
        totalPayments: 0,
        totalPayout: 0,
      });
      expect(released.body.data.revenue).toMatchObject({
        totalPayments: 1,
        totalPayout: 4050,
      });
    });
  });

  describe('service listings', () => {
    /** Serviço aprovado, com um pedido do cliente e um orçamento por aceitar. */
    async function createQuotedService() {
      const quote = await createServiceQuote(actors);
      const { serviceId } = await prisma().serviceRequest.findUniqueOrThrow({
        where: { id: quote.requestId },
      });
      return { ...quote, serviceId };
    }

    const NEW_DESCRIPTION =
      'Reparações eléctricas e venda de material ao balcão, com entrega em casa.';

    it('goes back to review when the description changes, and stays public for a new price', async () => {
      const { serviceId } = await createQuotedService();

      const price = await provider().patch(`/services/${serviceId}`, {
        basePrice: 6000,
      });
      const description = await provider().patch(`/services/${serviceId}`, {
        description: NEW_DESCRIPTION,
      });

      expect(price.body.data.status).toBe('ACTIVE');
      expect(description.status).toBe(200);
      expect(description.body.data.status).toBe('PENDING_REVIEW');
      expect(await auditsOf(serviceId)).toContainEqual(
        expect.objectContaining({ action: 'SERVICE_SENT_TO_REVIEW' }),
      );
      await publicGet(`/services/${serviceId}`).expect(404);
    });

    it('lets the client accept a quote sent before the listing went back to review', async () => {
      const { serviceId, quoteId } = await createQuotedService();
      await provider()
        .patch(`/services/${serviceId}`, { description: NEW_DESCRIPTION })
        .expect(200);

      const booking = await acceptServiceQuote(actors, quoteId);

      expect(booking.serviceBookingId).toEqual(expect.any(String));
    });

    it('takes no new requests while under review', async () => {
      const { serviceId } = await createQuotedService();
      await provider()
        .patch(`/services/${serviceId}`, { description: NEW_DESCRIPTION })
        .expect(200);

      const response = await client().post('/service-requests', {
        serviceId,
        description: 'Preciso de outra reparação no quadro eléctrico.',
        address: 'Av. Eduardo Mondlane, 123, Maputo',
      });

      expect(response.status).toBe(400);
    });

    it('keeps the reason of a rejection, and asks for a new review after a change', async () => {
      const { serviceId } = await createQuotedService();
      await admin()
        .patch(`/services/${serviceId}/reject`, { reason: 'Descrição vaga.' })
        .expect(200);

      const mine = await provider()
        .get(`/services/me/listings/${serviceId}`)
        .expect(200);
      const edited = await provider().patch(`/services/${serviceId}`, {
        description: NEW_DESCRIPTION,
      });

      expect(mine.body.data).toMatchObject({
        status: 'REJECTED',
        rejectionReason: 'Descrição vaga.',
      });
      expect(edited.body.data.status).toBe('PENDING_REVIEW');
      expect(edited.body.message).toContain('enviado de novo para revisão');
    });

    it('returns 400 when removing a service with a booking in progress', async () => {
      const { serviceBookingId } = await createHeldServiceBooking(actors);
      const { serviceId } = await prisma().serviceBooking.findUniqueOrThrow({
        where: { id: serviceBookingId },
      });

      const response = await provider().delete(`/services/${serviceId}`);

      expect(response.status).toBe(400);
      expect(response.body.message).toContain('reservas em curso');
      expect((await readService(serviceId)).status).toBe('ACTIVE');
    });

    it('pages the services of the provider and leaves out the removed ones', async () => {
      const { serviceId } = await createQuotedService();
      await client().patch(
        `/service-requests/${(await prisma().serviceRequest.findFirstOrThrow()).id}/cancel`,
      );
      await provider().delete(`/services/${serviceId}`).expect(200);

      const response = await provider()
        .get('/services/me/listings')
        .expect(200);

      expect(response.body.data).toEqual([]);
      expect(response.body.meta).toMatchObject({ page: 1, total: 0 });
    });

    it('returns 403 when someone else reads the owner detail', async () => {
      const { serviceId } = await createQuotedService();
      const outsider = await loginAsOutsider(app);

      const response = await as(outsider.accessToken).get(
        `/services/me/listings/${serviceId}`,
      );

      expect(response.status).toBe(403);
    });
  });
});
