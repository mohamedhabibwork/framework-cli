import { dirname, join, resolve } from 'node:path';
import { flag, type OptionSpec, stringOption } from '../args';
import { type CommandContext, defineCommand } from '../command';
import { usageError } from '../errors';
import { planAuth } from '../generators/auth/generate';
import { applyChanges, describeChanges } from '../generators/plan';
import { drizzleGenerate } from './database';
import { snapshotFolder } from './generators';

const GUARDS = ['session', 'api-token'] as const;

function parseGuards(value: string | undefined): readonly string[] {
  if (!value) return [...GUARDS];
  const guards = [
    ...new Set(
      value
        .split(',')
        .map((g) => g.trim())
        .filter(Boolean),
    ),
  ];
  if (guards.length === 0) throw usageError('--guards is empty; expected session and/or api-token');
  for (const guard of guards) {
    if (!(GUARDS as readonly string[]).includes(guard)) {
      throw usageError(`Unknown guard "${guard}"; expected ${GUARDS.join(' and/or ')}`);
    }
  }
  return guards;
}

/** Nearest enclosing framework workspace (a directory owning packages/cli), if any. */
async function frameworkWorkspaceRoot(from: string): Promise<string | null> {
  let current = resolve(from);
  for (;;) {
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
    if (await Bun.file(join(current, 'packages/cli/package.json')).exists()) return current;
  }
}

/** Installs the new workspace dependency; diagnostics go to stderr only. */
async function runInstall(cwd: string, context: CommandContext): Promise<void> {
  const child = Bun.spawn(['bun', 'install'], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  for (const line of `${out}${err}`.split('\n').filter(Boolean)) context.log(line);
  if (code !== 0) throw new Error(`bun install exited with code ${code}`);
}

const AUTH_OPTIONS: readonly OptionSpec[] = [
  {
    name: 'guards',
    type: 'string',
    placeholder: '<list>',
    description: 'Enabled guards, comma separated (default: session,api-token)',
  },
  { name: 'dry-run', type: 'boolean', description: 'Preview changes and migration plan; write nothing' },
  { name: 'force', type: 'boolean', description: 'Overwrite generator-owned files of the auth module' },
];

export const authCommands = [
  defineCommand({
    name: 'make:auth',
    group: 'generators',
    status: 'implemented',
    description: 'Session + personal API token auth: module, registrations, dependency and migration',
    options: AUTH_OPTIONS,
    requires: ['migration generation: drizzle-kit (db:generate)'],
    examples: ['make:auth', 'make:auth --guards session', 'make:auth --guards session,api-token --dry-run'],
    async run({ options }, context) {
      const guards = parseGuards(stringOption(options, 'guards'));
      const plan = await planAuth(context, guards, flag(options, 'force'));
      const summary = {
        module: 'auth',
        guards,
        changes: plan.changes.map((c) => ({ path: c.path, action: c.action })),
        migration: plan.migrationName,
      };

      if (flag(options, 'dry-run')) {
        context.print(`Dry run: auth module (${guards.join(' + ')}) (no files written)`);
        for (const line of describeChanges(plan.changes)) context.print(line);
        context.print('  install    bun install (adds @framework/auth)');
        context.print(`  migrate    drizzle-kit generate --name ${plan.migrationName}`);
        return { data: { dryRun: true, ...summary } };
      }

      const applied = await applyChanges(context.root, plan.changes);
      const migrations = await snapshotFolder(join(context.root, context.project.paths.migrations));
      try {
        const workspace = await frameworkWorkspaceRoot(context.root);
        context.print('Installing @framework/auth (through the framework workspace when inside one)...');
        await runInstall(workspace ?? context.root, context);
        await drizzleGenerate(context, plan.migrationName);
      } catch (error) {
        await migrations.restore();
        await applied.rollback();
        throw error;
      }
      context.print(`  dependency @framework/auth installed`);
      context.print(`  migration  ${plan.migrationName} generated (review before db:migrate)`);
      for (const line of describeChanges(plan.changes)) context.print(line);
      return {
        data: { generation: { status: 'generated' as const, ...summary } },
        warnings: ['Run `bun run cli -- db:migrate` to apply the auth tables before serving requests.'],
      };
    },
  }),
];
