import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { CloudinaryService } from '../src/shared/cloudinary/cloudinary.service';
import { createTestApp } from './helpers/app';
import { authHeader } from './helpers/auth';
import { BookingFlowActors, resetBookingFlow } from './helpers/booking-flow';
import { disconnectTestPrisma, getTestPrisma } from './helpers/db';

const PHOTO = Buffer.from('uma foto qualquer');
const MINUTE_MS = 60_000;

describe('Account media E2E', () => {
  let app: INestApplication;
  let actors: BookingFlowActors;
  let uploads: number;
  let deleted: string[];
  const prisma = () => getTestPrisma();

  // Faz de armazenamento: dá nomes ao que recebe e guarda o que mandaram
  // apagar, sem sair para a rede.
  const storage = {
    uploadAvatar: (_file: unknown, userId: string) =>
      Promise.resolve({
        url: `https://res.cloudinary.com/e2e/image/upload/v${++uploads}/zuno/avatars/${userId}.jpg`,
      }),
    deleteAvatar: (userId: string) => {
      deleted.push(`zuno/avatars/${userId}`);
      return Promise.resolve();
    },
    uploadPrivateImage: (_file: unknown, folder: string) =>
      Promise.resolve({ publicId: `${folder}/doc${++uploads}` }),
    privateImageUrl: (publicId: string, expiresAt: Date) =>
      `https://assinado.e2e/${publicId}?expira=${expiresAt.getTime()}`,
    deletePrivateImages: (publicIds: string[]) => {
      deleted.push(...publicIds);
      return Promise.resolve();
    },
  };

  beforeAll(async () => {
    app = await createTestApp((builder) =>
      builder.overrideProvider(CloudinaryService).useValue(storage),
    );
  }, 30000);

  beforeEach(async () => {
    actors = await resetBookingFlow(app);
    uploads = 0;
    deleted = [];
  });

  afterAll(async () => {
    await app.close();
    await disconnectTestPrisma();
  });

  const as = (token: string) => ({
    get: (path: string) =>
      request(actors.httpServer).get(`/api/v1${path}`).set(authHeader(token)),
    patch: (path: string, body: object = {}) =>
      request(actors.httpServer)
        .patch(`/api/v1${path}`)
        .set(authHeader(token))
        .send(body),
    post: (path: string, body: object = {}) =>
      request(actors.httpServer)
        .post(`/api/v1${path}`)
        .set(authHeader(token))
        .send(body),
    upload: (path: string) =>
      request(actors.httpServer)
        .post(`/api/v1${path}`)
        .set(authHeader(token))
        .attach('photo', PHOTO, {
          filename: 'foto.png',
          contentType: 'image/png',
        }),
  });

  const client = () => as(actors.client.accessToken);
  const provider = () => as(actors.provider.accessToken);
  const admin = () => as(actors.admin.accessToken);

  describe('profile photo', () => {
    it('shows the uploaded photo on the profile and replaces it on a new upload', async () => {
      const first = await client().upload('/users/me/avatar');
      const second = await client().upload('/users/me/avatar');

      expect(first.status).toBe(201);
      expect(first.body.data.avatarUrl).toContain(
        `zuno/avatars/${actors.client.userId}`,
      );
      expect(second.body.data.avatarUrl).not.toBe(first.body.data.avatarUrl);

      const me = await client().get('/users/me').expect(200);
      expect(me.body.data.avatarUrl).toBe(second.body.data.avatarUrl);
    });

    it('deletes the photo from storage when the user removes it', async () => {
      await client().upload('/users/me/avatar').expect(201);

      const response = await client().patch('/users/me', { avatarUrl: '' });

      expect(response.status).toBe(200);
      expect(response.body.data.avatarUrl).toBeNull();
      expect(deleted).toEqual([`zuno/avatars/${actors.client.userId}`]);
    });

    it('returns 401 without a session', async () => {
      const response = await request(actors.httpServer)
        .post('/api/v1/users/me/avatar')
        .attach('photo', PHOTO, 'foto.png');

      expect(response.status).toBe(401);
    });
  });

  describe('identity documents', () => {
    async function uploadDocument(who = client): Promise<string> {
      const response = await who()
        .upload('/users/me/verification/documents')
        .expect(201);
      return response.body.data.documentId as string;
    }

    /** O cliente carrega as três fotos e submete. Devolve o id da verificação. */
    async function submitVerification() {
      const documents = {
        documentFrontId: await uploadDocument(),
        documentBackId: await uploadDocument(),
        selfieId: await uploadDocument(),
      };
      const response = await client()
        .post('/users/me/verification', { documentType: 'BI', ...documents })
        .expect(201);

      return { verificationId: response.body.data.id as string, documents };
    }

    it('stores each photo in the account private folder and submits by identifier', async () => {
      const { verificationId, documents } = await submitVerification();

      const folder = `zuno/kyc/${actors.client.userId}/`;
      expect(
        Object.values(documents).every((id) => id.startsWith(folder)),
      ).toBe(true);
      expect(
        await prisma().userVerification.findUniqueOrThrow({
          where: { id: verificationId },
        }),
      ).toMatchObject({ status: 'PENDING', ...documents });
    });

    it('keeps the documents out of the pending list', async () => {
      await submitVerification();

      const response = await admin().get('/admin/verifications/pending');

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0]).toMatchObject({
        status: 'PENDING',
        hasDocumentBack: true,
      });
      expect(JSON.stringify(response.body.data)).not.toContain('zuno/kyc');
    });

    it('gives the admin short-lived links and records who looked', async () => {
      const { verificationId, documents } = await submitVerification();

      const response = await admin().get(
        `/verifications/${verificationId}/documents`,
      );

      expect(response.status).toBe(200);
      const { documentFront, documentBack, selfie, expiresAt } =
        response.body.data;
      expect(documentFront).toContain(documents.documentFrontId);
      expect(documentBack).toContain(documents.documentBackId);
      expect(selfie).toContain(documents.selfieId);
      const validFor = new Date(expiresAt as string).getTime() - Date.now();
      expect(validFor).toBeGreaterThan(9 * MINUTE_MS);
      expect(validFor).toBeLessThanOrEqual(10 * MINUTE_MS);

      const views = await prisma().auditLog.findMany({
        where: {
          action: 'USER_KYC_DOCUMENTS_VIEWED',
          targetId: verificationId,
        },
        select: { actorId: true, metadata: true },
      });
      expect(views).toEqual([
        {
          actorId: actors.admin.userId,
          metadata: { userId: actors.client.userId },
        },
      ]);
    });

    it('returns 403 when someone who is not an admin asks for the documents', async () => {
      const { verificationId } = await submitVerification();

      const response = await client().get(
        `/verifications/${verificationId}/documents`,
      );

      expect(response.status).toBe(403);
    });

    it("refuses another account's document", async () => {
      const theirs = await uploadDocument(provider);

      const response = await client().post('/users/me/verification', {
        documentType: 'PASSAPORTE',
        documentFrontId: theirs,
        selfieId: await uploadDocument(),
      });

      expect(response.status).toBe(400);
      expect(await prisma().userVerification.count()).toBe(0);
    });

    it('refuses more uploads while the submission is under review', async () => {
      await submitVerification();

      const response = await client().upload(
        '/users/me/verification/documents',
      );

      expect(response.status).toBe(400);
    });

    it('deletes the replaced photo when a rejected submission is sent again', async () => {
      const { verificationId, documents } = await submitVerification();
      await admin()
        .patch(`/verifications/${verificationId}/reject`, {
          reason: 'A frente do documento está desfocada.',
        })
        .expect(200);

      const newFront = await uploadDocument();
      await client()
        .post('/users/me/verification', {
          documentType: 'BI',
          ...documents,
          documentFrontId: newFront,
        })
        .expect(201);

      expect(deleted).toEqual([documents.documentFrontId]);
      expect(
        await prisma().userVerification.findUniqueOrThrow({
          where: { id: verificationId },
        }),
      ).toMatchObject({ status: 'PENDING', documentFrontId: newFront });
    });
  });
});
