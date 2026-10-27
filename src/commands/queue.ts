import { QueueManager } from '@framework/queue';
import { stringOption } from '../args';
import { type CommandContext, defineCommand } from '../command';
import { failure, unsupported } from '../errors';
import { table } from '../output';
import { foreground, loadConfigOrFail } from './project';

/** Opens a QueueManager for inspection commands and guarantees its close. */
async function openQueue(
  context: CommandContext,
  options: Readonly<Record<string, string | boolean | undefined>>,
): Promise<QueueManager> {
  const config = await loadConfigOrFail(context);
  const queueUrl = context.project.queueUrl?.(config);
  if (!queueUrl) {
    throw unsupported('This command needs a queue configuration', 'Add a `queueUrl` hook to this project CLI adapter.');
  }
  return new QueueManager({
    url: queueUrl.url,
    prefix: queueUrl.prefix,
    queue: stringOption(options, 'queue') ?? queueUrl.queue,
  });
}

/** Positive integer option; undefined when absent, failure when malformed. */
function numberOption(
  options: Readonly<Record<string, string | boolean | undefined>>,
  name: string,
): number | undefined {
  const raw = stringOption(options, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw failure('INVALID_USAGE', `--${name} must be a positive integer`);
  return value;
}

function queueEnv(options: Readonly<Record<string, string | boolean | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  const queue = stringOption(options, 'queue');
  const concurrency = stringOption(options, 'concurrency');
  if (queue) env.QUEUE_NAME = queue;
  if (concurrency) {
    if (!/^\d{1,2}$/.test(concurrency))
      throw failure('INVALID_USAGE', '--concurrency must be a number between 1 and 99');
    env.QUEUE_CONCURRENCY = concurrency;
  }
  return env;
}

const queueOptions = [
  { name: 'queue', type: 'string', placeholder: '<name>', description: 'Queue to consume or inspect' },
  { name: 'concurrency', type: 'string', placeholder: '<n>', description: 'Parallel jobs (workers only)' },
] as const;

export const queueCommands = [
  defineCommand({
    name: 'queue:work',
    group: 'queue',
    status: 'implemented',
    description: 'Consume configured queues in the foreground (graceful SIGTERM/SIGINT drain)',
    options: queueOptions,
    requires: ['Redis (config redis.url)'],
    async run({ options }, context) {
      if (!context.project.tools.worker) {
        throw unsupported(
          '"queue:work" needs a worker entry point',
          'Add a `worker` tool to this project CLI adapter.',
        );
      }
      await loadConfigOrFail(context);
      return foreground([...context.project.tools.worker], context, queueEnv(options));
    },
  }),
  defineCommand({
    name: 'queue:status',
    group: 'queue',
    status: 'implemented',
    description: 'Show job counts per state and adapter health',
    options: [{ name: 'queue', type: 'string', placeholder: '<name>', description: 'Queue to inspect' }],
    requires: ['Redis (config redis.url)'],
    async run({ options }, context) {
      const config = await loadConfigOrFail(context);
      const queueUrl = context.project.queueUrl?.(config);
      if (!queueUrl) {
        throw unsupported(
          '"queue:status" needs a queue configuration',
          'Add a `queueUrl` hook to this project CLI adapter.',
        );
      }
      const manager = new QueueManager({
        url: queueUrl.url,
        prefix: queueUrl.prefix,
        queue: stringOption(options, 'queue') ?? queueUrl.queue,
      });
      try {
        const counts = await manager.counts();
        for (const line of table(
          Object.entries(counts).map(([state, count]) => ({ state, count })),
          ['state', 'count'],
        )) {
          context.print(line);
        }
        return { data: { queue: manager.options.queue, counts } };
      } finally {
        await manager.close();
      }
    },
  }),
  defineCommand({
    name: 'queue:failed',
    group: 'queue',
    status: 'implemented',
    description: 'List failed-job records (id, name, attempts, reason)',
    options: [
      { name: 'limit', type: 'string', placeholder: '<n>', description: 'Max rows (default 50)' },
      { name: 'queue', type: 'string', placeholder: '<name>', description: 'Queue to inspect' },
    ],
    requires: ['Redis (config redis.url)'],
    async run({ options }, context) {
      const limit = numberOption(options, 'limit') ?? 50;
      const manager = await openQueue(context, options);
      try {
        const failed = await manager.failed(limit, 0);
        for (const line of table(
          failed.map((job) => ({
            id: job.id,
            name: job.name,
            attempts: job.attempts,
            reason: job.failedReason ?? '',
          })),
          ['id', 'name', 'attempts', 'reason'],
        )) {
          context.print(line);
        }
        return { data: { failed } };
      } finally {
        await manager.close();
      }
    },
  }),
  defineCommand({
    name: 'queue:retry',
    group: 'queue',
    status: 'implemented',
    description: 'Re-queue one failed job (payload and idempotency unchanged)',
    arguments: [{ name: 'jobId', description: 'Failed job id', required: true }],
    requires: ['Redis (config redis.url)'],
    async run({ positionals }, context) {
      const id = positionals[0];
      if (!id) throw failure('INVALID_USAGE', 'Usage: queue:retry <jobId>');
      const manager = await openQueue(context, {});
      try {
        if (!(await manager.retry(id))) throw failure('QUEUE_JOB_NOT_FAILED', `No failed job "${id}"`);
        context.print(`Re-queued ${id}.`);
        return { data: { retried: id } };
      } finally {
        await manager.close();
      }
    },
  }),
  defineCommand({
    name: 'queue:retry-all',
    group: 'queue',
    status: 'implemented',
    description: 'Re-queue failed jobs oldest-first (bounded by --limit)',
    options: [{ name: 'limit', type: 'string', placeholder: '<n>', description: 'Max jobs (default 100)' }],
    requires: ['Redis (config redis.url)'],
    async run({ options }, context) {
      const manager = await openQueue(context, {});
      try {
        const replayed = await manager.retryAll(numberOption(options, 'limit') ?? 100);
        context.print(`Re-queued ${replayed} failed job(s).`);
        return { data: { replayed } };
      } finally {
        await manager.close();
      }
    },
  }),
  defineCommand({
    name: 'queue:forget',
    group: 'queue',
    status: 'implemented',
    description: 'Delete one failed-job record (keeps the queue running)',
    arguments: [{ name: 'jobId', description: 'Failed job id', required: true }],
    requires: ['Redis (config redis.url)'],
    async run({ positionals }, context) {
      const id = positionals[0];
      if (!id) throw failure('INVALID_USAGE', 'Usage: queue:forget <jobId>');
      const manager = await openQueue(context, {});
      try {
        if (!(await manager.forget(id))) throw failure('QUEUE_JOB_NOT_FAILED', `No failed job "${id}"`);
        context.print(`Removed ${id}.`);
        return { data: { forgotten: id } };
      } finally {
        await manager.close();
      }
    },
  }),
  defineCommand({
    name: 'queue:prune',
    group: 'queue',
    status: 'implemented',
    description: 'Remove terminal (failed/completed) records older than --hours',
    options: [
      { name: 'hours', type: 'string', placeholder: '<n>', description: 'Age threshold (default 168 = one week)' },
    ],
    requires: ['Redis (config redis.url)'],
    async run({ options }, context) {
      const hours = numberOption(options, 'hours') ?? 168;
      if (hours <= 0) throw failure('INVALID_USAGE', '--hours must be a positive number');
      const manager = await openQueue(context, {});
      try {
        const removed = await manager.prune(hours * 3_600_000);
        context.print(`Removed ${removed} terminal record(s).`);
        return { data: { removed } };
      } finally {
        await manager.close();
      }
    },
  }),
  defineCommand({
    name: 'queue:pause',
    group: 'queue',
    status: 'implemented',
    description: 'Pause consumption (workers finish in-flight jobs, then idle)',
    requires: ['Redis (config redis.url)'],
    async run(_input, context) {
      const manager = await openQueue(context, {});
      try {
        await manager.pause();
        context.print('Queue paused.');
        return { data: { paused: true } };
      } finally {
        await manager.close();
      }
    },
  }),
  defineCommand({
    name: 'queue:resume',
    group: 'queue',
    status: 'implemented',
    description: 'Resume consumption after queue:pause',
    requires: ['Redis (config redis.url)'],
    async run(_input, context) {
      const manager = await openQueue(context, {});
      try {
        await manager.resume();
        context.print('Queue resumed.');
        return { data: { paused: false } };
      } finally {
        await manager.close();
      }
    },
  }),
];
