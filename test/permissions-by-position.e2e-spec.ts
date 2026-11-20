import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createTestApp } from './helpers/app';
import { authHeader, loginAsOutsider, loginViaApi } from './helpers/auth';
import {
  assertStatus,
  BookingFlowActors,
  createApprovedEquipment,
  createBooking,
  paymentReceipt,
  resetBookingFlow,
} from './helpers/booking-flow';
import { disconnectTestPrisma, getTestPrisma } from './helpers/db';
import { expectMoneyReconciles } from './helpers/reconciliation';

const NEW_ACCOUNT = {
  name: 'Canalizador Novo',
  phone: '+258841112233',
  password: 'mangueira-verde',
};

// O papel da conta (CLIENT, PROVIDER) só diz à app que área mostrar. O que
// cada pessoa pode fazer decide-se pela posição que tem em cada transacção.
describe('Permissions by position E2E', () => {
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

  const roleOf = async (userId: string) =>
    (await prisma().user.findUniqueOrThrow({ where: { id: userId } })).role;

  describe('an account that only publishes services', () => {
    /** Uma conta acabada de registar publica um serviço e o admin aprova-o. */
    async function publishServiceFromNewAccount() {
      await request(actors.httpServer)
        .post('/api/v1/auth/register')
        .send(NEW_ACCOUNT)
        .expect(201);
      const account = await loginViaApi(
        app,
        NEW_ACCOUNT.phone,
        NEW_ACCOUNT.password,
      );

      const service = await request(actors.httpServer)
        .post('/api/v1/services')
        .set(authHeader(account.accessToken))
        .send({
          title: 'Canalização residencial',
          description:
            'Reparação de fugas, torneiras e autoclismos em casas e apartamentos.',
          categoryId: actors.seed.categories.electricidade.id,
          basePrice: 2000,
          pricingType: 'FIXED',
          location: 'Matola',
        });
      assertStatus('criar serviço', service, 201);
      const serviceId = service.body.data.id as string;

      const approved = await request(actors.httpServer)
        .patch(`/api/v1/services/${serviceId}/approve`)
        .set(authHeader(actors.admin.accessToken))
        .send({});
      assertStatus('aprovar serviço', approved, 200);

      return { account, serviceId };
    }

    async function requestService(serviceId: string) {
      const response = await request(actors.httpServer)
        .post('/api/v1/service-requests')
        .set(authHeader(actors.client.accessToken))
        .send({
          serviceId,
          description: 'A torneira da cozinha pinga desde ontem.',
          address: 'Av. Eduardo Mondlane, 123, Maputo',
        });
      assertStatus('criar pedido de serviço', response, 201);

      return response.body.data.id as string;
    }

    function quoteAs(token: string, requestId: string) {
      return request(actors.httpServer)
        .post(`/api/v1/service-requests/${requestId}/quotes`)
        .set(authHeader(token))
        .send({ amount: 2000, totalAmount: 2000, estimatedDays: 1 });
    }

    it('becomes a provider when it publishes', async () => {
      const { account } = await publishServiceFromNewAccount();

      expect(await roleOf(account.userId)).toBe('PROVIDER');
    });

    it('can quote the requests for its own service', async () => {
      const { account, serviceId } = await publishServiceFromNewAccount();
      const requestId = await requestService(serviceId);

      const response = await quoteAs(account.accessToken, requestId);

      expect(response.status).toBe(201);
    });

    it('can quote even if the account is still marked as a client', async () => {
      const { account, serviceId } = await publishServiceFromNewAccount();
      await prisma().user.update({
        where: { id: account.userId },
        data: { role: 'CLIENT' },
      });
      const requestId = await requestService(serviceId);

      const response = await quoteAs(account.accessToken, requestId);

      expect(response.status).toBe(201);
    });

    it('cannot quote the requests for the service of someone else', async () => {
      const { serviceId } = await publishServiceFromNewAccount();
      const requestId = await requestService(serviceId);

      const response = await quoteAs(actors.provider.accessToken, requestId);

      expect(response.status).toBe(403);
    });
  });

  describe('a provider who rents from another provider', () => {
    /** Um provider aluga o equipamento de outro e o pagamento fica retido. */
    async function rentAsProvider() {
      const renter = await loginAsOutsider(app, 'PROVIDER');
      const equipmentId = await createApprovedEquipment(actors);
      const day = 24 * 60 * 60 * 1000;

      const booking = await request(actors.httpServer)
        .post('/api/v1/bookings')
        .set(authHeader(renter.accessToken))
        .set('Idempotency-Key', randomUUID())
        .send({
          equipmentId,
          startDate: new Date(Date.now() + 5 * day).toISOString(),
          endDate: new Date(Date.now() + 8 * day).toISOString(),
        });
      assertStatus('criar reserva', booking, 201);
      const bookingId = booking.body.data.id as string;

      const confirmed = await request(actors.httpServer)
        .patch(`/api/v1/bookings/${bookingId}/confirm`)
        .set(authHeader(actors.provider.accessToken))
        .send({});
      assertStatus('confirmar reserva', confirmed, 200);

      const initiated = await request(actors.httpServer)
        .post(`/api/v1/payments/booking/${bookingId}/initiate`)
        .set(authHeader(renter.accessToken))
        .send({ method: 'MPESA' });
      assertStatus('iniciar pagamento', initiated, 201);
      const paymentId = initiated.body.data.id as string;

      const held = await request(actors.httpServer)
        .patch(`/api/v1/payments/${paymentId}/mark-held`)
        .set(authHeader(actors.admin.accessToken))
        .send(await paymentReceipt(paymentId));
      assertStatus('marcar pagamento como retido', held, 200);

      return { renter, bookingId, paymentId };
    }

    function releaseAs(token: string, paymentId: string) {
      return request(actors.httpServer)
        .patch(`/api/v1/payments/${paymentId}/release`)
        .set(authHeader(token))
        .send({});
    }

    it('can confirm the delivery of what it rented', async () => {
      const { renter, bookingId, paymentId } = await rentAsProvider();

      const response = await releaseAs(renter.accessToken, paymentId);

      expect(response.status).toBe(200);
      const booking = await prisma().booking.findUniqueOrThrow({
        where: { id: bookingId },
      });
      expect(booking.status).toBe('ACTIVE');
    });

    it('the provider who gets paid still cannot release the payment', async () => {
      const { paymentId } = await rentAsProvider();

      const response = await releaseAs(actors.provider.accessToken, paymentId);

      expect(response.status).toBe(403);
      const payment = await prisma().payment.findUniqueOrThrow({
        where: { id: paymentId },
      });
      expect(payment.status).toBe('HELD');
    });
  });

  describe('an account with nothing published', () => {
    // A app pede as reservas recebidas a todas as contas, para o contador do
    // separador de pedidos.
    it('gets an empty list of received bookings, and never the bookings of someone else', async () => {
      const equipmentId = await createApprovedEquipment(actors);
      await createBooking(actors, equipmentId, 5);
      const receivedBy = (token: string) =>
        request(actors.httpServer)
          .get('/api/v1/bookings/owner')
          .set(authHeader(token));

      const asClient = await receivedBy(actors.client.accessToken);
      const asOwner = await receivedBy(actors.provider.accessToken);

      expect(asClient.status).toBe(200);
      expect(asClient.body.data).toEqual([]);
      expect(asOwner.body.data).toHaveLength(1);
    });
  });
});
