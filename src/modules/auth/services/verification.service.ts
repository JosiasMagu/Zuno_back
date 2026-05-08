import { BadRequestException, Injectable } from '@nestjs/common';
import { VerificationPurpose } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';

import { PrismaService } from '../../../shared/db/prisma.service';
import {
  NotificationsService,
  VerificationCodeNotification,
} from '../../../shared/notifications/notifications.service';

const CODE_TTL_MINUTES = 15;
const CODE_LENGTH = 6;
const MAX_ATTEMPTS = 5;
const BCRYPT_ROUNDS = 10;

@Injectable()
export class VerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async issueCode(input: {
    userId: string;
    phone: string;
    email?: string | null;
    purpose: VerificationPurpose;
  }): Promise<{ expiresAt: Date }> {
    await this.prisma.verificationCode.updateMany({
      where: {
        userId: input.userId,
        purpose: input.purpose,
        usedAt: null,
      },
      data: { usedAt: new Date() },
    });

    const code = this.generateCode();
    const codeHash = await bcrypt.hash(code, BCRYPT_ROUNDS);
    const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000);

    await this.prisma.verificationCode.create({
      data: {
        userId: input.userId,
        purpose: input.purpose,
        codeHash,
        expiresAt,
      },
    });

    const payload: VerificationCodeNotification = {
      userId: input.userId,
      phone: input.phone,
      email: input.email,
      code,
      purpose: input.purpose,
      expiresAt,
    };

    await this.notifications.sendVerificationCode(payload);

    return { expiresAt };
  }

  async consumeCode(input: {
    userId: string;
    code: string;
    purpose: VerificationPurpose;
  }): Promise<void> {
    const record = await this.prisma.verificationCode.findFirst({
      where: {
        userId: input.userId,
        purpose: input.purpose,
        usedAt: null,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!record) {
      throw new BadRequestException('Codigo invalido ou expirado.');
    }

    if (record.expiresAt < new Date()) {
      throw new BadRequestException('Codigo invalido ou expirado.');
    }

    if (record.attempts >= MAX_ATTEMPTS) {
      await this.prisma.verificationCode.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      });
      throw new BadRequestException(
        'Numero maximo de tentativas atingido. Pede um novo codigo.',
      );
    }

    const ok = await bcrypt.compare(input.code, record.codeHash);

    if (!ok) {
      await this.prisma.verificationCode.update({
        where: { id: record.id },
        data: { attempts: { increment: 1 } },
      });
      throw new BadRequestException('Codigo invalido ou expirado.');
    }

    await this.prisma.verificationCode.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    });
  }

  private generateCode(): string {
    const max = 10 ** CODE_LENGTH;
    const n = crypto.randomInt(0, max);
    return n.toString().padStart(CODE_LENGTH, '0');
  }
}
