import { CronExpression } from '@nestjs/schedule';
import { SCHEDULE_CRON_OPTIONS } from '@nestjs/schedule/dist/schedule.constants';

import { Job } from './job.decorator';

class SomeScheduler {
  @Job(CronExpression.EVERY_MINUTE, 'um-job')
  run() {}
}

describe('@Job', () => {
  it('agenda o método com o nome dado e sem execuções sobrepostas', () => {
    const options = Reflect.getMetadata(
      SCHEDULE_CRON_OPTIONS,
      SomeScheduler.prototype.run,
    ) as Record<string, unknown>;

    expect(options).toMatchObject({
      cronTime: CronExpression.EVERY_MINUTE,
      name: 'um-job',
      waitForCompletion: true,
    });
  });
});
