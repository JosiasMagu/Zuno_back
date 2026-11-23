import { Cron } from '@nestjs/schedule';

/**
 * Um job agendado que nunca corre por cima de si próprio: se uma execução
 * demorar mais do que o intervalo, o tick seguinte espera por ela.
 */
export const Job = (expression: string, name: string) =>
  Cron(expression, { name, waitForCompletion: true });
