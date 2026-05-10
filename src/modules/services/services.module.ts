import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ServicesController } from './controllers/services.controller';
import { ServicesService } from './services/services.service';

@Module({
  imports: [AuthModule],
  controllers: [ServicesController],
  providers: [ServicesService],
  exports: [ServicesService],
})
export class ServicesModule {}
