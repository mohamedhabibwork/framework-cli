import { join } from 'node:path';
import { ExecutionContext } from '@framework/core';
import { createConnection, type DatabaseConnection, migrationStatus, runMigrations } from '@framework/database';
import { flag, stringOption } from '../args';
import { type CommandContext, defineCommand } from '../command';
import { failure, usageError } from '../errors';
import { table } from '../output';
import { runProcess, tail } from '../process';

const DRIZZLE_TIMEOUT_MS = 120_000;
/** runMigrations holds one connection for the advisory lock while the migrator uses another. */
const MIGRATION_POOL_SIZE = 2;
const MIGRATION_NAME = /^[a-z0-9][a-z0-9-_]{0,62}$/;

async function withConnection<T>(
  context: CommandContext,
  work: (connection: DatabaseConnection) => Promise<T>,
): Promise<T> {
  const config = await context.project.loadConfig(context.envFile);
  const connection = createConnection({
    url: context.project.databaseUrl(config),
    maxConnections: MIGRATION_POOL_SIZE,
    connectTimeoutSeconds: 10,
  });
  try {
    return await work(connection);
  } finally {
    await connection.close();
  }
}

/** Delegates schema diffing to the pinned Drizzle Kit (no database connection). */
export async function drizzleGenerate(context: CommandContext, name: string | undefined): Promise<string> {
  if (name !== undefined && !MIGRATION_NAME.test(name)) {
    throw usageError('--name must be lowercase letters, digits, "-" or "_"');
  }
  const result = await runProcess(
    [...context.project.tools.drizzleKit, 'generate', ...(name ? ['--name', name] : [])],
    {
      cwd: context.root,
      timeoutMs: DRIZZLE_TIMEOUT_MS,
      signal: context.signal,
      stream: context.verbose,
    },
  );
  if (result.exitCode !== 0) {
    throw failure('DB_GENERATE_FAILED', 'drizzle-kit generate failed', tail(`${result.stdout}\n${result.stderr}`));
  }
  return result.stdout;
}

export const databaseCommands = [
  defineCommand({
    name: 'db:generate',
    group: 'database',
    status: 'implemented',
    description: 'Generate a reviewed SQL migration from schema changes (pinned Drizzle Kit)',
    options: [{ name: 'name', type: 'string', placeholder: '<name>', description: 'Migration name' }],
    async run({ options }, context) {
      const output = await drizzleGenerate(context, stringOption(options, 'name'));
      const files = [...output.matchAll(/migrations\/([\w-]+\.sql)/g)].map((m) => m[1]);
      context.print(files.length ? `Generated: ${files.join(', ')}` : 'No schema changes detected.');
      return { data: { files } };
    },
  }),
  defineCommand({
    name: 'db:migrate',
    group: 'database',
    status: 'implemented',
    description: 'Apply pending migrations under an advisory lock (explicit release step)',
    requires: ['PostgreSQL connection'],
    async run(_input, context) {
      const folder = join(context.root, context.project.paths.migrations);
      const states = await withConnection(context, async (connection) => {
        await runMigrations(connection, folder);
        return migrationStatus(connection, folder);
      });
      context.print(`Applied. ${states.filter((s) => s.applied).length}/${states.length} migrations are recorded.`);
      return { data: { migrations: states } };
    },
  }),
  defineCommand({
    name: 'db:status',
    group: 'database',
    status: 'implemented',
    description: 'Show applied and pending migrations',
    requires: ['PostgreSQL connection'],
    async run(_input, context) {
      const folder = join(context.root, context.project.paths.migrations);
      const states = await withConnection(context, (connection) => migrationStatus(connection, folder));
      for (const line of table(
        states.map((s) => ({ migration: s.tag, state: s.applied ? 'applied' : 'pending' })),
        ['migration', 'state'],
      ))
        context.print(line);
      return { data: { migrations: states, pending: states.filter((s) => !s.applied).length } };
    },
  }),
  defineCommand({
    name: 'db:check',
    group: 'database',
    status: 'implemented',
    description: 'Validate migration metadata consistency (drizzle-kit check)',
    async run(_input, context) {
      const result = await runProcess([...context.project.tools.drizzleKit, 'check'], {
        cwd: context.root,
        timeoutMs: DRIZZLE_TIMEOUT_MS,
        signal: context.signal,
      });
      if (result.exitCode !== 0)
        throw failure('DB_CHECK_FAILED', 'Migration metadata check failed', tail(result.stdout + result.stderr));
      context.print('Migration metadata is consistent.');
      return { data: { consistent: true } };
    },
  }),
  defineCommand({
    name: 'db:fresh',
    group: 'database',
    status: 'implemented',
    description: 'Drop every table in the public schema and re-run all migrations (destructive)',
    options: [{ name: 'force', type: 'boolean', description: 'Override the production guard' }],
    requires: ['PostgreSQL connection'],
    async run(_input, context) {
      const config = await context.project.loadConfig(context.envFile);
      const env = (config as { app?: { env?: string } }).app?.env;
      if (env === 'production' && !flag(_input.options, 'force')) {
        throw failure(
          'PRODUCTION_TARGET',
          '"db:fresh" refuses to drop a production database',
          'Development and test targets only; pass --force to override deliberately.',
        );
      }
      const folder = join(context.root, context.project.paths.migrations);
      const states = await withConnection(context, async (connection) => {
        // Drop everything including the drizzle journal, then re-run the
        // full journal forward — a half-fresh state (empty public, applied
        // journal) would otherwise skip every migration.
        await connection.sql`drop schema public cascade`;
        await connection.sql`drop schema if exists drizzle cascade`;
        await connection.sql`create schema public`;
        await connection.sql`create schema if not exists drizzle`;
        await connection.sql`create extension if not exists "pgcrypto"`;
        await runMigrations(connection, folder);
        return migrationStatus(connection, folder);
      });
      context.print(
        `Fresh schema applied. ${states.filter((s) => s.applied).length}/${states.length} migrations recorded.`,
      );
      return { data: { migrations: states } };
    },
  }),
  defineCommand({
    name: 'db:seed',
    group: 'database',
    status: 'implemented',
    description: 'Run registered seeders (all, or one by name)',
    arguments: [{ name: 'seeder', description: 'Seeder name; omit for all', required: false }],
    requires: ['PostgreSQL connection', 'A `seeders` hook in the project CLI adapter'],
    async run({ positionals }, context) {
      if (!context.project.seeders) {
        throw failure(
          'SEEDERS_HOOK_MISSING',
          '"db:seed" needs the application\'s seeder registry',
          'Add a `seeders` hook returning the registered seeders to this project CLI adapter.',
        );
      }
      const wanted = positionals[0];
      const all = await context.project.seeders();
      if (all.length === 0) throw failure('SEEDERS_EMPTY', 'No seeders are registered');
      const selected = wanted ? all.filter((seeder) => seeder.name === wanted) : all;
      if (wanted && selected.length === 0) {
        throw failure(
          'SEEDER_UNKNOWN',
          `No seeder named "${wanted}"`,
          `Registered: ${all.map((seeder) => seeder.name).join(', ')}`,
        );
      }
      const execution = new ExecutionContext('command', `seed-${Date.now()}`, { id: null, type: 'system' });
      const ran: string[] = [];
      for (const seeder of selected) {
        await seeder.run({ execution, log: (message: string) => context.print(message) });
        ran.push(seeder.name);
        context.print(`Seeded ${seeder.name}.`);
      }
      return { data: { seeders: ran } };
    },
  }),
];
