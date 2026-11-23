import {
  CronExpression,
  ScheduleModule,
  SchedulerRegistry,
} from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { SCHEDULE_CRON_OPTIONS } from '@nestjs/schedule/dist/schedule.constants';

import { Job } from './job.decorator';
import { jobFailuresTotal } from './job-failures';

const ran = jest.fn();

class SomeScheduler {
  @Job(CronExpression.EVERY_MINUTE, 'um-job')
  async run() {
    await ran();
  }
}

const failuresOf = async (job: string) => {
  const { values } = await jobFailuresTotal.get();
  return values.find((value) => value.labels.job === job)?.value ?? 0;
};

describe('@Job', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = 'development';
  });

  afterEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = originalNodeEnv;
  });

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

  it('fica registado no Nest e corre quando o relógio dispara', async () => {
    const module = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [SomeScheduler],
    }).compile();
    await module.init();

    await module.get(SchedulerRegistry).getCronJob('um-job').fireOnTick();
    await module.close();

    expect(ran).toHaveBeenCalledTimes(1);
  });

  it('corre o método', async () => {
    await new SomeScheduler().run();

    expect(ran).toHaveBeenCalledTimes(1);
  });

  it('não corre em NODE_ENV=test', async () => {
    process.env.NODE_ENV = 'test';

    await new SomeScheduler().run();

    expect(ran).not.toHaveBeenCalled();
  });

  it('conta a falha e não a deixa sair para a biblioteca de cron', async () => {
    ran.mockRejectedValue(new Error('a base caiu'));
    const before = await failuresOf('um-job');

    await expect(new SomeScheduler().run()).resolves.toBeUndefined();

    expect(await failuresOf('um-job')).toBe(before + 1);
  });
});
