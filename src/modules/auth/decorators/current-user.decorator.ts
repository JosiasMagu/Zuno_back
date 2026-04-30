import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { UserRole } from '@prisma/client';

export type CurrentAuthUser = {
  id: string;
  name?: string;
  phone?: string;
  email?: string | null;
  role?: UserRole;
  isVerified?: boolean;
  isActive?: boolean;
  avatarUrl?: string | null;
  bio?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
};

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CurrentAuthUser => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);