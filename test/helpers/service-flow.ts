import request from 'supertest';

import { authHeader } from './auth';
import {
  assertStatus,
  BookingFlowActors,
  paymentReceipt,
} from './booking-flow';

export const SERVICE_AMOUNT = 5000;

// O serviço de teste cobra mais 30% nos pedidos urgentes.
const URGENT_SURCHARGE_PERCENT = 30;
export const URGENT_SURCHARGE = 1500;

/**
 * Leva um serviço até ao orçamento pendente: o provider publica, o admin
 * aprova, o cliente pede e o provider orçamenta.
 */
export async function createServiceQuote(
  actors: BookingFlowActors,
  { urgent = false } = {},
): Promise<{ requestId: string; quoteId: string }> {
  const { httpServer, provider, client, admin } = actors;

  const service = await request(httpServer)
    .post('/api/v1/services')
    .set(authHeader(provider.accessToken))
    .send({
      title: 'Reparação eléctrica residencial',
      description:
        'Diagnóstico, reparação e instalação eléctrica em residências. Resposta rápida.',
      categoryId: actors.seed.categories.electricidade.id,
      basePrice: SERVICE_AMOUNT,
      pricingType: 'FIXED',
      location: 'Maputo, Cidade',
      acceptsUrgent: true,
      urgentSurcharge: URGENT_SURCHARGE_PERCENT,
    });
  assertStatus('criar serviço', service, 201);
  const serviceId = service.body.data.id as string;

  const approved = await request(httpServer)
    .patch(`/api/v1/services/${serviceId}/approve`)
    .set(authHeader(admin.accessToken))
    .send({});
  assertStatus('aprovar serviço', approved, 200);

  const serviceRequest = await request(httpServer)
    .post('/api/v1/service-requests')
    .set(authHeader(client.accessToken))
    .send({
      serviceId,
      description: 'Quadro eléctrico a disparar sempre que ligo o forno.',
      address: 'Av. Eduardo Mondlane, 123, Maputo',
      isUrgent: urgent,
    });
  assertStatus('criar pedido de serviço', serviceRequest, 201);
  const requestId = serviceRequest.body.data.id as string;

  const quote = await request(httpServer)
    .post(`/api/v1/service-requests/${requestId}/quotes`)
    .set(authHeader(provider.accessToken))
    .send({
      amount: SERVICE_AMOUNT,
      ...(urgent ? { urgentSurcharge: URGENT_SURCHARGE } : {}),
      totalAmount: SERVICE_AMOUNT + (urgent ? URGENT_SURCHARGE : 0),
      estimatedDays: 1,
      message: 'Consigo ir amanhã de manhã. Inclui pequenos materiais.',
    });
  assertStatus('enviar orçamento', quote, 201);

  return { requestId, quoteId: quote.body.data.id as string };
}

/**
 * O cliente aceita o orçamento: nascem a reserva de serviço e o pagamento,
 * os dois em estado PENDING.
 */
export async function acceptServiceQuote(
  actors: BookingFlowActors,
  quoteId: string,
): Promise<{ serviceBookingId: string; paymentId: string }> {
  const accepted = await request(actors.httpServer)
    .patch(`/api/v1/service-quotes/${quoteId}/accept`)
    .set(authHeader(actors.client.accessToken))
    .send({});
  assertStatus('aceitar orçamento', accepted, 200);

  const { serviceBookingId, paymentId } = accepted.body.data as {
    serviceBookingId: string;
    paymentId: string;
  };
  return { serviceBookingId, paymentId };
}

/** Reserva de serviço com o pagamento já marcado como recebido (HELD). */
export async function createHeldServiceBooking(
  actors: BookingFlowActors,
): Promise<{ serviceBookingId: string; paymentId: string }> {
  const { quoteId } = await createServiceQuote(actors);
  const booking = await acceptServiceQuote(actors, quoteId);

  const held = await request(actors.httpServer)
    .patch(`/api/v1/payments/${booking.paymentId}/mark-held`)
    .set(authHeader(actors.admin.accessToken))
    .send(await paymentReceipt(booking.paymentId));
  assertStatus('marcar pagamento como retido', held, 200);

  return booking;
}
