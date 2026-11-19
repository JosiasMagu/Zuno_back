import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import type { Response } from 'supertest';

import { AppModule } from '../../src/app.module';
import { HttpExceptionFilter } from '../../src/common/filters/http-exception.filter';
import { applyApiPrefix } from '../../src/shared/http/api-prefix';

/**
 * Sobe a aplicação com o mesmo prefixo, pipes e filtro do `main.ts`.
 * `customize` serve para trocar providers antes de compilar o módulo.
 */
export async function createTestApp(
  customize: (builder: TestingModuleBuilder) => TestingModuleBuilder = (
    builder,
  ) => builder,
): Promise<INestApplication> {
  const moduleFixture = await customize(
    Test.createTestingModule({ imports: [AppModule] }),
  ).compile();

  const app = moduleFixture.createNestApplication();
  applyApiPrefix(app);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());

  await app.init();
  return app;
}

/** O que identifica uma resposta de erro, sem a hora nem o caminho. */
export function errorOf(response: Response) {
  const { statusCode, errorCode, message } = response.body as Record<
    string,
    unknown
  >;
  return { statusCode, errorCode, message };
}
