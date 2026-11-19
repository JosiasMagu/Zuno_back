import { randomUUID } from 'crypto';
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
  openPaymentDispute,
  resetBookingFlow,
} from './helpers/booking-flow';
import { disconnectTestPrisma, getTestPrisma } from './helpers/db';
import { expectMoneyReconciles } from './helpers/reconciliation';

/** Meio-dia de um dia daqui a `days` dias, para não depender do fuso. */
function noonInDays(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(12, 0, 0, 0);
  return date.toISOString();
}

describe('Booking creation E2E', () => {
  let app: INestApplication;
  let actors: BookingFlowActors;
  const prisma = () => getTestPrisma();

  beforeAll(async () => {
    app = await createTestApp();
  }, 30000);

  beforeEach(async () => {
    actors = await resetBookingFlow(app);
  });

  // No fim de cada teste, o dinheiro tem de bater certo.
  afterEach(() => expectMoneyReconciles(app));

  afterAll(async () => {
    await app.close();
    await disconnectTestPrisma();
  });

  function bookAs(token: string, body: Record<string, unknown>) {
    return request(actors.httpServer)
      .post('/api/v1/bookings')
      .set(authHeader(token))
      .set('Idempotency-Key', randomUUID())
      .send(body);
  }

  /** O cliente pede o equipamento do dia `from` ao dia `to`, contados de hoje. */
  function book(equipmentId: string, from: number, to: number) {
    return bookAs(actors.client.accessToken, {
      equipmentId,
      startDate: noonInDays(from),
      endDate: noonInDays(to),
    });
  }

  it('creates a pending booking priced by the server', async () => {
    const equipmentId = await createApprovedEquipment(actors);

    const response = await bookAs(actors.client.accessToken, {
      equipmentId,
      startDate: noonInDays(5),
      endDate: noonInDays(8),
      deliveryAddress: '  Av. 24 de Julho, 500  ',
      clientNote: '  Entregar de manhã.  ',
    });

    expect(response.status).toBe(201);
    expect(response.body.data.status).toBe('PENDING');

    const booking = await prisma().booking.findUniqueOrThrow({
      where: { id: response.body.data.id as string },
    });
    expect(booking).toMatchObject({
      clientId: actors.client.userId,
      ownerId: actors.provider.userId,
      equipmentId,
      totalDays: 3,
      status: 'PENDING',
      deliveryAddress: 'Av. 24 de Julho, 500',
      clientNote: 'Entregar de manhã.',
    });
    expect(Number(booking.rentalAmount)).toBe(4500);
    expect(Number(booking.platformFee)).toBe(450);
    expect(Number(booking.depositAmount)).toBe(5000);
    expect(Number(booking.totalAmount)).toBe(9950);
  });

  it('stores no address or note when none is sent', async () => {
    const equipmentId = await createApprovedEquipment(actors);

    const response = await book(equipmentId, 5, 8);

    expect(response.status).toBe(201);
    const booking = await prisma().booking.findUniqueOrThrow({
      where: { id: response.body.data.id as string },
    });
    expect(booking.deliveryAddress).toBeNull();
    expect(booking.clientNote).toBeNull();
  });

  describe('availability', () => {
    it('refuses dates that overlap a booking for the only unit', async () => {
      const equipmentId = await createApprovedEquipment(actors);
      await book(equipmentId, 5, 8).expect(201);

      const response = await book(equipmentId, 7, 10);

      expect(response.status).toBe(400);
      expect(await prisma().booking.count()).toBe(1);
    });

    it('accepts a booking that starts the day the other one ends', async () => {
      const equipmentId = await createApprovedEquipment(actors);
      await book(equipmentId, 5, 8).expect(201);

      const response = await book(equipmentId, 8, 10);

      expect(response.status).toBe(201);
    });

    it('accepts overlapping bookings up to the number of units', async () => {
      const equipmentId = await createApprovedEquipment(actors, {
        quantity: 2,
      });
      await book(equipmentId, 5, 8).expect(201);

      const second = await book(equipmentId, 6, 9);
      const third = await book(equipmentId, 7, 10);

      expect(second.status).toBe(201);
      expect(third.status).toBe(400);
    });

    it('accepts other dates while the only unit is confirmed elsewhere', async () => {
      const equipmentId = await createApprovedEquipment(actors);
      const bookingId = await createBooking(actors, equipmentId, 5);
      await confirmBooking(actors, bookingId);

      const response = await book(equipmentId, 20, 23);

      expect(response.status).toBe(201);
    });

    it('refuses the dates of a confirmed booking', async () => {
      const equipmentId = await createApprovedEquipment(actors);
      const bookingId = await createBooking(actors, equipmentId, 5);
      await confirmBooking(actors, bookingId);

      const response = await book(equipmentId, 6, 9);

      expect(response.status).toBe(400);
    });

    it('refuses the dates of a booking that is in dispute', async () => {
      const { equipmentId, bookingId, paymentId } = await createHeldBooking(
        actors,
        { startsInDays: 5 },
      );
      await openPaymentDispute(actors, { bookingId, paymentId });

      const response = await book(equipmentId, 5, 8);

      expect(response.status).toBe(400);
    });

    it('refuses equipment that the provider has paused', async () => {
      const equipmentId = await createApprovedEquipment(actors);
      await prisma().equipment.update({
        where: { id: equipmentId },
        data: { isAvailable: false },
      });

      const response = await book(equipmentId, 5, 8);

      expect(response.status).toBe(400);
      expect(await prisma().booking.count()).toBe(0);
    });
  });

  describe('the day of the booking', () => {
    const HOUR_MS = 60 * 60 * 1000;
    const DAY_MS = 24 * HOUR_MS;
    const MAPUTO_OFFSET_MS = 2 * HOUR_MS;

    it('is counted in Mozambique time, whatever the clock of the server', async () => {
      const equipmentId = await createApprovedEquipment(actors);
      // A meia-noite de Maputo de um dia daqui a dez dias. Em UTC são as
      // 22:00 da véspera, e era na véspera que a reserva ficava num servidor
      // em UTC.
      const maputoMidnight =
        Math.floor((Date.now() + 10 * DAY_MS + MAPUTO_OFFSET_MS) / DAY_MS) *
          DAY_MS -
        MAPUTO_OFFSET_MS;
      const halfPastMidnight = new Date(maputoMidnight + HOUR_MS / 2);

      const response = await bookAs(actors.client.accessToken, {
        equipmentId,
        startDate: halfPastMidnight.toISOString(),
        endDate: new Date(
          halfPastMidnight.getTime() + 3 * DAY_MS,
        ).toISOString(),
      });

      expect(response.status).toBe(201);
      const booking = await prisma().booking.findUniqueOrThrow({
        where: { id: response.body.data.id as string },
      });
      expect(booking.startDate).toEqual(new Date(maputoMidnight));
      expect(booking.endDate).toEqual(new Date(maputoMidnight + 3 * DAY_MS));
      expect(booking.totalDays).toBe(3);
    });
  });

  describe('two requests at the same time', () => {
    const period = () => ({ startDate: noonInDays(5), endDate: noonInDays(8) });

    it('give the only unit to one client and refuse the other', async () => {
      const equipmentId = await createApprovedEquipment(actors);
      const other = await loginAsOutsider(app);

      const [first, second] = await Promise.all([
        bookAs(actors.client.accessToken, { equipmentId, ...period() }),
        bookAs(other.accessToken, { equipmentId, ...period() }),
      ]);

      expect([first.status, second.status].sort()).toEqual([201, 400]);
      expect(await prisma().booking.count({ where: { equipmentId } })).toBe(1);
    });

    it('never hand out more units than the equipment has', async () => {
      const equipmentId = await createApprovedEquipment(actors, {
        quantity: 2,
      });
      const other = await loginAsOutsider(app);

      const responses = await Promise.all([
        bookAs(actors.client.accessToken, { equipmentId, ...period() }),
        bookAs(other.accessToken, { equipmentId, ...period() }),
        bookAs(actors.client.accessToken, { equipmentId, ...period() }),
      ]);

      const created = responses.filter(({ status }) => status === 201).length;
      // Quem perde a corrida pode ser recusado mesmo havendo unidade, e volta
      // a tentar. O que nunca pode acontecer é saírem três reservas.
      expect(created).toBeGreaterThanOrEqual(1);
      expect(created).toBeLessThanOrEqual(2);
      expect(responses.map(({ status }) => status).sort()).not.toContain(500);
      expect(await prisma().booking.count({ where: { equipmentId } })).toBe(
        created,
      );
    });
  });

  describe('refusals', () => {
    it('returns 400 for equipment that is not approved yet', async () => {
      const created = await request(actors.httpServer)
        .post('/api/v1/equipment')
        .set(authHeader(actors.provider.accessToken))
        .send({
          title: 'Gerador E2E',
          description:
            'Gerador a gasolina de 5 kVA para testes E2E, em bom estado de conservacao.',
          categoryId: actors.seed.categories.construcao.id,
          pricePerDay: 1000,
          depositAmount: 0,
          location: 'Maputo, Cidade',
          condition: 'GOOD',
        })
        .expect(201);

      const response = await book(created.body.data.id as string, 5, 8);

      expect(response.status).toBe(400);
    });

    it('returns 400 to the owner of the equipment', async () => {
      const equipmentId = await createApprovedEquipment(actors);

      const response = await bookAs(actors.provider.accessToken, {
        equipmentId,
        startDate: noonInDays(5),
        endDate: noonInDays(8),
      });

      expect(response.status).toBe(400);
    });

    it('returns 400 when the start date is in the past', async () => {
      const equipmentId = await createApprovedEquipment(actors);

      const response = await book(equipmentId, -2, 3);

      expect(response.status).toBe(400);
    });

    it('returns 400 when the booking ends the day it starts', async () => {
      const equipmentId = await createApprovedEquipment(actors);

      const response = await book(equipmentId, 5, 5);

      expect(response.status).toBe(400);
    });

    it('returns 400 for a date that is not a date', async () => {
      const equipmentId = await createApprovedEquipment(actors);

      const response = await bookAs(actors.client.accessToken, {
        equipmentId,
        startDate: 'amanhã',
        endDate: noonInDays(8),
      });

      expect(response.status).toBe(400);
    });

    it('returns 404 for unknown equipment', async () => {
      const response = await book(randomUUID(), 5, 8);

      expect(response.status).toBe(404);
    });
  });
});
