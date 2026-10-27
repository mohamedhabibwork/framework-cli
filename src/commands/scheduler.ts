import { QueueManager } from '@framework/queue';
import { Scheduler } from '@framework/scheduler';
import { stringOption } from '../args';
import { type CommandContext, defineCommand } from '../command';
import { failure, unsupported } from '../errors';
import { table } from '../output';
import { foreground, loadConfigOrFail } from './project';

/** Schedule-fire queue coordinates from the project adapter (or a hard failure). */
async function schedulerFor(context: CommandContext): Promise<{ scheduler: Scheduler; close(): Promise<void> }> {
  const config = await loadConfigOrFail(context);
  const queueUrl = context.project.queueUrl?.(config);
  if (!queueUrl) {
    throw unsupported(
      '"schedule:*" commands need a queue configuration',
      'Add a `queueUrl` hook to this project CLI adapter.',
    );
  }
  // Fires live on a dedicated queue (BullMQ forbids ':' in names) only the
  // scheduler process consumes.
  const queue = new QueueManager({
    url: queueUrl.url,
    prefix: queueUrl.prefix,
    queue: `${queueUrl.queue ?? 'default'}-schedules`,
  });
  return { scheduler: new Scheduler(queue), close: () => queue.close() };
}

export const schedulerCommands = [
  defineCommand({
    name: 'schedule:list',
    group: 'scheduler',
    status: 'implemented',
    description: 'Registered timetables with their next due run',
    requires: ['Redis (config redis.url)'],
    async run(_input, context) {
      const { scheduler, close } = await schedulerFor(context);
      try {
        const descriptors = await scheduler.descriptors();
        for (const line of table(
          descriptors.map((descriptor) => ({
            id: descriptor.id,
            nextRun: descriptor.nextRun ? new Date(descriptor.nextRun).toISOString() : '-',
          })),
          ['id', 'nextRun'],
        )) {
          context.print(line);
        }
        return { data: descriptors };
      } finally {
        await close();
      }
    },
  }),
  defineCommand({
    name: 'schedule:run',
    group: 'scheduler',
    status: 'implemented',
    description: 'Fire a schedule immediately (the scheduler process resolves its target)',
    arguments: [{ name: 'name', description: 'Schedule name', required: true }],
    requires: ['Redis (config redis.url)'],
    async run({ positionals }, context) {
      const name = positionals[0];
      if (!name) throw failure('INVALID_USAGE', 'Usage: schedule:run <name>');
      const { scheduler, close } = await schedulerFor(context);
      try {
        await scheduler.fireNow(name, `schedule-run-${crypto.randomUUID()}`);
        context.print(`fire queued for "${name}"`);
        return { data: { schedule: name, queued: true } };
      } finally {
        await close();
      }
    },
  }),
  defineCommand({
    name: 'schedule:work',
    group: 'scheduler',
    status: 'implemented',
    description: 'Run the scheduler process: sync timetables, consume due fires (graceful drain)',
    options: [{ name: 'concurrency', type: 'string', placeholder: '<n>', description: 'Parallel fire handlers' }],
    requires: ['Redis (config redis.url)'],
    async run({ options }, context) {
      if (!context.project.tools.scheduler) {
        throw unsupported(
          '"schedule:work" needs a scheduler entry point',
          'Add a `scheduler` tool to this project CLI adapter.',
        );
      }
      await loadConfigOrFail(context);
      const env: Record<string, string> = {};
      const concurrency = stringOption(options, 'concurrency');
      if (concurrency) {
        if (!/^\d{1,2}$/.test(concurrency)) throw failure('INVALID_USAGE', '--concurrency must be 1-99');
        env.SCHEDULE_CONCURRENCY = concurrency;
      }
      return foreground([...context.project.tools.scheduler], context, env);
    },
  }),
  defineCommand({
    name: 'schedule:test',
    group: 'scheduler',
    status: 'implemented',
    description: 'Alias of schedule:run — execute a schedule now to verify its wiring',
    arguments: [{ name: 'name', description: 'Schedule name', required: true }],
    requires: ['Redis (config redis.url)'],
    async run({ positionals }, context) {
      const name = positionals[0];
      if (!name) throw failure('INVALID_USAGE', 'Usage: schedule:test <name>');
      const { scheduler, close } = await schedulerFor(context);
      try {
        await scheduler.fireNow(name, `schedule-test-${crypto.randomUUID()}`);
        context.print(`test fire queued for "${name}"`);
        return { data: { schedule: name, queued: true, test: true } };
      } finally {
        await close();
      }
    },
  }),
];
