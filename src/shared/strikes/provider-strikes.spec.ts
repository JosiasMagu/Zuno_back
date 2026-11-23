import {
  AuditAction,
  EquipmentStatus,
  Prisma,
  ServiceStatus,
} from '@prisma/client';

import { AuditService, SYSTEM_ACTOR_ID } from '../audit/audit.service';
import { issueProviderStrike } from './provider-strikes';

const PROVIDER_ID = 'provider-uuid-001';
const BOOKING_ID = 'booking-uuid-001';
const SERVICE_BOOKING_ID = 'service-booking-uuid-001';

const NOW = new Date('2030-06-01T10:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

const txMock = {
  providerStrike: { create: jest.fn(), count: jest.fn() },
  user: { update: jest.fn() },
  equipment: { updateMany: jest.fn() },
  service: { updateMany: jest.fn() },
};
const tx = txMock as unknown as Prisma.TransactionClient;

const auditMock = { record: jest.fn() };
const audit = auditMock as unknown as AuditService;

const STRIKE = {
  providerId: PROVIDER_ID,
  actorId: PROVIDER_ID,
  bookingId: BOOKING_ID,
  reason: 'Cancelamento de reserva confirmada.',
};

describe('issueProviderStrike', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    // O relógio falso do Jest só aceita o instante em milissegundos.
    jest.useFakeTimers().setSystemTime(NOW.getTime());
    txMock.providerStrike.count.mockResolvedValue(1);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('records the strike against the equipment booking', async () => {
    await issueProviderStrike(tx, audit, STRIKE);

    expect(txMock.providerStrike.create).toHaveBeenCalledWith({
      data: {
        userId: PROVIDER_ID,
        bookingId: BOOKING_ID,
        serviceBookingId: null,
        reason: 'Cancelamento de reserva confirmada.',
      },
    });
  });

  it('records the strike against the service booking', async () => {
    await issueProviderStrike(tx, audit, {
      providerId: PROVIDER_ID,
      actorId: PROVIDER_ID,
      serviceBookingId: SERVICE_BOOKING_ID,
      reason: 'Cancelamento de serviço já pago.',
    });

    expect(txMock.providerStrike.create).toHaveBeenCalledWith({
      data: {
        userId: PROVIDER_ID,
        bookingId: null,
        serviceBookingId: SERVICE_BOOKING_ID,
        reason: 'Cancelamento de serviço já pago.',
      },
    });
    expect(auditMock.record).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { serviceBookingId: SERVICE_BOOKING_ID },
      }),
      tx,
    );
  });

  it('audits the strike in the same transaction, in the name of who cancelled', async () => {
    await issueProviderStrike(tx, audit, STRIKE);

    expect(auditMock.record).toHaveBeenCalledTimes(1);
    expect(auditMock.record).toHaveBeenCalledWith(
      {
        action: AuditAction.PROVIDER_STRIKE_ISSUED,
        actorId: PROVIDER_ID,
        targetType: 'User',
        targetId: PROVIDER_ID,
        metadata: { bookingId: BOOKING_ID },
      },
      tx,
    );
  });

  it('counts the strikes of the last 90 days', async () => {
    await issueProviderStrike(tx, audit, STRIKE);

    expect(txMock.providerStrike.count).toHaveBeenCalledWith({
      where: {
        userId: PROVIDER_ID,
        createdAt: { gte: new Date(NOW.getTime() - 90 * DAY_MS) },
      },
    });
  });

  it('suspends nothing below the limit', async () => {
    txMock.providerStrike.count.mockResolvedValue(2);

    const suspendedUntil = await issueProviderStrike(tx, audit, STRIKE);

    expect(suspendedUntil).toBeNull();
    expect(txMock.user.update).not.toHaveBeenCalled();
    expect(txMock.equipment.updateMany).not.toHaveBeenCalled();
    expect(txMock.service.updateMany).not.toHaveBeenCalled();
  });

  it('suspends the provider for 30 days at the third strike, and audits it as the system', async () => {
    txMock.providerStrike.count.mockResolvedValue(3);
    const in30Days = new Date(NOW.getTime() + 30 * DAY_MS);

    const suspendedUntil = await issueProviderStrike(tx, audit, STRIKE);

    expect(suspendedUntil).toEqual(in30Days);
    expect(txMock.user.update).toHaveBeenCalledWith({
      where: { id: PROVIDER_ID },
      data: { listingsSuspendedUntil: in30Days },
    });
    expect(auditMock.record).toHaveBeenLastCalledWith(
      {
        action: AuditAction.PROVIDER_LISTINGS_SUSPENDED,
        actorId: SYSTEM_ACTOR_ID,
        targetType: 'User',
        targetId: PROVIDER_ID,
        metadata: {
          bookingId: BOOKING_ID,
          suspendedUntil: in30Days.toISOString(),
        },
      },
      tx,
    );
  });

  it('pauses both the equipment and the services of a suspended provider', async () => {
    txMock.providerStrike.count.mockResolvedValue(3);

    await issueProviderStrike(tx, audit, STRIKE);

    expect(txMock.equipment.updateMany).toHaveBeenCalledWith({
      where: { ownerId: PROVIDER_ID, status: EquipmentStatus.ACTIVE },
      data: { isAvailable: false },
    });
    expect(txMock.service.updateMany).toHaveBeenCalledWith({
      where: { providerId: PROVIDER_ID, status: ServiceStatus.ACTIVE },
      data: { isActive: false },
    });
  });
});
