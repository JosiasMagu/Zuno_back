import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { NotificationsService } from './notifications.service';
import { createVerificationCodeSender } from './verification-code-drivers';
import { VERIFICATION_CODE_SENDER } from './verification-code-sender';

@Global()
@Module({
  providers: [
    {
      provide: VERIFICATION_CODE_SENDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        createVerificationCodeSender(
          config.get<string>('NOTIFICATIONS_DRIVER'),
          config.get<string>('NODE_ENV'),
        ),
    },
    NotificationsService,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
