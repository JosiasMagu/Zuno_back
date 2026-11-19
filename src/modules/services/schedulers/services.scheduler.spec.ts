import { Test, TestingModule } from '@nestjs/testing';
import { ServiceQuoteStatus, ServiceRequestStatus } from '@prisma/client';

import { PrismaService } from '../../../shared/db/prisma.service';
import { ServiceBookingsService } from '../services/service-bookings.service';
import { ServicesScheduler } from './services.scheduler';

const makePrisma = () => ({
  serviceQuote: { updateMany: jest.fn() },
  serviceRequest: { updateMany: jest.fn() },
});

describe('ServicesScheduler', () => {
  let scheduler: ServicesScheduler;
  let prisma: ReturnType<typeof makePrisma>;
  const serviceBookings = { expireUnpaid: jest.fn() };
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(async () => {
    prisma = makePrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ServicesScheduler,
        { provide: PrismaService, useValue: prisma },
        { provide: ServiceBookingsService, useValue: serviceBookings },
      ],
    }).compile();
    scheduler = module.get(ServicesScheduler);
  });

  afterEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('em NODE_ENV=test não dispara updates', async () => {
    process.env.NODE_ENV = 'test';
    await scheduler.expireStaleEntities();
    expect(prisma.serviceQuote.updateMany).not.toHaveBeenCalled();
    expect(prisma.serviceRequest.updateMany).not.toHaveBeenCalled();
  });

  describe('reservas de serviço por pagar', () => {
    it('em NODE_ENV=test não corre', async () => {
      process.env.NODE_ENV = 'test';

      await scheduler.expireUnpaidBookings();

      expect(serviceBookings.expireUnpaid).not.toHaveBeenCalled();
    });

    it('pede ao serviço das reservas que expire as que passaram o prazo', async () => {
      process.env.NODE_ENV = 'development';
      serviceBookings.expireUnpaid.mockResolvedValue(2);

      await scheduler.expireUnpaidBookings();

      expect(serviceBookings.expireUnpaid).toHaveBeenCalledTimes(1);
    });

    it('não deixa uma falha rebentar o agendador', async () => {
      process.env.NODE_ENV = 'development';
      serviceBookings.expireUnpaid.mockRejectedValue(
        new Error('base em baixo'),
      );

      await expect(scheduler.expireUnpaidBookings()).resolves.toBeUndefined();
    });
  });

  it('expira quotes PENDING com expiresAt no passado', async () => {
    process.env.NODE_ENV = 'development';
    prisma.serviceQuote.updateMany.mockResolvedValue({ count: 3 });
    prisma.serviceRequest.updateMany.mockResolvedValue({ count: 0 });

    await scheduler.expireStaleEntities();

    expect(prisma.serviceQuote.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: ServiceQuoteStatus.PENDING,
        }),
        data: { status: ServiceQuoteStatus.EXPIRED },
      }),
    );
  });

  it('expira requests OPEN/QUOTED com expiresAt no passado', async () => {
    process.env.NODE_ENV = 'development';
    prisma.serviceQuote.updateMany.mockResolvedValue({ count: 0 });
    prisma.serviceRequest.updateMany.mockResolvedValue({ count: 2 });

    await scheduler.expireStaleEntities();

    expect(prisma.serviceRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: {
            in: [ServiceRequestStatus.OPEN, ServiceRequestStatus.QUOTED],
          },
        }),
        data: { status: ServiceRequestStatus.EXPIRED },
      }),
    );
  });
});
