import { Injectable, Logger } from '@nestjs/common';

export interface PushPayload {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  async send(payload: PushPayload): Promise<void> {
    if (!payload.to || !payload.to.startsWith('ExponentPushToken')) {
      return;
    }

    try {
      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip, deflate',
        },
        body: JSON.stringify({
          to: payload.to,
          title: payload.title,
          body: payload.body,
          data: payload.data ?? {},
          sound: 'default',
          priority: 'high',
        }),
      });

      const result = await response.json();

      if (result?.data?.status === 'error') {
        this.logger.warn(`Push falhou para ${payload.to}: ${result.data.message}`);
      } else {
        this.logger.log(`Push enviado para ${payload.to}: ${payload.title}`);
      }
    } catch (error) {
      this.logger.error('Erro ao enviar push notification', error);
    }
  }

  async sendToMany(payloads: PushPayload[]): Promise<void> {
    await Promise.allSettled(payloads.map((p) => this.send(p)));
  }
}