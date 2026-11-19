import {
  BookingStatus,
  DisputeType,
  ServiceBookingStatus,
} from '@prisma/client';

import {
  isOwnEvidence,
  rentalStatusBeforeDispute,
  respondentOf,
  responseDeadline,
  serviceStatusBeforeDispute,
} from './dispute-rules';

const CLIENT_ID = 'client-uuid-001';
const PROVIDER_ID = 'provider-uuid-001';
const PARTIES = { clientId: CLIENT_ID, providerId: PROVIDER_ID };

describe('respondentOf', () => {
  it('é o provider quando a disputa foi aberta pelo cliente', () => {
    expect(respondentOf(PARTIES, CLIENT_ID)).toBe(PROVIDER_ID);
  });

  it('é o cliente quando a disputa foi aberta pelo provider', () => {
    expect(respondentOf(PARTIES, PROVIDER_ID)).toBe(CLIENT_ID);
  });
});

describe('responseDeadline', () => {
  it('dá três dias certos a contar da abertura', () => {
    const openedAt = new Date('2026-11-17T09:30:00.000Z');

    expect(responseDeadline(openedAt)).toEqual(
      new Date('2026-11-20T09:30:00.000Z'),
    );
  });

  it('não mexe na data que recebe', () => {
    const openedAt = new Date('2026-11-17T09:30:00.000Z');

    responseDeadline(openedAt);

    expect(openedAt).toEqual(new Date('2026-11-17T09:30:00.000Z'));
  });
});

describe('rentalStatusBeforeDispute', () => {
  it('devolve o aluguer a CONFIRMED numa disputa de pagamento', () => {
    expect(rentalStatusBeforeDispute(DisputeType.PAYMENT)).toBe(
      BookingStatus.CONFIRMED,
    );
  });

  it('devolve o aluguer a ACTIVE numa disputa de depósito', () => {
    expect(rentalStatusBeforeDispute(DisputeType.DEPOSIT)).toBe(
      BookingStatus.ACTIVE,
    );
  });
});

describe('serviceStatusBeforeDispute', () => {
  const STARTED_AT = new Date('2026-11-10T08:00:00.000Z');
  const COMPLETED_AT = new Date('2026-11-12T17:00:00.000Z');

  it('é PENDING quando o provider ainda não começou', () => {
    expect(
      serviceStatusBeforeDispute({ startedAt: null, completedAt: null }),
    ).toBe(ServiceBookingStatus.PENDING);
  });

  it('é IN_PROGRESS quando o provider começou e não concluiu', () => {
    expect(
      serviceStatusBeforeDispute({ startedAt: STARTED_AT, completedAt: null }),
    ).toBe(ServiceBookingStatus.IN_PROGRESS);
  });

  it('é COMPLETED quando o provider já tinha concluído', () => {
    expect(
      serviceStatusBeforeDispute({
        startedAt: STARTED_AT,
        completedAt: COMPLETED_AT,
      }),
    ).toBe(ServiceBookingStatus.COMPLETED);
  });
});

describe('isOwnEvidence', () => {
  const OWNER = { cloudName: 'zuno-test', userId: CLIENT_ID };
  const OWN_PHOTO = `https://res.cloudinary.com/zuno-test/image/upload/v1731830000/zuno/disputes/${CLIENT_ID}/foto.jpg`;

  it('aceita a foto que o próprio utilizador carregou', () => {
    expect(isOwnEvidence(OWN_PHOTO, OWNER)).toBe(true);
  });

  it.each([
    ['a foto de outro utilizador', OWN_PHOTO.replace(CLIENT_ID, PROVIDER_ID)],
    [
      'a foto de outra conta Cloudinary',
      OWN_PHOTO.replace('/zuno-test/', '/outra-conta/'),
    ],
    [
      'uma conta cujo nome só começa pelo do projecto',
      OWN_PHOTO.replace('/zuno-test/', '/zuno-test-falsa/'),
    ],
    ['um endereço http', OWN_PHOTO.replace('https://', 'http://')],
    [
      'outro domínio com o mesmo caminho',
      OWN_PHOTO.replace('res.cloudinary.com', 'res.cloudinary.com.exemplo.com'),
    ],
    [
      'uma foto de equipamento do mesmo utilizador',
      OWN_PHOTO.replace('/zuno/disputes/', '/zuno/equipment/'),
    ],
    ['um texto que não é um endereço', 'isto não é um url'],
    ['um endereço vazio', ''],
  ])('recusa %s', (_label, url) => {
    expect(isOwnEvidence(url, OWNER)).toBe(false);
  });

  it('recusa a pasta de outro utilizador posta nos parâmetros do endereço', () => {
    const url = `https://res.cloudinary.com/zuno-test/image/upload/v1/zuno/disputes/${PROVIDER_ID}/foto.jpg?x=/zuno/disputes/${CLIENT_ID}/`;

    expect(isOwnEvidence(url, OWNER)).toBe(false);
  });
});
