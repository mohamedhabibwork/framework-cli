import { redact } from '@framework/core';
import { createConnection, pingDatabase } from '@framework/database';
import { flag, stringOption } from '../args';
import { type CommandContext, defineCommand } from '../command';
import { failure, unsupported, usageError } from '../errors';
import { table } from '../output';
import type { ObservatoryHandle } from '../project';
import { helpText } from '../run';

async function loadConfigOrFail(context: CommandContext): Promise<unknown> {
  try {
    return await context.project.loadConfig(context.envFile);
  } catch (error) {
    throw failure('CONFIG_INVALID', error instanceof Error ? error.message : 'Invalid configuration', undefined, error);
  }
}

/** Runs a long-lived delegated process in the foreground, forwarding interrupts. */
export async function foreground(command: readonly string[], context: CommandContext, env: Record<string, string>) {
  const child = Bun.spawn([...command], {
    cwd: context.root,
    env: { ...process.env, ...env },
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  const forward = () => child.kill('SIGINT');
  context.signal.addEventListener('abort', forward, { once: true });
  const code = await child.exited;
  if (code !== 0 && !context.signal.aborted) throw failure('PROCESS_FAILED', `${command[0]} exited with code ${code}`);
  return { data: { exitCode: code } };
}

function hostPortEnv(options: Readonly<Record<string, string | boolean | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  const host = stringOption(options, 'host');
  const port = stringOption(options, 'port');
  if (host) env.HTTP_HOST = host;
  if (port) {
    if (!/^\d{1,5}$/.test(port)) throw usageError('--port must be a number');
    env.HTTP_PORT = port;
  }
  return env;
}

const hostPortOptions = [
  { name: 'host', type: 'string', placeholder: '<host>', description: 'Bind address' },
  { name: 'port', type: 'string', placeholder: '<port>', description: 'Listen port' },
] as const;

export { loadConfigOrFail };

/** Provider names and redirects only, because a provider's section holds its secrets. */
export function socialProviders(config: unknown): readonly { provider: string; redirect: string | null }[] {
  const section = (config as { socialite?: { providers?: object; redirects?: Record<string, string> } }).socialite;
  return Object.keys(section?.providers ?? {}).map((provider) => ({
    provider,
    redirect: section?.redirects?.[provider] ?? null,
  }));
}

const MS_PER_HOUR = 3_600_000;
const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_PRUNE_HOURS = 24;

async function withObservatory<T>(
  context: CommandContext,
  command: string,
  run: (handle: ObservatoryHandle) => Promise<T>,
): Promise<T> {
  if (!context.project.observatory) {
    throw unsupported(
      `"${command}" needs access to the observatory store`,
      'Add an `observatory(config)` hook to this project CLI adapter, or install @framework/observatory.',
    );
  }
  const handle = await context.project.observatory(await loadConfigOrFail(context));
  try {
    return await run(handle);
  } finally {
    await handle.close();
  }
}

const positiveNumber = (value: string | undefined, name: string, fallback: number): number => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw usageError(`--${name} must be a positive number`);
  return parsed;
};

export const projectCommands = [
  defineCommand({
    name: 'permission:sync',
    group: 'project',
    status: 'implemented',
    description: 'Make the database roles hold exactly the permissions in config (--confirm required)',
    options: [{ name: 'confirm', type: 'boolean', description: 'Confirm changing role permissions' }],
    async run({ options }, context) {
      if (!flag(options, 'confirm')) {
        throw usageError('"permission:sync" can remove permissions from live roles; pass --confirm');
      }
      if (!context.project.authorization) {
        throw unsupported(
          '"permission:sync" needs access to the role store',
          'Add an `authorization(config)` hook to this project CLI adapter, or install @framework/authorization.',
        );
      }
      const handle = await context.project.authorization(await loadConfigOrFail(context));
      try {
        const result = await handle.sync();
        context.print(`Synced ${result.roles} role(s): ${result.added} added, ${result.removed} removed.`);
        return { data: result };
      } finally {
        await handle.close();
      }
    },
  }),
  defineCommand({
    name: 'observatory:list',
    group: 'observatory',
    status: 'implemented',
    description: 'List recent observatory entries',
    options: [
      { name: 'watcher', type: 'string', description: 'Only this watcher (request, query, job, ...)' },
      { name: 'limit', type: 'string', description: `Most entries to show (default: ${DEFAULT_LIST_LIMIT})` },
    ],
    async run({ options }, context) {
      const watcher = stringOption(options, 'watcher');
      const limit = positiveNumber(stringOption(options, 'limit'), 'limit', DEFAULT_LIST_LIMIT);
      const entries = await withObservatory(context, 'observatory:list', (handle) =>
        handle.query({ ...(watcher ? { watcher } : {}), limit }),
      );
      for (const entry of entries) {
        context.print(`${entry.occurredAt}  ${entry.watcher}  ${entry.status}  ${entry.summary}`);
      }
      if (entries.length === 0) context.print('No observatory entries.');
      return { data: { entries } };
    },
  }),
  defineCommand({
    name: 'observatory:prune',
    group: 'observatory',
    status: 'implemented',
    description: 'Prune observatory entries older than a number of hours',
    options: [
      { name: 'hours', type: 'string', description: `Keep this many recent hours (default: ${DEFAULT_PRUNE_HOURS})` },
    ],
    async run({ options }, context) {
      const hours = positiveNumber(stringOption(options, 'hours'), 'hours', DEFAULT_PRUNE_HOURS);
      const before = new Date(Date.now() - hours * MS_PER_HOUR);
      const removed = await withObservatory(context, 'observatory:prune', (handle) => handle.prune(before));
      context.print(`Removed ${removed} observatory entries.`);
      return { data: { removed } };
    },
  }),
  defineCommand({
    name: 'observatory:clear',
    group: 'observatory',
    status: 'implemented',
    description: 'Clear all observatory entries (--confirm required)',
    options: [{ name: 'confirm', type: 'boolean', description: 'Confirm deleting every entry' }],
    async run({ options }, context) {
      if (!flag(options, 'confirm')) throw usageError('"observatory:clear" deletes every entry; pass --confirm');
      await withObservatory(context, 'observatory:clear', (handle) => handle.clear());
      context.print('Cleared the observatory.');
      return { data: { cleared: true } };
    },
  }),
  defineCommand({
    name: 'socialite:providers',
    group: 'socialite',
    status: 'implemented',
    description: 'List configured social login providers',
    async run(_input, context) {
      const providers = socialProviders(await loadConfigOrFail(context));
      for (const { provider, redirect } of providers) context.print(`${provider}  ${redirect ?? '(no redirect)'}`);
      if (providers.length === 0) context.print('No social login providers are configured.');
      return { data: { providers } };
    },
  }),
  defineCommand({
    name: 'help',
    group: 'project',
    status: 'implemented',
    description: 'Show help for a command, or a summary of all commands',
    arguments: [{ name: 'command', description: 'Command name', required: false }],
    async run({ positionals }, context) {
      const target = positionals[0];
      if (target) {
        const command = context.registry.get(target);
        if (!command) throw usageError(`Unknown command "${target}"`);
        const usage = helpText(command);
        for (const line of usage) context.print(line);
        return { data: { usage } };
      }
      const lines = [
        'Usage: <command> [arguments] [options]',
        '',
        ...context.registry
          .all()
          .filter((c) => c.status !== 'planned')
          .map((c) => `  ${c.name.padEnd(22)}${c.description}`),
        '',
        'Run `list` to include planned commands, or `help <command>` for details.',
      ];
      for (const line of lines) context.print(line);
      return { data: { usage: lines } };
    },
  }),
  defineCommand({
    name: 'list',
    group: 'project',
    status: 'implemented',
    description: 'List commands with their group and availability (planned/implemented/validated)',
    async run(_input, context) {
      const rows = context.registry
        .all()
        .map((c) => ({ name: c.name, group: c.group, status: c.status, description: c.description }));
      for (const line of table(rows, ['name', 'group', 'status', 'description'])) context.print(line);
      return { data: { commands: rows } };
    },
  }),
  defineCommand({
    name: 'config:check',
    group: 'project',
    status: 'implemented',
    description: 'Validate configuration without starting HTTP or workers',
    async run(_input, context) {
      await loadConfigOrFail(context);
      context.print('Configuration is valid.');
      return { data: { valid: true } };
    },
  }),
  defineCommand({
    name: 'config:show',
    group: 'project',
    status: 'implemented',
    description: 'Show resolved configuration with secrets redacted',
    arguments: [{ name: 'key', description: 'Dot path such as http.port', required: false }],
    async run({ positionals }, context) {
      const config = redact(await loadConfigOrFail(context)) as Record<string, unknown>;
      const key = positionals[0];
      let value: unknown = config;
      for (const segment of key ? key.split('.') : []) {
        if (value === null || typeof value !== 'object' || !(segment in value)) {
          throw usageError(`Unknown configuration key "${key}"`);
        }
        value = (value as Record<string, unknown>)[segment];
      }
      context.print(JSON.stringify(value, null, 2));
      return { data: key ? { [key]: value } : value };
    },
  }),
  defineCommand({
    name: 'doctor',
    group: 'project',
    status: 'implemented',
    description: 'Validate configuration and, with --connections, database connectivity',
    options: [{ name: 'connections', type: 'boolean', description: 'Probe external connections' }],
    async run({ options }, context) {
      const config = await loadConfigOrFail(context);
      const checks: Record<string, string> = { configuration: 'ok' };
      if (options.connections === true) {
        const connection = createConnection({
          url: context.project.databaseUrl(config),
          maxConnections: 1,
          connectTimeoutSeconds: 5,
        });
        try {
          checks.database = (await pingDatabase(connection)) ? 'ok' : 'unreachable';
        } finally {
          await connection.close();
        }
      }
      for (const [name, status] of Object.entries(checks)) context.print(`${name.padEnd(16)}${status}`);
      if (Object.values(checks).some((status) => status !== 'ok')) {
        throw failure('DOCTOR_FAILED', 'One or more checks failed', 'Is PostgreSQL running? Try `bun run db:up`.');
      }
      return { data: checks };
    },
  }),
  defineCommand({
    name: 'module:list',
    group: 'project',
    status: 'implemented',
    description: 'Show explicitly registered providers/modules',
    async run(_input, context) {
      const providers = context.project.providers();
      for (const name of providers) context.print(name);
      return { data: { providers } };
    },
  }),
  defineCommand({
    name: 'route:list',
    group: 'project',
    status: 'implemented',
    description: 'Show the registered route table',
    options: [
      { name: 'method', type: 'string', placeholder: '<method>', description: 'Filter by HTTP method' },
      { name: 'path', type: 'string', placeholder: '<fragment>', description: 'Filter by path fragment' },
    ],
    async run({ options }, context) {
      const method = stringOption(options, 'method')?.toUpperCase();
      const path = stringOption(options, 'path');
      const routes = (await context.project.routes(await loadConfigOrFail(context))).filter(
        (route) => (!method || route.method === method) && (!path || route.path.includes(path)),
      );
      for (const line of table(
        routes.map((r) => ({ method: r.method, path: r.path, handlers: r.handlers })),
        ['method', 'path', 'handlers'],
      ))
        context.print(line);
      return { data: { routes } };
    },
  }),
  defineCommand({
    name: 'middleware:list',
    group: 'project',
    status: 'implemented',
    description: 'Show registered middleware aliases and groups',
    async run(_input, context) {
      const middleware = context.project.middleware();
      for (const line of table(
        middleware.map((m) => ({ name: m.name, kind: m.kind, members: (m.members ?? []).join(', ') })),
        ['name', 'kind', 'members'],
      ))
        context.print(line);
      return { data: { middleware } };
    },
  }),
  defineCommand({
    name: 'serve',
    group: 'project',
    status: 'implemented',
    description: 'Start the configured HTTP runtime',
    options: hostPortOptions,
    run: ({ options }, context) => foreground(context.project.tools.serve, context, hostPortEnv(options)),
  }),
  defineCommand({
    name: 'dev',
    group: 'project',
    status: 'implemented',
    description: "Start the runtime's development watcher",
    options: hostPortOptions,
    run: ({ options }, context) => foreground(context.project.tools.dev, context, hostPortEnv(options)),
  }),
];
