import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createTestApp } from './helpers/app';
import { authHeader } from './helpers/auth';
import {
  BookingFlowActors,
  confirmBooking,
  createApprovedEquipment,
  createBooking,
  createHeldBooking,
  releasePayment,
  resetBookingFlow,
} from './helpers/booking-flow';
import { disconnectTestPrisma, getTestPrisma } from './helpers/db';
import { expectMoneyReconciles } from './helpers/reconciliation';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Meio-dia de um dia daqui a `days` dias, para não depender do fuso. */
function noonInDays(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(12, 0, 0, 0);
  return date.toISOString();
}

describe('Equipment availability E2E', () => {
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

  /** As unidades livres hoje, como a página do equipamento as mostra. */
  async function freeUnitsToday(equipmentId: string): Promise<number> {
    const response = await request(actors.httpServer)
      .get(`/api/v1/equipment/${equipmentId}`)
      .expect(200);

    return response.body.data.availableQuantity as number;
  }

  /** Os ids que o catálogo devolve com os filtros dados. */
  async function listCatalog(query: Record<string, unknown>) {
    const response = await request(actors.httpServer)
      .get('/api/v1/equipment')
      .query(query)
      .expect(200);

    return (response.body.data as Array<{ id: string }>).map(({ id }) => id);
  }

  function book(equipmentId: string, from: number, to: number) {
    return request(actors.httpServer)
      .post('/api/v1/bookings')
      .set(authHeader(actors.client.accessToken))
      .set('Idempotency-Key', randomUUID())
      .send({
        equipmentId,
        startDate: noonInDays(from),
        endDate: noonInDays(to),
      });
  }

  /** Um aluguer entregue ao cliente, com as datas mudadas para onde o teste precisa. */
  async function createDeliveredRental(period: {
    startedDaysAgo: number;
    endsInDays: number;
  }) {
    const rental = await createHeldBooking(actors, { startsInDays: 1 });
    await releasePayment(actors, rental.paymentId);
    await prisma().booking.update({
      where: { id: rental.bookingId },
      data: {
        startDate: new Date(Date.now() - period.startedDaysAgo * DAY_MS),
        endDate: new Date(Date.now() + period.endsInDays * DAY_MS),
      },
    });

    return rental;
  }

  describe('units free today', () => {
    it('are all of them while nothing is booked', async () => {
      const equipmentId = await createApprovedEquipment(actors, {
        quantity: 3,
      });

      expect(await freeUnitsToday(equipmentId)).toBe(3);
    });

    it('do not count a booking confirmed for future dates', async () => {
      const equipmentId = await createApprovedEquipment(actors);
      const bookingId = await createBooking(actors, equipmentId, 5);
      await confirmBooking(actors, bookingId);

      expect(await freeUnitsToday(equipmentId)).toBe(1);
    });

    it('count the unit that is out with a client today', async () => {
      const { equipmentId } = await createDeliveredRental({
        startedDaysAgo: 1,
        endsInDays: 2,
      });

      expect(await freeUnitsToday(equipmentId)).toBe(0);
    });

    it('are the same in the catalog and in the listings of the provider', async () => {
      const { equipmentId } = await createDeliveredRental({
        startedDaysAgo: 1,
        endsInDays: 2,
      });

      const catalog = await request(actors.httpServer)
        .get('/api/v1/equipment')
        .expect(200);
      const listings = await request(actors.httpServer)
        .get('/api/v1/equipment/me/listings')
        .set(authHeader(actors.provider.accessToken))
        .expect(200);

      const inCatalog = (
        catalog.body.data as Array<{ id: string; availableQuantity: number }>
      ).find(({ id }) => id === equipmentId);
      const inListings = (
        listings.body.data as Array<{ id: string; availableQuantity: number }>
      ).find(({ id }) => id === equipmentId);
      expect(inCatalog?.availableQuantity).toBe(0);
      expect(inListings?.availableQuantity).toBe(0);
    });
  });

  describe('a unit that was not returned', () => {
    it('stays out today, after the end date has passed', async () => {
      const { equipmentId } = await createDeliveredRental({
        startedDaysAgo: 4,
        endsInDays: -1,
      });

      expect(await freeUnitsToday(equipmentId)).toBe(0);
      await book(equipmentId, 0, 2).expect(400);
    });

    it('does not block a booking that starts tomorrow', async () => {
      const { equipmentId } = await createDeliveredRental({
        startedDaysAgo: 4,
        endsInDays: -1,
      });

      await book(equipmentId, 1, 3).expect(201);
    });
  });

  describe('catalog filters', () => {
    it('lists equipment for a period while one of its units is free', async () => {
      const equipmentId = await createApprovedEquipment(actors, {
        quantity: 2,
      });
      await book(equipmentId, 5, 8).expect(201);
      const period = {
        availableFrom: noonInDays(5),
        availableTo: noonInDays(8),
      };

      expect(await listCatalog(period)).toContain(equipmentId);

      await book(equipmentId, 5, 8).expect(201);

      expect(await listCatalog(period)).not.toContain(equipmentId);
    });

    it('lists the equipment for the dates around a booking', async () => {
      const equipmentId = await createApprovedEquipment(actors);
      await book(equipmentId, 5, 8).expect(201);

      const before = await listCatalog({
        availableFrom: noonInDays(2),
        availableTo: noonInDays(5),
      });
      const after = await listCatalog({
        availableFrom: noonInDays(8),
        availableTo: noonInDays(10),
      });

      expect(before).toContain(equipmentId);
      expect(after).toContain(equipmentId);
    });

    it('leaves out of "available now" the equipment with every unit out today', async () => {
      const { equipmentId } = await createDeliveredRental({
        startedDaysAgo: 1,
        endsInDays: 2,
      });

      expect(await listCatalog({ onlyAvailableNow: true })).not.toContain(
        equipmentId,
      );
      expect(await listCatalog({})).toContain(equipmentId);
    });

    it('leaves out of "available now" the equipment the provider paused', async () => {
      const equipmentId = await createApprovedEquipment(actors);
      await prisma().equipment.update({
        where: { id: equipmentId },
        data: { isAvailable: false },
      });

      expect(await listCatalog({ onlyAvailableNow: true })).not.toContain(
        equipmentId,
      );
    });

    it('keeps in "available now" the equipment booked only for future dates', async () => {
      const equipmentId = await createApprovedEquipment(actors);
      const bookingId = await createBooking(actors, equipmentId, 5);
      await confirmBooking(actors, bookingId);

      expect(await listCatalog({ onlyAvailableNow: true })).toContain(
        equipmentId,
      );
    });
  });
});
