import { depositClaimDeadline, paymentDeadline } from './booking-deadlines';

const HOUR_MS = 60 * 60 * 1000;
const hoursAfter = (date: Date, hours: number) =>
  new Date(date.getTime() + hours * HOUR_MS);

const CREATED_AT = new Date(2026, 10, 16, 10, 0);

describe('prazos de uma reserva', () => {
  describe('paymentDeadline()', () => {
    it('dá 24 horas a uma reserva que começa daqui a uma semana', () => {
      const startDate = new Date(2026, 10, 23);

      expect(paymentDeadline(CREATED_AT, startDate)).toEqual(
        hoursAfter(CREATED_AT, 24),
      );
    });

    it('corta 2 horas antes do início quando isso chega primeiro', () => {
      const startDate = new Date(2026, 10, 17);

      expect(paymentDeadline(CREATED_AT, startDate)).toEqual(
        new Date(2026, 10, 16, 22, 0),
      );
    });

    it('dá sempre 2 horas a uma reserva feita para o próprio dia', () => {
      const startDate = new Date(2026, 10, 16);

      expect(paymentDeadline(CREATED_AT, startDate)).toEqual(
        hoursAfter(CREATED_AT, 2),
      );
    });
  });

  describe('depositClaimDeadline()', () => {
    const endDate = new Date(2026, 10, 20);

    it('conta 48 horas do fim do aluguer quando a entrega foi antes', () => {
      const deadline = depositClaimDeadline({
        endDate,
        deliveryConfirmedAt: new Date(2026, 10, 17, 9, 0),
      });

      expect(deadline).toEqual(hoursAfter(endDate, 48));
    });

    it('conta 48 horas da entrega quando esta foi depois do fim do aluguer', () => {
      const deliveryConfirmedAt = new Date(2026, 10, 21, 15, 0);

      const deadline = depositClaimDeadline({ endDate, deliveryConfirmedAt });

      expect(deadline).toEqual(hoursAfter(deliveryConfirmedAt, 48));
    });

    it('conta do fim do aluguer numa reserva antiga sem data de entrega', () => {
      const deadline = depositClaimDeadline({
        endDate,
        deliveryConfirmedAt: null,
      });

      expect(deadline).toEqual(hoursAfter(endDate, 48));
    });
  });
});
