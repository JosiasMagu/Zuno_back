import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { Logger as PinoLogger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { applyApiPrefix } from './shared/http/api-prefix';
import { corsOrigin } from './shared/http/cors';
import { initSentry } from './shared/sentry/sentry';

async function bootstrap() {
  initSentry();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });
  const logger = app.get(PinoLogger);
  app.useLogger(logger);

  // Atrás de um proxy inverso, o IP do cliente chega em X-Forwarded-For.
  // TRUST_PROXY_HOPS diz quantos proxies há à frente; com 0 (o valor por
  // omissão) o cabeçalho é ignorado, para não poder ser forjado e usado
  // para fugir ao rate limit.
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 0));

  // enableShutdownHooks() faz com que SIGINT/SIGTERM disparem os
  // onApplicationShutdown() de todos os providers (incluindo o
  // SentryShutdownService que descarrega a fila do Sentry).
  app.enableShutdownHooks();

  applyApiPrefix(app);

  app.use(helmet());
  app.use(compression());
  app.use(cookieParser());

  const allowedOrigins = (
    process.env.ALLOWED_ORIGINS ?? 'http://localhost:3000,http://localhost:8081'
  )
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.enableCors({ origin: corsOrigin(allowedOrigins), credentials: true });

  app.useGlobalFilters(new HttpExceptionFilter());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  if (process.env.NODE_ENV !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Zuno API')
      .setDescription('API oficial da plataforma Zuno')
      .setVersion('1.0.0')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Insere o access token JWT',
        },
        'access-token',
      )
      .build();

    const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, swaggerDocument);

    logger.log(
      `Swagger disponível em http://localhost:${process.env.PORT ?? 3000}/docs`,
    );
  }

  const port = Number(process.env.PORT) || 3000;
  await app.listen(port);

  logger.log(`Zuno API a correr em http://localhost:${port}/api/v1`);
  logger.log(`Ambiente: ${process.env.NODE_ENV ?? 'development'}`);
}

void bootstrap();
