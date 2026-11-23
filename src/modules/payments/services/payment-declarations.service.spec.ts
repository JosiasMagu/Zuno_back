import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  AuditAction,
  BookingStatus,
  PaymentStatus,
  Prisma,
  ServiceBookingStatus,
} from '@prisma/client';

import { ApiException } from '../../../common/exceptions/api.exception';
import { AuditService } from '../../../shared/audit/audit.service';
import { PrismaService } from '../../../shared/db/prisma.service';
import { PaymentDeclarationsService } from './payment-declarations.service';

const CLIENT_ID = 'client-uuid-001';
const OWNER_ID = 'owner-uuid-001';
const PAYMENT_ID = 'payment-uuid-001';
const BOOKING_ID = 'booking-uuid-001';
const SERVICE_BOOKING_ID = 'service-booking-uuid-001';

const NOW = new Date('2030-06-01T10:00:00.000Z');
const IN_48_HOURS = new Date('2030-06-03T10:00:00.000Z');

const DECLARATION = {
  mpesaReference: 'CHK7H3ABCD',
  payerMsisdn: '+258840000002',
};

const auditMock = { record: jest.fn() };

const txMock = {
  payment: { findUnique: jest.fn(), update: jest.fn() },
  booking: { update: jest.fn() },
  serviceBooking: { update: jest.fn() },
};

const prismaMock = {
  payment: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  $transaction: jest.fn(),
};

/** O pagamento como a transacção o relê antes de aceitar a declaração. */
const makeFresh = (overrides: Record<string, unknown> = {}) => ({
  status: PaymentStatus.PENDING,
  declaredAt: null,
  bookingId: BOOKING_ID,
  serviceBookingId: null,
  booking: { status: BookingStatus.CONFIRMED },
  serviceBooking: null,
  ...overrides,
});

/** O pagamento como fica depois de declarado. */
const makeDeclared = (overrides: Record<string, unknown> = {}) => ({
  id: PAYMENT_ID,
  bookingId: BOOKING_ID,
  serviceBookingId: null,
  clientId: CLIENT_ID,
  ownerId: OWNER_ID,
  rentalAmount: new Prisma.Decimal(2000),
  depositAmount: new Prisma.Decimal(500),
  platformFee: new Prisma.Decimal(200),
  totalCharged: new Prisma.Decimal(2700),
  ownerPayout: new Prisma.Decimal(1800),
  currency: 'MZN',
  method: 'MPESA',
  mpesaReference: null,
  status: PaymentStatus.PENDING,
  heldAt: null,
  declaredReference: DECLARATION.mpesaReference,
  declaredPayerMsisdn: DECLARATION.payerMsisdn,
  declaredAt: NOW,
  releasedAt: null,
  refundedAt: null,
  refundAmount: null,
  depositReleasedAt: null,
  depositHeldAmount: null,
  receiptNumber: 'ZUNO-1-0001',
  createdAt: NOW,
  updatedAt: NOW,
  booking: {
    id: BOOKING_ID,
    startDate: new Date('2030-06-05'),
    endDate: new Date('2030-06-08'),
    status: BookingStatus.CONFIRMED,
    expiresAt: IN_48_HOURS,
  },
  serviceBooking: null,
  client: {
    id: CLIENT_ID,
    name: 'Cliente',
    avatarUrl: null,
    phone: '+258840000002',
  },
  owner: { id: OWNER_ID, name: 'Proprietário', avatarUrl: null },
  ...overrides,
});

describe('PaymentDeclarationsService', () => {
  let service: PaymentDeclarationsService;

  beforeEach(async () => {
    jest.resetAllMocks();
    // O relógio falso do Jest só aceita o instante em milissegundos.
    jest.useFakeTimers().setSystemTime(NOW.getTime());

    prismaMock.$transaction.mockImplementation(
      (work: (tx: typeof txMock) => Promise<unknown>) => work(txMock),
    );
    prismaMock.payment.findUnique.mockResolvedValue({ clientId: CLIENT_ID });
    txMock.payment.findUnique.mockResolvedValue(makeFresh());
    txMock.payment.update.mockResolvedValue(makeDeclared());

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentDeclarationsService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: AuditService, useValue: auditMock },
      ],
    }).compile();

    service = module.get(PaymentDeclarationsService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('declare', () => {
    it('stores what the client declared and keeps the payment pending', async () => {
      const result = await service.declare(CLIENT_ID, PAYMENT_ID, DECLARATION);

      expect(txMock.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: PAYMENT_ID },
          data: {
            declaredReference: 'CHK7H3ABCD',
            declaredPayerMsisdn: '+258840000002',
            declaredAt: NOW,
          },
        }),
      );
      expect(result.data.status).toBe(PaymentStatus.PENDING);
      expect(result.data.declaredAt).toEqual(NOW);
      expect(result.data.declaredReference).toBe('CHK7H3ABCD');
      expect(result.data.confirmBy).toEqual(IN_48_HOURS);
    });

    it('gives the admin 48 hours to confirm an equipment booking', async () => {
      await service.declare(CLIENT_ID, PAYMENT_ID, DECLARATION);

      expect(txMock.booking.update).toHaveBeenCalledWith({
        where: { id: BOOKING_ID },
        data: { expiresAt: IN_48_HOURS },
      });
      expect(txMock.serviceBooking.update).not.toHaveBeenCalled();
    });

    it('gives the admin 48 hours to confirm a service booking', async () => {
      txMock.payment.findUnique.mockResolvedValue(
        makeFresh({
          bookingId: null,
          booking: null,
          serviceBookingId: SERVICE_BOOKING_ID,
          serviceBooking: { status: ServiceBookingStatus.PENDING },
        }),
      );

      await service.declare(CLIENT_ID, PAYMENT_ID, DECLARATION);

      expect(txMock.serviceBooking.update).toHaveBeenCalledWith({
        where: { id: SERVICE_BOOKING_ID },
        data: { expiresAt: IN_48_HOURS },
      });
      expect(txMock.booking.update).not.toHaveBeenCalled();
    });

    it('lets the client correct the reference without stretching the deadline', async () => {
      const firstDeclaredAt = new Date('2030-05-31T09:00:00.000Z');
      txMock.payment.findUnique.mockResolvedValue(
        makeFresh({ declaredAt: firstDeclaredAt }),
      );

      await service.declare(CLIENT_ID, PAYMENT_ID, {
        ...DECLARATION,
        mpesaReference: 'CHK9Z9WXYZ',
      });

      expect(txMock.booking.update).not.toHaveBeenCalled();
      expect(txMock.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            declaredReference: 'CHK9Z9WXYZ',
            declaredPayerMsisdn: '+258840000002',
            declaredAt: firstDeclaredAt,
          },
        }),
      );
    });

    it('records the declaration in the audit log', async () => {
      await service.declare(CLIENT_ID, PAYMENT_ID, DECLARATION);

      expect(auditMock.record).toHaveBeenCalledWith({
        action: AuditAction.PAYMENT_DECLARED,
        actorId: CLIENT_ID,
        targetType: 'Payment',
        targetId: PAYMENT_ID,
        amount: new Prisma.Decimal(2700),
        metadata: DECLARATION,
      });
    });

    it('answers 404 for a payment that does not exist', async () => {
      prismaMock.payment.findUnique.mockResolvedValue(null);

      await expect(
        service.declare(CLIENT_ID, PAYMENT_ID, DECLARATION),
      ).rejects.toThrow(NotFoundException);
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it('refuses anyone but the person who made the booking', async () => {
      await expect(
        service.declare(OWNER_ID, PAYMENT_ID, DECLARATION),
      ).rejects.toThrow(ForbiddenException);
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it.each([
      PaymentStatus.HELD,
      PaymentStatus.RELEASED,
      PaymentStatus.REFUNDED,
      PaymentStatus.FAILED,
    ])('refuses a payment that is already %s', async (status) => {
      txMock.payment.findUnique.mockResolvedValue(makeFresh({ status }));

      await expect(
        service.declare(CLIENT_ID, PAYMENT_ID, DECLARATION),
      ).rejects.toThrow(BadRequestException);
      expect(txMock.payment.update).not.toHaveBeenCalled();
      expect(auditMock.record).not.toHaveBeenCalled();
    });

    it.each([
      BookingStatus.PENDING,
      BookingStatus.EXPIRED,
      BookingStatus.CANCELLED,
    ])('refuses when the booking is %s', async (status) => {
      txMock.payment.findUnique.mockResolvedValue(
        makeFresh({ booking: { status } }),
      );

      await expect(
        service.declare(CLIENT_ID, PAYMENT_ID, DECLARATION),
      ).rejects.toThrow(BadRequestException);
      expect(txMock.booking.update).not.toHaveBeenCalled();
      expect(txMock.payment.update).not.toHaveBeenCalled();
    });

    it('turns a write conflict into a clean 409', async () => {
      prismaMock.$transaction.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('conflito', {
          code: 'P2034',
          clientVersion: 'test',
        }),
      );

      const failure = service
        .declare(CLIENT_ID, PAYMENT_ID, DECLARATION)
        .catch((error: unknown) => error);
      // A transacção repete, com uma pausa entre tentativas.
      await jest.runAllTimersAsync();

      const error = await failure;
      expect(error).toBeInstanceOf(ApiException);
      expect(error).toMatchObject({ status: 409 });
      expect(auditMock.record).not.toHaveBeenCalled();
    });
  });

  describe('findAwaitingConfirmation', () => {
    it('lists declared payments still pending, oldest first', async () => {
      prismaMock.payment.findMany.mockResolvedValue([makeDeclared()]);
      prismaMock.payment.count.mockResolvedValue(1);

      const result = await service.findAwaitingConfirmation({
        page: 1,
        limit: 10,
      });

      expect(prismaMock.payment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: PaymentStatus.PENDING, declaredAt: { not: null } },
          orderBy: { declaredAt: 'asc' },
          skip: 0,
          take: 10,
        }),
      );
      expect(result.data).toEqual([
        {
          id: PAYMENT_ID,
          receiptNumber: 'ZUNO-1-0001',
          totalCharged: 2700,
          declaredReference: 'CHK7H3ABCD',
          declaredPayerMsisdn: '+258840000002',
          declaredAt: NOW,
          confirmBy: IN_48_HOURS,
          bookingId: BOOKING_ID,
          serviceBookingId: null,
          client: {
            id: CLIENT_ID,
            name: 'Cliente',
            phone: '+258840000002',
          },
        },
      ]);
    });

    it('pages the queue', async () => {
      prismaMock.payment.findMany.mockResolvedValue([]);
      prismaMock.payment.count.mockResolvedValue(25);

      const result = await service.findAwaitingConfirmation({
        page: 2,
        limit: 10,
      });

      expect(prismaMock.payment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 10, take: 10 }),
      );
      expect(result.meta).toEqual({
        page: 2,
        limit: 10,
        total: 25,
        totalPages: 3,
        hasNextPage: true,
        hasPreviousPage: true,
      });
    });
  });
});
