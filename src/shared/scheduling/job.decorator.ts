import { Cron } from '@nestjs/schedule';

import { reportJobFailure } from './job-failures';

/**
 * Um job agendado.
 *
 * - Nunca corre por cima de si próprio: se uma execução demorar mais do que
 *   o intervalo, o tick seguinte espera por ela.
 * - Não corre em NODE_ENV=test. Os testes chamam o serviço directamente.
 * - Uma falha não se perde: fica no log, na métrica `zuno_job_failures_total`
 *   e no Sentry. Sem isto ia só para o stderr, pela biblioteca de cron.
 */
export function Job(expression: string, name: string): MethodDecorator {
  return (target, propertyKey, descriptor: PropertyDescriptor) => {
    const run = descriptor.value as (...args: unknown[]) => unknown;

    descriptor.value = async function (this: unknown, ...args: unknown[]) {
      if (process.env.NODE_ENV === 'test') {
        return;
      }

      try {
        await run.apply(this, args);
      } catch (error) {
        reportJobFailure(name, 'run', error);
      }
    };

    Cron(expression, { name, waitForCompletion: true })(
      target,
      propertyKey,
      descriptor,
    );
  };
}
