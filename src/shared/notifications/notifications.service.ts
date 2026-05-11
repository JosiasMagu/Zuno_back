import { Injectable, Logger } from '@nestjs/common';
import { VerificationPurpose } from '@prisma/client';

export interface VerificationCodeNotification {
  userId: string;
  phone: string;
  email?: string | null;
  code: string;
  purpose: VerificationPurpose;
  expiresAt: Date;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  sendVerificationCode(payload: VerificationCodeNotification): Promise<void> {
    const driver = process.env.NOTIFICATIONS_DRIVER ?? 'log';

    if (driver !== 'silent') {
      this.logger.warn(
        {
          userId: payload.userId,
          phone: payload.phone,
          email: payload.email,
          purpose: payload.purpose,
          code: payload.code,
          expiresAt: payload.expiresAt,
        },
        'Verification code generated. Configure NOTIFICATIONS_DRIVER to dispatch via SMS or email.',
      );
    }

    return Promise.resolve();
  }
}
