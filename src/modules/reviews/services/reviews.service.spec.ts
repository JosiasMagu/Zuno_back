import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { BookingStatus, ReviewAuthorRole } from '@prisma/client';

import { ReviewsService } from './reviews.service';
import { PrismaService } from '../../../shared/db/prisma.service';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────────────────

const CLIENT_ID = 'client-uuid-001';
const OWNER_ID = 'owner-uuid-001';
const EQUIPMENT_ID = 'equipment-uuid-001';
const BOOKING_ID = 'booking-uuid-001';
const REVIEW_ID = 'review-uuid-001';
const STRANGER_ID = 'stranger-uuid-001';

// ─────────────────────────────────────────────────────────────────────────────
// FACTORIES
// ─────────────────────────────────────────────────────────────────────────────

const makeBooking = (overrides: Record<string, unknown> = {}) => ({
  id: BOOKING_ID,
  clientId: CLIENT_ID,
  ownerId: OWNER_ID,
  equipmentId: EQUIPMENT_ID,
  status: BookingStatus.COMPLETED,
  ...overrides,
});

const makeReview = (overrides: Record<string, unknown> = {}) => ({
  id: REVIEW_ID,
  bookingId: BOOKING_ID,
  authorId: CLIENT_ID,
  targetId: EQUIPMENT_ID,
  authorRole: ReviewAuthorRole.CLIENT,
  rating: 5,
  comment: 'Excelente equipamento.',
  createdAt: new Date(),
  updatedAt: new Date(),
  author: { id: CLIENT_ID, name: 'Cliente', avatarUrl: null },
  ...overrides,
});

// ─────────────────────────────────────────────────────────────────────────────
// MOCK DO PRISMA
// Inclui os modelos usados dentro das transacções (tx)
// ─────────────────────────────────────────────────────────────────────────────

const makePrismaMock = () => {
  const mock = {
    booking: { findUnique: jest.fn() },
    equipment: { findUnique: jest.fn(), update: jest.fn() },
    user: { findUnique: jest.fn(), update: jest.fn() },
    review: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      aggregate: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  return mock;
};

// ─────────────────────────────────────────────────────────────────────────────
// SUITE PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────

describe('ReviewsService', () => {
  let service: ReviewsService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [ReviewsService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<ReviewsService>(ReviewsService);
  });

  afterEach(() => jest.clearAllMocks());

  // ───────────────────────────────────────────────────────────────────────────
  // create()
  // ───────────────────────────────────────────────────────────────────────────

  describe('create()', () => {
    const clientDto = {
      bookingId: BOOKING_ID,
      authorRole: ReviewAuthorRole.CLIENT,
      rating: 5,
      comment: 'Excelente.',
    };

    const ownerDto = {
      bookingId: BOOKING_ID,
      authorRole: ReviewAuthorRole.OWNER,
      rating: 4,
      comment: 'Cliente pontual.',
    };

    // Configura $transaction para simular o callback com tx completo
    const setupHappyTx = (reviewResult = makeReview()) => {
      prisma.$transaction.mockImplementation(
        async (callback: (tx: typeof prisma) => Promise<unknown>) => {
          // O tx tem os mesmos métodos do prisma mock
          prisma.review.create.mockResolvedValue(reviewResult);
          prisma.review.aggregate.mockResolvedValue({
            _avg: { rating: 4.5 },
            _count: { rating: 2 },
          });
          prisma.equipment.update.mockResolvedValue({});
          prisma.user.update.mockResolvedValue({});
          return callback(prisma);
        },
      );
    };

    it('CLIENT cria avaliação com sucesso — targetId é o equipment', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeBooking());
      prisma.review.findUnique.mockResolvedValue(null);
      setupHappyTx();

      const result = await service.create(CLIENT_ID, clientDto);

      expect(result.message).toBe('Avaliação submetida com sucesso.');
      expect(result.data.id).toBe(REVIEW_ID);
    });

    it('OWNER cria avaliação com sucesso — targetId é o clientId', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeBooking());
      prisma.review.findUnique.mockResolvedValue(null);
      setupHappyTx(
        makeReview({
          authorId: OWNER_ID,
          targetId: CLIENT_ID,
          authorRole: ReviewAuthorRole.OWNER,
          rating: 4,
        }),
      );

      const result = await service.create(OWNER_ID, ownerDto);
      expect(result.message).toBe('Avaliação submetida com sucesso.');
    });

    it('lança NotFoundException se booking não existe', async () => {
      prisma.booking.findUnique.mockResolvedValue(null);

      await expect(service.create(CLIENT_ID, clientDto)).rejects.toThrow(
        new NotFoundException('Reserva não encontrada.'),
      );
    });

    it('lança BadRequestException se booking está PENDING — não permite avaliação', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        makeBooking({ status: BookingStatus.PENDING }),
      );

      await expect(service.create(CLIENT_ID, clientDto)).rejects.toThrow(
        new BadRequestException(
          'Só é possível avaliar reservas concluídas ou canceladas.',
        ),
      );
    });

    it('lança BadRequestException se booking está CONFIRMED', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        makeBooking({ status: BookingStatus.CONFIRMED }),
      );

      await expect(service.create(CLIENT_ID, clientDto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('lança BadRequestException se booking está DISPUTED', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        makeBooking({ status: BookingStatus.DISPUTED }),
      );

      await expect(service.create(CLIENT_ID, clientDto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('permite avaliação de booking CANCELLED', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        makeBooking({ status: BookingStatus.CANCELLED }),
      );
      prisma.review.findUnique.mockResolvedValue(null);
      setupHappyTx();

      const result = await service.create(CLIENT_ID, clientDto);
      expect(result.message).toBe('Avaliação submetida com sucesso.');
    });

    it('lança ForbiddenException se utilizador não é parte da booking', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeBooking());

      await expect(service.create(STRANGER_ID, clientDto)).rejects.toThrow(
        new ForbiddenException('Não tens permissão para avaliar esta reserva.'),
      );
    });

    it('lança ForbiddenException se OWNER tenta avaliar com papel CLIENT', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeBooking());

      // OWNER a tentar usar papel CLIENT
      await expect(service.create(OWNER_ID, clientDto)).rejects.toThrow(
        new ForbiddenException(
          'Só o cliente pode submeter uma avaliação com o papel CLIENT.',
        ),
      );
    });

    it('lança ForbiddenException se CLIENT tenta avaliar com papel OWNER', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeBooking());

      // CLIENT a tentar usar papel OWNER
      await expect(service.create(CLIENT_ID, ownerDto)).rejects.toThrow(
        new ForbiddenException(
          'Só o proprietário pode submeter uma avaliação com o papel OWNER.',
        ),
      );
    });

    it('lança BadRequestException se já existe avaliação do mesmo utilizador na mesma booking', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeBooking());
      prisma.review.findUnique.mockResolvedValue(makeReview()); // já existe

      await expect(service.create(CLIENT_ID, clientDto)).rejects.toThrow(
        new BadRequestException(
          'Já submeteste uma avaliação para esta reserva.',
        ),
      );
    });

    it('CLIENT: targetId é o equipmentId', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeBooking());
      prisma.review.findUnique.mockResolvedValue(null);
      setupHappyTx();

      await service.create(CLIENT_ID, clientDto);

      expect(prisma.review.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ targetId: EQUIPMENT_ID }),
        }),
      );
    });

    it('OWNER: targetId é o clientId', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeBooking());
      prisma.review.findUnique.mockResolvedValue(null);
      setupHappyTx(makeReview({ authorId: OWNER_ID, targetId: CLIENT_ID }));

      await service.create(OWNER_ID, ownerDto);

      expect(prisma.review.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ targetId: CLIENT_ID }),
        }),
      );
    });

    it('CLIENT: recalcula rating do equipment E do owner após avaliação', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeBooking());
      prisma.review.findUnique.mockResolvedValue(null);

      const aggregateMock = jest.fn().mockResolvedValue({
        _avg: { rating: 4.5 },
        _count: { rating: 2 },
      });

      prisma.$transaction.mockImplementation(
        async (callback: (tx: typeof prisma) => Promise<unknown>) => {
          prisma.review.create.mockResolvedValue(makeReview());
          prisma.review.aggregate = aggregateMock;
          prisma.equipment.update.mockResolvedValue({});
          prisma.user.update.mockResolvedValue({});
          return callback(prisma);
        },
      );

      await service.create(CLIENT_ID, clientDto);

      // aggregate chamado 2 vezes: 1 para equipment, 1 para owner
      expect(aggregateMock).toHaveBeenCalledTimes(2);
      // equipment.update e user.update cada um chamado 1 vez
      expect(prisma.equipment.update).toHaveBeenCalledTimes(1);
      expect(prisma.user.update).toHaveBeenCalledTimes(1);
    });

    it('OWNER: recalcula apenas rating do cliente (não do equipment)', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeBooking());
      prisma.review.findUnique.mockResolvedValue(null);

      const aggregateMock = jest.fn().mockResolvedValue({
        _avg: { rating: 4.0 },
        _count: { rating: 1 },
      });

      prisma.$transaction.mockImplementation(
        async (callback: (tx: typeof prisma) => Promise<unknown>) => {
          prisma.review.create.mockResolvedValue(
            makeReview({
              authorId: OWNER_ID,
              targetId: CLIENT_ID,
              authorRole: ReviewAuthorRole.OWNER,
            }),
          );
          prisma.review.aggregate = aggregateMock;
          prisma.user.update.mockResolvedValue({});
          return callback(prisma);
        },
      );

      await service.create(OWNER_ID, ownerDto);

      // aggregate chamado apenas 1 vez (só para o cliente)
      expect(aggregateMock).toHaveBeenCalledTimes(1);
      // equipment.update nunca é chamado quando OWNER avalia
      expect(prisma.equipment.update).not.toHaveBeenCalled();
      expect(prisma.user.update).toHaveBeenCalledTimes(1);
    });

    it('usa $transaction — create directo no prisma nunca é chamado fora da transacção', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeBooking());
      prisma.review.findUnique.mockResolvedValue(null);
      setupHappyTx();

      await service.create(CLIENT_ID, clientDto);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // findByEquipment()
  // ───────────────────────────────────────────────────────────────────────────

  describe('findByEquipment()', () => {
    it('lança NotFoundException se equipment não existe', async () => {
      prisma.equipment.findUnique.mockResolvedValue(null);

      await expect(
        service.findByEquipment(EQUIPMENT_ID, { page: 1, limit: 10 }),
      ).rejects.toThrow(new NotFoundException('Equipamento não encontrado.'));
    });

    it('filtra apenas avaliações de CLIENT (não de OWNER)', async () => {
      prisma.equipment.findUnique.mockResolvedValue({ id: EQUIPMENT_ID });
      prisma.review.findMany.mockResolvedValue([makeReview()]);
      prisma.review.count.mockResolvedValue(1);

      await service.findByEquipment(EQUIPMENT_ID, { page: 1, limit: 10 });

      const where = (
        prisma.review.findMany.mock.calls[0][0] as {
          where: Record<string, unknown>;
        }
      ).where;
      expect(where).toMatchObject({
        targetId: EQUIPMENT_ID,
        authorRole: ReviewAuthorRole.CLIENT,
      });
    });

    it('devolve lista com dados correctos', async () => {
      prisma.equipment.findUnique.mockResolvedValue({ id: EQUIPMENT_ID });
      prisma.review.findMany.mockResolvedValue([makeReview()]);
      prisma.review.count.mockResolvedValue(1);

      const result = await service.findByEquipment(EQUIPMENT_ID, {
        page: 1,
        limit: 10,
      });

      expect(result.message).toBe('Avaliações obtidas com sucesso.');
      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe(REVIEW_ID);
    });

    it('devolve meta de paginação correcta', async () => {
      prisma.equipment.findUnique.mockResolvedValue({ id: EQUIPMENT_ID });
      prisma.review.findMany.mockResolvedValue([makeReview()]);
      prisma.review.count.mockResolvedValue(20);

      const result = await service.findByEquipment(EQUIPMENT_ID, {
        page: 2,
        limit: 5,
      });

      expect(result.meta).toMatchObject({
        page: 2,
        limit: 5,
        total: 20,
        totalPages: 4,
        hasNextPage: true,
        hasPreviousPage: true,
      });
    });

    it('hasPreviousPage = false na primeira página', async () => {
      prisma.equipment.findUnique.mockResolvedValue({ id: EQUIPMENT_ID });
      prisma.review.findMany.mockResolvedValue([]);
      prisma.review.count.mockResolvedValue(0);

      const result = await service.findByEquipment(EQUIPMENT_ID, {
        page: 1,
        limit: 10,
      });
      expect(result.meta.hasPreviousPage).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // findByUser()
  // ───────────────────────────────────────────────────────────────────────────

  describe('findByUser()', () => {
    it('lança NotFoundException se utilizador não existe', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.findByUser(OWNER_ID, { page: 1, limit: 10 }),
      ).rejects.toThrow(new NotFoundException('Utilizador não encontrado.'));
    });

    it('filtra por targetId do utilizador', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: OWNER_ID });
      prisma.review.findMany.mockResolvedValue([]);
      prisma.review.count.mockResolvedValue(0);

      await service.findByUser(OWNER_ID, { page: 1, limit: 10 });

      const where = (
        prisma.review.findMany.mock.calls[0][0] as {
          where: Record<string, unknown>;
        }
      ).where;
      expect(where).toMatchObject({ targetId: OWNER_ID });
    });

    it('filtra por authorRole quando fornecido', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: OWNER_ID });
      prisma.review.findMany.mockResolvedValue([]);
      prisma.review.count.mockResolvedValue(0);

      await service.findByUser(OWNER_ID, {
        page: 1,
        limit: 10,
        authorRole: ReviewAuthorRole.CLIENT,
      });

      const where = (
        prisma.review.findMany.mock.calls[0][0] as {
          where: Record<string, unknown>;
        }
      ).where;
      expect(where).toMatchObject({ authorRole: ReviewAuthorRole.CLIENT });
    });

    it('não filtra por authorRole quando não fornecido', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: OWNER_ID });
      prisma.review.findMany.mockResolvedValue([]);
      prisma.review.count.mockResolvedValue(0);

      await service.findByUser(OWNER_ID, { page: 1, limit: 10 });

      const where = (
        prisma.review.findMany.mock.calls[0][0] as {
          where: Record<string, unknown>;
        }
      ).where;
      expect(where).not.toHaveProperty('authorRole');
    });

    it('devolve meta de paginação correcta', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: OWNER_ID });
      prisma.review.findMany.mockResolvedValue([makeReview()]);
      prisma.review.count.mockResolvedValue(10);

      const result = await service.findByUser(OWNER_ID, { page: 1, limit: 5 });

      expect(result.meta).toMatchObject({
        page: 1,
        limit: 5,
        total: 10,
        totalPages: 2,
        hasNextPage: true,
        hasPreviousPage: false,
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // findMyReviews()
  // ───────────────────────────────────────────────────────────────────────────

  describe('findMyReviews()', () => {
    it('filtra por authorId do utilizador autenticado', async () => {
      prisma.review.findMany.mockResolvedValue([makeReview()]);
      prisma.review.count.mockResolvedValue(1);

      await service.findMyReviews(CLIENT_ID, { page: 1, limit: 10 });

      const where = (
        prisma.review.findMany.mock.calls[0][0] as {
          where: Record<string, unknown>;
        }
      ).where;
      expect(where).toMatchObject({ authorId: CLIENT_ID });
    });

    it('filtra por bookingId quando fornecido', async () => {
      prisma.review.findMany.mockResolvedValue([]);
      prisma.review.count.mockResolvedValue(0);

      await service.findMyReviews(CLIENT_ID, {
        page: 1,
        limit: 10,
        bookingId: BOOKING_ID,
      });

      const where = (
        prisma.review.findMany.mock.calls[0][0] as {
          where: Record<string, unknown>;
        }
      ).where;
      expect(where).toMatchObject({ bookingId: BOOKING_ID });
    });

    it('não filtra por bookingId quando não fornecido', async () => {
      prisma.review.findMany.mockResolvedValue([]);
      prisma.review.count.mockResolvedValue(0);

      await service.findMyReviews(CLIENT_ID, { page: 1, limit: 10 });

      const where = (
        prisma.review.findMany.mock.calls[0][0] as {
          where: Record<string, unknown>;
        }
      ).where;
      expect(where).not.toHaveProperty('bookingId');
    });

    it('devolve mensagem correcta', async () => {
      prisma.review.findMany.mockResolvedValue([]);
      prisma.review.count.mockResolvedValue(0);

      const result = await service.findMyReviews(CLIENT_ID, {
        page: 1,
        limit: 10,
      });
      expect(result.message).toBe('As tuas avaliações obtidas com sucesso.');
    });

    it('devolve meta de paginação correcta', async () => {
      prisma.review.findMany.mockResolvedValue([makeReview()]);
      prisma.review.count.mockResolvedValue(7);

      const result = await service.findMyReviews(CLIENT_ID, {
        page: 1,
        limit: 5,
      });

      expect(result.meta).toMatchObject({
        page: 1,
        limit: 5,
        total: 7,
        totalPages: 2,
        hasNextPage: true,
        hasPreviousPage: false,
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // canReview()
  // ───────────────────────────────────────────────────────────────────────────

  describe('canReview()', () => {
    it('lança NotFoundException se booking não existe', async () => {
      prisma.booking.findUnique.mockResolvedValue(null);

      await expect(service.canReview(CLIENT_ID, BOOKING_ID)).rejects.toThrow(
        new NotFoundException('Reserva não encontrada.'),
      );
    });

    it('devolve canReview=false se utilizador não é participante', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeBooking());

      const result = await service.canReview(STRANGER_ID, BOOKING_ID);

      expect(result.data.canReview).toBe(false);
      expect(result.data.reason).toBe('Não és participante desta reserva.');
    });

    it('devolve canReview=false se booking não está num status avaliável (PENDING)', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        makeBooking({ status: BookingStatus.PENDING }),
      );

      const result = await service.canReview(CLIENT_ID, BOOKING_ID);

      expect(result.data.canReview).toBe(false);
      expect(result.data.reason).toBe(
        'A reserva ainda não está concluída ou cancelada.',
      );
    });

    it('devolve canReview=false se booking está CONFIRMED', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        makeBooking({ status: BookingStatus.CONFIRMED }),
      );

      const result = await service.canReview(CLIENT_ID, BOOKING_ID);
      expect(result.data.canReview).toBe(false);
    });

    it('devolve canReview=false se utilizador já avaliou', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeBooking());
      prisma.review.findUnique.mockResolvedValue(makeReview()); // já existe

      const result = await service.canReview(CLIENT_ID, BOOKING_ID);

      expect(result.data.canReview).toBe(false);
      expect(result.data.reason).toBe('Já avaliaste esta reserva.');
    });

    it('CLIENT pode avaliar — devolve canReview=true e role=CLIENT', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeBooking());
      prisma.review.findUnique.mockResolvedValue(null);

      const result = await service.canReview(CLIENT_ID, BOOKING_ID);

      expect(result.data.canReview).toBe(true);
      expect(result.data.role).toBe(ReviewAuthorRole.CLIENT);
    });

    it('OWNER pode avaliar — devolve canReview=true e role=OWNER', async () => {
      prisma.booking.findUnique.mockResolvedValue(makeBooking());
      prisma.review.findUnique.mockResolvedValue(null);

      const result = await service.canReview(OWNER_ID, BOOKING_ID);

      expect(result.data.canReview).toBe(true);
      expect(result.data.role).toBe(ReviewAuthorRole.OWNER);
    });

    it('booking CANCELLED também permite avaliar', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        makeBooking({ status: BookingStatus.CANCELLED }),
      );
      prisma.review.findUnique.mockResolvedValue(null);

      const result = await service.canReview(CLIENT_ID, BOOKING_ID);
      expect(result.data.canReview).toBe(true);
    });
  });
});
