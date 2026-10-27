import { createConnection, type DatabaseConnection } from '@framework/database';
import { QueueManager } from '@framework/queue';
import { WorkflowManager, WorkflowStore } from '@framework/workflow';
import { type OptionSpec, stringOption } from '../args';
import { type CommandContext, defineCommand } from '../command';
import { failure, unsupported } from '../errors';
import { table } from '../output';
import { loadConfigOrFail } from './project';

interface WorkflowCli {
  readonly manager: WorkflowManager;
  close(): Promise<void>;
}

/**
 * Opens a short-lived database (and, for dispatching, queue) connection to
 * drive the workflow engine from the shell. Applications register their
 * workflows on workers, so mutating commands here only touch run state.
 */
async function withWorkflow(context: CommandContext, options: { dispatch?: boolean } = {}): Promise<WorkflowCli> {
  const config = await loadConfigOrFail(context);
  let database: DatabaseConnection | null = null;
  let queue: QueueManager | null = null;
  try {
    database = createConnection({ url: context.project.databaseUrl(config), maxConnections: 2 });
    const store = new WorkflowStore(database.db);
    if (options.dispatch) {
      const queueUrl = context.project.queueUrl?.(config);
      if (!queueUrl) {
        throw unsupported(
          'This command needs to enqueue workflow jobs',
          'Add a `queueUrl` hook to this project CLI adapter.',
        );
      }
      queue = new QueueManager({ url: queueUrl.url, prefix: queueUrl.prefix, queue: queueUrl.queue });
    }
    const manager = new WorkflowManager(store, queue, null);
    return {
      manager,
      close: async () => {
        await queue?.close();
        await database?.close();
      },
    };
  } catch (error) {
    await queue?.close();
    await database?.close();
    throw error;
  }
}

const limitOption: readonly OptionSpec[] = [
  { name: 'limit', type: 'string', placeholder: '<n>', description: 'Rows per page (max 100)' },
];

export const workflowCommands = [
  defineCommand({
    name: 'workflow:list',
    group: 'workflow',
    status: 'implemented',
    description: 'Paginated workflow runs with status and workflow filters',
    options: [
      ...limitOption,
      { name: 'workflow', type: 'string', placeholder: '<name>', description: 'Filter by workflow name' },
      {
        name: 'status',
        type: 'string',
        placeholder: '<status>',
        description: 'pending|running|waiting|completed|failed|cancelled|compensating|compensated',
      },
    ],
    requires: ['PostgreSQL (config database.url)'],
    async run({ options }, context) {
      const cli = await withWorkflow(context);
      try {
        const limit = Number(stringOption(options, 'limit') ?? 20);
        const page = await cli.manager.list({
          page: 1,
          limit: Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : 20,
          workflow: stringOption(options, 'workflow'),
          status: stringOption(options, 'status') as never,
        });
        for (const line of table(
          page.items.map((run) => ({
            id: run.id.slice(0, 8),
            workflow: run.workflow,
            status: run.status,
            correlation: run.correlationId,
            started: run.startedAt ?? '-',
          })),
          ['id', 'workflow', 'status', 'correlation', 'started'],
        )) {
          context.print(line);
        }
        context.print(`page ${page.meta.page} of ${page.meta.totalPages} (${page.meta.total} runs)`);
        return { data: page };
      } finally {
        await cli.close();
      }
    },
  }),
  defineCommand({
    name: 'workflow:status',
    group: 'workflow',
    status: 'implemented',
    description: 'One run with its full node tree (pipelines, stages, actions)',
    arguments: [{ name: 'runId', description: 'Run id (uuid) or id prefix', required: true }],
    requires: ['PostgreSQL (config database.url)'],
    async run({ positionals }, context) {
      const runId = positionals[0];
      if (!runId) throw failure('INVALID_USAGE', 'Usage: workflow:status <runId>');
      const cli = await withWorkflow(context);
      try {
        const status = await cli.manager.status(runId);
        if (!status) throw failure('NOT_FOUND', `Run "${runId}" does not exist`);
        for (const line of table(
          status.nodes.map((node) => ({
            path: node.path,
            kind: node.kind,
            status: node.status,
            attempts: `${node.attempts}/${node.maxAttempts}`,
            error: node.error ?? '-',
          })),
          ['path', 'kind', 'status', 'attempts', 'error'],
        )) {
          context.print(line);
        }
        return { data: status };
      } finally {
        await cli.close();
      }
    },
  }),
  defineCommand({
    name: 'workflow:retry',
    group: 'workflow',
    status: 'implemented',
    description: 'Re-run a failed run from its failure point (or --from a node path)',
    arguments: [{ name: 'runId', description: 'Run id (uuid)', required: true }],
    options: [{ name: 'from', type: 'string', placeholder: '<node path>', description: 'Node path to retry from' }],
    requires: ['PostgreSQL (config database.url)', 'Redis (config redis.url)'],
    async run({ positionals, options }, context) {
      const runId = positionals[0];
      if (!runId) throw failure('INVALID_USAGE', 'Usage: workflow:retry <runId> [--from <node path>]');
      const cli = await withWorkflow(context, { dispatch: true });
      try {
        const done = await cli.manager.retry(runId, { fromNode: stringOption(options, 'from') });
        if (!done) throw failure('NOT_FOUND', 'Run not found or not in a retryable state');
        context.print(`run ${runId} restarted`);
        return { data: { runId, restarted: true } };
      } finally {
        await cli.close();
      }
    },
  }),
  defineCommand({
    name: 'workflow:cancel',
    group: 'workflow',
    status: 'implemented',
    description: 'Cancel a pending, running or waiting run',
    arguments: [{ name: 'runId', description: 'Run id (uuid)', required: true }],
    requires: ['PostgreSQL (config database.url)'],
    async run({ positionals }, context) {
      const runId = positionals[0];
      if (!runId) throw failure('INVALID_USAGE', 'Usage: workflow:cancel <runId>');
      const cli = await withWorkflow(context);
      try {
        if (!(await cli.manager.cancel(runId))) {
          throw failure('NOT_FOUND', 'Run not found or already terminal');
        }
        context.print(`run ${runId} cancelled`);
        return { data: { runId, cancelled: true } };
      } finally {
        await cli.close();
      }
    },
  }),
  defineCommand({
    name: 'workflow:prune',
    group: 'workflow',
    status: 'implemented',
    description: 'Delete terminal runs older than the retention window',
    options: [{ name: 'days', type: 'string', placeholder: '<n>', description: 'Retention in days (default 7)' }],
    requires: ['PostgreSQL (config database.url)'],
    async run({ options }, context) {
      const raw = Number(stringOption(options, 'days') ?? 7);
      if (!Number.isInteger(raw) || raw < 1) throw failure('INVALID_USAGE', '--days must be a positive integer');
      const cli = await withWorkflow(context);
      try {
        const removed = await cli.manager.prune(raw);
        context.print(`removed ${removed} run(s) older than ${raw} day(s)`);
        return { data: { removed } };
      } finally {
        await cli.close();
      }
    },
  }),
];
