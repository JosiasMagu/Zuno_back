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
  isListedAsFree,
  releasePayment,
  resetBookingFlow,
} from './helpers/booking-flow';
import { disconnectTestPrisma, getTestPrisma } from './helpers/db';
import { readOutflows, readPayouts } from './helpers/escrow-state';
import { expectMoneyReconciles } from './helpers/reconciliation';

// Aluguer de 3 dias a 1500 MZN por dia, com 5000 de depósito. No release o
// provider recebe 4050 e a plataforma 900; o depósito fica retido.
const DEPOSIT = 5000;
const RELEASE_OUTFLOWS = ['PLATFORM:900', 'PROVIDER:4050'];
const RELEASE_PAYOUT = 'PROVIDER_PAYOUT:4050:PENDING';

const STARTS_IN_DAYS = 5;

describe('Booking confirmation and return E2E', () => {
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

  function readBooking(bookingId: string) {
    return prisma().booking.findUniqueOrThrow({ where: { id: bookingId } });
  }

  function readEquipment(equipmentId: string) {
    return prisma().equipment.findUniqueOrThrow({
      where: { id: equipmentId },
      select: { isAvailable: true },
    });
  }

  describe('confirm', () => {
    function confirmAs(token: string, bookingId: string) {
      return request(actors.httpServer)
        .patch(`/api/v1/bookings/${bookingId}/confirm`)
        .set(authHeader(token))
        .send({});
    }

    async function createPendingBooking(quantity = 1) {
      const equipmentId = await createApprovedEquipment(actors, { quantity });
      const bookingId = await createBooking(
        actors,
        equipmentId,
        STARTS_IN_DAYS,
      );

      return { equipmentId, bookingId };
    }

    it('confirms a pending booking without pausing the equipment', async () => {
      const { equipmentId, bookingId } = await createPendingBooking();

      const response = await confirmAs(actors.provider.accessToken, bookingId);

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('CONFIRMED');

      const booking = await readBooking(bookingId);
      expect(booking.status).toBe('CONFIRMED');
      expect(booking.confirmedAt).not.toBeNull();
      expect((await readEquipment(equipmentId)).isAvailable).toBe(true);
      expect(await isListedAsFree(actors, equipmentId, STARTS_IN_DAYS)).toBe(
        false,
      );
    });

    it('keeps the dates listed as free while a unit remains', async () => {
      const { equipmentId, bookingId } = await createPendingBooking(2);

      const response = await confirmAs(actors.provider.accessToken, bookingId);

      expect(response.status).toBe(200);
      expect(await isListedAsFree(actors, equipmentId, STARTS_IN_DAYS)).toBe(
        true,
      );
    });

    it('lets an admin confirm on behalf of the provider', async () => {
      const { bookingId } = await createPendingBooking();

      const response = await confirmAs(actors.admin.accessToken, bookingId);

      expect(response.status).toBe(200);
      expect((await readBooking(bookingId)).status).toBe('CONFIRMED');
    });

    it('returns 403 to the client', async () => {
      const { bookingId } = await createPendingBooking();

      const response = await confirmAs(actors.client.accessToken, bookingId);

      expect(response.status).toBe(403);
      expect((await readBooking(bookingId)).status).toBe('PENDING');
    });

    it('returns 403 to a provider who does not own the equipment', async () => {
      const { bookingId } = await createPendingBooking();
      const outsider = await loginAsOutsider(app, 'PROVIDER');

      const response = await confirmAs(outsider.accessToken, bookingId);

      expect(response.status).toBe(403);
    });

    it('returns 400 when the booking is already confirmed', async () => {
      const { bookingId } = await createPendingBooking();
      await confirmBooking(actors, bookingId);

      const response = await confirmAs(actors.provider.accessToken, bookingId);

      expect(response.status).toBe(400);
    });

    it('returns 400 when the equipment is no longer active', async () => {
      const { equipmentId, bookingId } = await createPendingBooking();
      await prisma().equipment.update({
        where: { id: equipmentId },
        data: { status: 'PAUSED' },
      });

      const response = await confirmAs(actors.provider.accessToken, bookingId);

      expect(response.status).toBe(400);
      expect((await readBooking(bookingId)).status).toBe('PENDING');
    });

    it('confirms a booking for other dates while the only unit is out', async () => {
      const { equipmentId, bookingId } = await createPendingBooking();
      const laterBookingId = await createBooking(
        actors,
        equipmentId,
        STARTS_IN_DAYS + 10,
      );
      await confirmBooking(actors, bookingId);

      const response = await confirmAs(
        actors.provider.accessToken,
        laterBookingId,
      );

      expect(response.status).toBe(200);
      expect((await readBooking(laterBookingId)).status).toBe('CONFIRMED');
    });

    it('returns 400 when the only unit is already confirmed for the same dates', async () => {
      const { bookingId } = await createPendingBooking();
      // A API não deixa pedir duas vezes as mesmas datas da única unidade.
      // Esta segunda reserva entra directamente na base, como dados antigos.
      const original = await readBooking(bookingId);
      const duplicate = await prisma().booking.create({
        data: {
          clientId: original.clientId,
          equipmentId: original.equipmentId,
          ownerId: original.ownerId,
          startDate: original.startDate,
          endDate: original.endDate,
          totalDays: original.totalDays,
          rentalAmount: original.rentalAmount,
          depositAmount: original.depositAmount,
          platformFee: original.platformFee,
          totalAmount: original.totalAmount,
        },
      });
      await confirmBooking(actors, bookingId);

      const response = await confirmAs(
        actors.provider.accessToken,
        duplicate.id,
      );

      expect(response.status).toBe(400);
      expect((await readBooking(duplicate.id)).status).toBe('PENDING');
    });

    it('returns 404 for an unknown booking', async () => {
      const response = await confirmAs(
        actors.provider.accessToken,
        randomUUID(),
      );

      expect(response.status).toBe(404);
    });
  });

  describe('confirm-return', () => {
    function confirmReturnAs(
      token: string,
      bookingId: string,
      route: 'confirm-return' | 'complete' = 'confirm-return',
    ) {
      return request(actors.httpServer)
        .patch(`/api/v1/bookings/${bookingId}/${route}`)
        .set(authHeader(token))
        .send({});
    }

    /** Reserva ACTIVE: o cliente já confirmou a entrega. */
    async function createActiveBooking(depositAmount?: number) {
      const held = await createHeldBooking(actors, {
        startsInDays: STARTS_IN_DAYS,
        depositAmount,
      });
      await releasePayment(actors, held.paymentId);

      return held;
    }

    async function readReturnAudit(bookingId: string) {
      const audits = await prisma().auditLog.findMany({
        where: { targetId: bookingId, action: 'BOOKING_RETURN_CONFIRMED' },
        select: { metadata: true },
      });
      return audits.map((a) => a.metadata);
    }

    it('completes the booking, frees the dates and returns the deposit', async () => {
      const { equipmentId, bookingId, paymentId } = await createActiveBooking();

      const response = await confirmReturnAs(
        actors.provider.accessToken,
        bookingId,
      );

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('COMPLETED');

      const booking = await readBooking(bookingId);
      expect(booking.status).toBe('COMPLETED');
      expect(booking.returnConfirmedAt).not.toBeNull();
      expect(await isListedAsFree(actors, equipmentId, STARTS_IN_DAYS)).toBe(
        true,
      );

      const payment = await prisma().payment.findUniqueOrThrow({
        where: { id: paymentId },
      });
      expect(payment.status).toBe('RELEASED');
      expect(payment.depositStatus).toBe('RETURNED');
      expect(payment.depositReleasedAt).not.toBeNull();

      expect(await readOutflows(paymentId)).toEqual(
        [`CLIENT:${DEPOSIT}`, ...RELEASE_OUTFLOWS].sort(),
      );
      expect(await readPayouts(paymentId)).toEqual(
        [`DEPOSIT_RETURN:${DEPOSIT}:PENDING`, RELEASE_PAYOUT].sort(),
      );
      expect(await readReturnAudit(bookingId)).toEqual([
        { depositReturned: true },
      ]);
    });

    it('moves no money when the booking had no deposit', async () => {
      const { bookingId, paymentId } = await createActiveBooking(0);

      const response = await confirmReturnAs(
        actors.provider.accessToken,
        bookingId,
      );

      expect(response.status).toBe(200);
      expect((await readBooking(bookingId)).status).toBe('COMPLETED');
      expect(await readOutflows(paymentId)).toEqual(RELEASE_OUTFLOWS);
      expect(await readPayouts(paymentId)).toEqual([RELEASE_PAYOUT]);
      expect(await readReturnAudit(bookingId)).toEqual([
        { depositReturned: false },
      ]);
    });

    it('does the same through the /complete route', async () => {
      const { bookingId, paymentId } = await createActiveBooking();

      const response = await confirmReturnAs(
        actors.provider.accessToken,
        bookingId,
        'complete',
      );

      expect(response.status).toBe(200);
      expect((await readBooking(bookingId)).status).toBe('COMPLETED');
      expect(await readPayouts(paymentId)).toContain(
        `DEPOSIT_RETURN:${DEPOSIT}:PENDING`,
      );
    });

    it('lets an admin confirm the return', async () => {
      const { bookingId } = await createActiveBooking();

      const response = await confirmReturnAs(
        actors.admin.accessToken,
        bookingId,
      );

      expect(response.status).toBe(200);
      expect((await readBooking(bookingId)).status).toBe('COMPLETED');
    });

    it('returns 403 to the client', async () => {
      const { bookingId } = await createActiveBooking();

      const response = await confirmReturnAs(
        actors.client.accessToken,
        bookingId,
      );

      expect(response.status).toBe(403);
      expect((await readBooking(bookingId)).status).toBe('ACTIVE');
    });

    it('returns 403 to a provider who does not own the equipment', async () => {
      const { bookingId } = await createActiveBooking();
      const outsider = await loginAsOutsider(app, 'PROVIDER');

      const response = await confirmReturnAs(outsider.accessToken, bookingId);

      expect(response.status).toBe(403);
    });

    it('returns 400 before the client has confirmed the delivery', async () => {
      const { bookingId } = await createHeldBooking(actors, {
        startsInDays: STARTS_IN_DAYS,
      });

      const response = await confirmReturnAs(
        actors.provider.accessToken,
        bookingId,
      );

      expect(response.status).toBe(400);
      expect((await readBooking(bookingId)).status).toBe('CONFIRMED');
    });

    it('returns 400 on a second confirmation and returns the deposit only once', async () => {
      const { bookingId, paymentId } = await createActiveBooking();
      await confirmReturnAs(actors.provider.accessToken, bookingId).expect(200);

      const response = await confirmReturnAs(
        actors.provider.accessToken,
        bookingId,
      );

      expect(response.status).toBe(400);
      expect(await readPayouts(paymentId)).toHaveLength(2);
    });

    it('returns 404 for an unknown booking', async () => {
      const response = await confirmReturnAs(
        actors.provider.accessToken,
        randomUUID(),
      );

      expect(response.status).toBe(404);
    });
  });
});
