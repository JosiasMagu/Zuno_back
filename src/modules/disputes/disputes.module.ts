import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { DisputesController } from './controllers/disputes.controller';
import { DisputesService } from './services/disputes.service';

@Module({
  imports: [AuthModule],
  controllers: [DisputesController],
  providers: [DisputesService],
  exports: [DisputesService],
})
export class DisputesModule {}