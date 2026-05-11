import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import type { Params } from 'nestjs-pino';

const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'req.body.password',
  'req.body.passwordHash',
  'req.body.currentPassword',
  'req.body.newPassword',
  'req.body.token',
  'req.body.refreshToken',
  'req.body.accessToken',
  'res.headers["set-cookie"]',
];

function buildPinoConfig(): Params {
  const env = process.env.NODE_ENV ?? 'development';
  const level =
    process.env.LOG_LEVEL ?? (env === 'production' ? 'info' : 'debug');

  if (env === 'test') {
    return {
      pinoHttp: {
        level: 'silent',
        autoLogging: false,
      },
    };
  }

  const base: Params['pinoHttp'] = {
    level,
    redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
    customProps: () => ({ context: 'HTTP' }),
    serializers: {
      req: (req: { method: string; url: string; id: string }) => ({
        id: req.id,
        method: req.method,
        url: req.url,
      }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
    },
  };

  if (env !== 'production') {
    return {
      pinoHttp: {
        ...base,
        transport: {
          target: 'pino-pretty',
          options: {
            singleLine: true,
            colorize: true,
            translateTime: 'SYS:HH:MM:ss.l',
            ignore: 'pid,hostname,context,req,res,responseTime',
            messageFormat: '[{context}] {msg}',
          },
        },
      },
    };
  }

  return { pinoHttp: base };
}

@Module({
  imports: [PinoLoggerModule.forRoot(buildPinoConfig())],
})
export class LoggerModule {}
