import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('Bootstrap');

  app.setGlobalPrefix('api/v1');

  app.use(helmet());
  app.use(compression());
  app.use(cookieParser());

  const allowedOrigins = (
    process.env.ALLOWED_ORIGINS ?? 'http://localhost:3000,http://localhost:8081'
  )
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.enableCors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error(`CORS: origem não permitida — ${origin}`));
    },
    credentials: true,
  });

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
