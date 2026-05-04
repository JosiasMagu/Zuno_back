import type { Request } from 'express';
import type { UserRole } from '@prisma/client';

export interface AuthenticatedUser {
  id: string;
  phone: string;
  role: UserRole;
}

export interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
}
