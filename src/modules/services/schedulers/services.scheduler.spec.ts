import { Test, TestingModule } from '@nestjs/testing';
import { ServiceQuoteStatus, ServiceRequestStatus } from '@prisma/client';

import { PrismaService } from '../../../shared/db/prisma.service';
import { ServicesScheduler } from './services.scheduler';

const makePrisma = () => ({
  serviceQuote: { updateMany: jest.fn() },
  serviceRequest: { updateMany: jest.fn() },
});

describe('ServicesScheduler', () => {
  let scheduler: ServicesScheduler;
  let prisma: ReturnType<typeof makePrisma>;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(async () => {
    prisma = makePrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ServicesScheduler,
        { provide: PrismaService, useValue: prisma },
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
