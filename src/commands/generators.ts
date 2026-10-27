import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { flag, type OptionSpec, type OptionValues, stringOption } from '../args';
import { type CommandContext, type CommandResult, defineCommand } from '../command';
import { CliError, EXIT, unsupported, usageError } from '../errors';
import { ENDPOINTS, planCrud, resolveDefinition } from '../generators/crud/generate';
import { type TestMode, verifyCrud } from '../generators/crud/verify';
import { applyChanges, describeChanges } from '../generators/plan';
import { drizzleGenerate } from './database';

/** Records every file under a folder so it can be restored byte-for-byte. */
export async function snapshotFolder(folder: string) {
  const files = new Map<string, string>();
  if (await Bun.file(join(folder, 'meta', '_journal.json')).exists()) {
    for await (const path of new Bun.Glob('**/*').scan({ cwd: folder, onlyFiles: true })) {
      files.set(path, await Bun.file(join(folder, path)).text());
    }
  }
  return {
    async restore() {
      for await (const path of new Bun.Glob('**/*').scan({ cwd: folder, onlyFiles: true })) {
        if (!files.has(path)) await rm(join(folder, path), { force: true });
      }
      for (const [path, content] of files) await Bun.write(join(folder, path), content);
    },
  };
}

const CRUD_OPTIONS: readonly OptionSpec[] = [
  {
    name: 'module',
    type: 'string',
    placeholder: '<name>',
    description: 'Destination module (default: plural of the resource)',
  },
  { name: 'table', type: 'string', placeholder: '<export>', description: 'Reuse an existing Drizzle table export' },
  {
    name: 'schema-file',
    type: 'string',
    placeholder: '<path>',
    description: 'Module that exports --table (default: schema index)',
  },
  {
    name: 'fields',
    type: 'string',
    placeholder: "'<definition>'",
    description: 'New table fields: name:type:required|nullable|default=<literal>',
  },
  { name: 'definition', type: 'string', placeholder: '<path>', description: 'JSON resource definition' },
  { name: 'route', type: 'string', placeholder: '<path>', description: 'Mount path (default /api/v1/<module>)' },
  {
    name: 'primary-key',
    type: 'string',
    placeholder: '<column>',
    description: 'Primary key column (only "id" supported)',
  },
  {
    name: 'access',
    type: 'string',
    values: ['public', 'authenticated'],
    description: 'Declared resource access (required)',
  },
  { name: 'soft-delete', type: 'boolean', description: 'Soft deletion with deletedAt' },
  { name: 'verify', type: 'boolean', description: 'Typecheck and run the generated endpoint suite on real PostgreSQL' },
  {
    name: 'test-mode',
    type: 'string',
    values: ['in-process', 'network'],
    description: 'Endpoint test transport (default in-process)',
  },
  { name: 'dry-run', type: 'boolean', description: 'Preview changes and test plan; write nothing' },
  { name: 'force', type: 'boolean', description: 'Overwrite generator-owned files of this module' },
];

async function runCrud(
  resource: string,
  options: OptionValues,
  context: CommandContext,
  moduleName?: string,
): Promise<CommandResult> {
  const definition = await resolveDefinition(context, {
    resource,
    module: moduleName ?? stringOption(options, 'module'),
    table: stringOption(options, 'table'),
    schemaFile: stringOption(options, 'schema-file'),
    fields: stringOption(options, 'fields'),
    definitionFile: stringOption(options, 'definition'),
    route: stringOption(options, 'route'),
    primaryKey: stringOption(options, 'primary-key'),
    softDelete: flag(options, 'soft-delete'),
    access: stringOption(options, 'access'),
  });
  const plan = await planCrud(context, definition, flag(options, 'force'));
  const mode = (stringOption(options, 'test-mode') ?? 'in-process') as TestMode;
  const summary = {
    resource: definition.names.pascal,
    module: definition.names.module,
    mount: definition.mount,
    source: definition.source,
    changes: plan.changes.map((c) => ({ path: c.path, action: c.action })),
    migration: plan.migrationName ?? null,
    endpoints: ENDPOINTS(definition),
  };

  if (flag(options, 'dry-run')) {
    context.print(`Dry run: ${definition.names.pascal} -> ${definition.mount} (no files written)`);
    for (const line of describeChanges(plan.changes)) context.print(line);
    if (plan.migrationName) context.print(`  migrate   drizzle-kit generate --name ${plan.migrationName}`);
    context.print(
      flag(options, 'verify')
        ? `  verify    typecheck + ${plan.files.test} (${mode})`
        : '  verify    skipped (no --verify)',
    );
    return {
      data: {
        dryRun: true,
        ...summary,
        verification: flag(options, 'verify') ? { testFile: plan.files.test, mode } : null,
      },
    };
  }

  const applied = await applyChanges(context.root, plan.changes);
  const migrations = await snapshotFolder(join(context.root, context.project.paths.migrations));
  try {
    if (plan.migrationName) await drizzleGenerate(context, plan.migrationName);
  } catch (error) {
    // drizzle-kit may have written SQL/snapshot/journal before failing: restore the folder exactly.
    await migrations.restore();
    await applied.rollback();
    throw error;
  }
  const generation = { status: 'generated' as const, ...summary };
  for (const line of describeChanges(plan.changes)) context.print(line);
  if (plan.migrationName) context.print(`  migration ${plan.migrationName} generated (review before db:migrate)`);

  if (!flag(options, 'verify')) return { data: { generation, verification: null } };

  context.print('Verifying: typecheck and endpoint tests against an isolated PostgreSQL database...');
  const verification = await verifyCrud(context, plan.files.test, mode);
  context.print(`  typecheck ${verification.typecheck}`);
  for (const test of verification.tests) context.print(`  ${test.status === 'passed' ? 'pass' : 'FAIL'}  ${test.name}`);
  context.print(`  ${verification.passed} passed, ${verification.failed} failed; cleanup: ${verification.cleanup}`);
  if (verification.status !== 'passed' || verification.cleanup !== 'clean') {
    if (verification.output) context.log(verification.output);
    throw new CliError(
      EXIT.FAILURE,
      'VERIFICATION_FAILED',
      'Generation succeeded but verification failed',
      'Generated code was kept for review.',
      {
        data: { generation, verification },
      },
    );
  }
  return { data: { generation, verification } };
}

export const generatorCommands = [
  defineCommand({
    name: 'make:crud',
    group: 'generators',
    status: 'implemented',
    description: 'Complete Drizzle-derived CRUD feature with endpoint tests; --verify runs them',
    arguments: [{ name: 'resource', description: 'PascalCase resource name, e.g. Product', required: true }],
    options: CRUD_OPTIONS,
    requires: ['--verify: PostgreSQL test server (TEST_DATABASE_URL)'],
    examples: [
      "make:crud Product --module products --fields 'name:text:required,price:numeric:required' --access public --verify",
      'make:crud Product --module products --table products --access public --verify',
      "make:crud Note --fields 'body:text:required' --access public --dry-run",
    ],
    async run({ positionals, options }, context) {
      const resource = positionals[0];
      if (!resource)
        throw usageError(
          'Missing <resource> argument',
          'Example: make:crud Product --fields name:text:required --access public',
        );
      if (positionals.length > 1) throw usageError(`Unexpected arguments: ${positionals.slice(1).join(' ')}`);
      return runCrud(resource, options, context);
    },
  }),
  defineCommand({
    name: 'make:module',
    group: 'generators',
    status: 'implemented',
    description: 'Module routes/provider/exports; --crud delegates to make:crud',
    arguments: [{ name: 'name', description: 'kebab-case module name', required: true }],
    options: [
      {
        name: 'crud',
        type: 'string',
        placeholder: '<Resource>',
        description: 'Generate a CRUD resource in this module',
      },
      ...CRUD_OPTIONS.filter((o) => o.name !== 'module'),
    ],
    examples: ["make:module products --crud Product --fields 'name:text:required' --access public --dry-run"],
    async run({ positionals, options }, context) {
      const name = positionals[0];
      if (!name) throw usageError('Missing <name> argument');
      const resource = stringOption(options, 'crud');
      if (!resource) throw unsupported('Empty modules are planned; use --crud <Resource>');
      return runCrud(resource, options, context, name);
    },
  }),
];
