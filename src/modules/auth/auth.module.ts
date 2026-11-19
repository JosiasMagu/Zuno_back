import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { StringValue } from 'ms';

import { DatabaseModule } from '../../shared/db/database.module';
import { AuthController } from './controllers/auth.controller';
import { AuthAuditService } from './services/auth-audit.service';
import { AuthService } from './services/auth.service';
import { LoginThrottleService } from './services/login-throttle.service';
import { PasswordConfirmationService } from './services/password-confirmation.service';
import { PasswordHasher } from './services/password-hasher.service';
import { SessionsService } from './services/sessions.service';
import { VerificationService } from './services/verification.service';
import { RolesGuard } from './guards/roles.guard';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const jwtSecret = configService.getOrThrow<string>('JWT_ACCESS_SECRET');

        const jwtExpiresIn = (configService.get<string>(
          'JWT_ACCESS_EXPIRES_IN',
        ) ?? '15m') as StringValue;

        return {
          secret: jwtSecret,
          signOptions: {
            expiresIn: jwtExpiresIn,
          },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionsService,
    PasswordHasher,
    LoginThrottleService,
    VerificationService,
    AuthAuditService,
    PasswordConfirmationService,
    JwtStrategy,
    RolesGuard,
  ],
  exports: [
    AuthService,
    SessionsService,
    PasswordConfirmationService,
    JwtModule,
    RolesGuard,
  ],
})
export class AuthModule {}
