import { Module } from '@nestjs/common';

import { CloudinaryModule } from '../../shared/cloudinary/cloudinary.module';
import { DatabaseModule } from '../../shared/db/database.module';
import { AuthModule } from '../auth/auth.module';
import { UsersController } from './controllers/users.controller';
import { UsersService } from './services/users.service';

@Module({
  imports: [DatabaseModule, AuthModule, CloudinaryModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
