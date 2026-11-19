import { BadRequestException } from '@nestjs/common';
import { LedgerDirection, LedgerParty, Prisma } from '@prisma/client';

import { LedgerService } from './ledger.service';

const PAYMENT_ID = 'payment-uuid-001';
const ADMIN_ID = 'admin-uuid-001';

const txMock = { ledgerEntry: { aggregate: jest.fn(), create: jest.fn() } };
const tx = txMock as unknown as Prisma.TransactionClient;

/** Põe o pagamento com estas entradas e saídas já registadas. */
function givenLedger(inflow: number, outflow: number) {
  txMock.ledgerEntry.aggregate.mockImplementation(
    ({ where }: { where: { direction: LedgerDirection } }) =>
      Promise.resolve({
        _sum: {
          amount: new Prisma.Decimal(
            where.direction === LedgerDirection.INFLOW ? inflow : outflow,
          ),
        },
      }),
  );
}

const outflow = (amount: number, party: LedgerParty = LedgerParty.CLIENT) => ({
  paymentId: PAYMENT_ID,
  direction: LedgerDirection.OUTFLOW,
  party,
  amount,
  reason: 'Reembolso total ao cliente.',
  actorId: ADMIN_ID,
});

describe('LedgerService', () => {
  let ledger: LedgerService;

  beforeEach(() => {
    jest.resetAllMocks();
    ledger = new LedgerService();
    txMock.ledgerEntry.create.mockImplementation(({ data }: { data: object }) =>
      Promise.resolve(data),
    );
  });

  describe('record', () => {
    it('writes money coming in without looking at the balance', async () => {
      await ledger.record(tx, {
        paymentId: PAYMENT_ID,
        direction: LedgerDirection.INFLOW,
        party: LedgerParty.CLIENT,
        amount: 9950,
        reason: 'Pagamento confirmado e retido no escrow.',
        actorId: ADMIN_ID,
      });

      expect(txMock.ledgerEntry.aggregate).not.toHaveBeenCalled();
      expect(txMock.ledgerEntry.create).toHaveBeenCalledWith({
        data: {
          paymentId: PAYMENT_ID,
          direction: LedgerDirection.INFLOW,
          party: LedgerParty.CLIENT,
          amount: 9950,
          reason: 'Pagamento confirmado e retido no escrow.',
          actorId: ADMIN_ID,
        },
      });
    });

    it('records the system as actor when no one is given', async () => {
      await ledger.record(tx, {
        paymentId: PAYMENT_ID,
        direction: LedgerDirection.INFLOW,
        party: LedgerParty.CLIENT,
        amount: 100,
        reason: 'Pagamento confirmado e retido no escrow.',
      });

      expect(txMock.ledgerEntry.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ actorId: null }) as object,
      });
    });

    it('rounds the amount to cents before writing', async () => {
      await ledger.record(tx, {
        paymentId: PAYMENT_ID,
        direction: LedgerDirection.INFLOW,
        party: LedgerParty.CLIENT,
        amount: 100.456,
        reason: 'Pagamento confirmado e retido no escrow.',
      });

      expect(txMock.ledgerEntry.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ amount: 100.46 }) as object,
      });
    });

    it.each([0, -50, 0.004, Number.NaN, Number.POSITIVE_INFINITY])(
      'refuses an amount of %s',
      async (amount) => {
        await expect(
          ledger.record(tx, {
            paymentId: PAYMENT_ID,
            direction: LedgerDirection.INFLOW,
            party: LedgerParty.CLIENT,
            amount,
            reason: 'Pagamento confirmado e retido no escrow.',
          }),
        ).rejects.toThrow(BadRequestException);

        expect(txMock.ledgerEntry.create).not.toHaveBeenCalled();
      },
    );

    it('lets money out up to what is left in escrow', async () => {
      givenLedger(9950, 4950);

      await ledger.record(tx, outflow(5000));

      expect(txMock.ledgerEntry.create).toHaveBeenCalledTimes(1);
    });

    it('refuses money out beyond what is left in escrow', async () => {
      givenLedger(9950, 4950);

      await expect(ledger.record(tx, outflow(5000.01))).rejects.toThrow(
        'Invariante do ledger violada',
      );

      expect(txMock.ledgerEntry.create).not.toHaveBeenCalled();
    });

    it('refuses any money out of a payment that never received money', async () => {
      givenLedger(0, 0);

      await expect(ledger.record(tx, outflow(1))).rejects.toThrow(
        BadRequestException,
      );
    });

    it('reads the balance of the payment being moved, inside the same transaction', async () => {
      givenLedger(100, 0);

      await ledger.record(tx, outflow(100));

      expect(txMock.ledgerEntry.aggregate).toHaveBeenCalledWith({
        where: { paymentId: PAYMENT_ID, direction: LedgerDirection.INFLOW },
        _sum: { amount: true },
      });
      expect(txMock.ledgerEntry.aggregate).toHaveBeenCalledWith({
        where: { paymentId: PAYMENT_ID, direction: LedgerDirection.OUTFLOW },
        _sum: { amount: true },
      });
    });
  });

  describe('recordMany', () => {
    it('checks the balance again before each entry', async () => {
      // O saldo desce à medida que as saídas são escritas.
      let written = 0;
      txMock.ledgerEntry.aggregate.mockImplementation(
        ({ where }: { where: { direction: LedgerDirection } }) =>
          Promise.resolve({
            _sum: {
              amount: new Prisma.Decimal(
                where.direction === LedgerDirection.INFLOW ? 1000 : written,
              ),
            },
          }),
      );
      txMock.ledgerEntry.create.mockImplementation(
        ({ data }: { data: { amount: number } }) => {
          written += data.amount;
          return Promise.resolve(data);
        },
      );

      await expect(
        ledger.recordMany(tx, [
          outflow(600, LedgerParty.CLIENT),
          outflow(300, LedgerParty.PROVIDER),
          outflow(200, LedgerParty.PLATFORM),
        ]),
      ).rejects.toThrow('Invariante do ledger violada');

      // As duas primeiras cabiam; a terceira passava o que entrou.
      expect(txMock.ledgerEntry.create).toHaveBeenCalledTimes(2);
    });
  });

  describe('balance', () => {
    it('is what came in minus what went out', async () => {
      givenLedger(9950, 4950);

      expect(await ledger.balance(tx, PAYMENT_ID)).toBe(5000);
    });

    it('is zero for a payment with no entries', async () => {
      txMock.ledgerEntry.aggregate.mockResolvedValue({
        _sum: { amount: null },
      });

      expect(await ledger.balance(tx, PAYMENT_ID)).toBe(0);
    });
  });
});
