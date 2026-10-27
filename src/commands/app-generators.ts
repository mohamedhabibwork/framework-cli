import { join } from 'node:path';
import { flag, stringOption } from '../args';
import { type CommandContext, defineCommand } from '../command';
import { failure, usageError } from '../errors';
import { resolveInsideProject } from '../generators/paths';
import { assertPrerequisites, type FileUpdate, type NewFile } from '../generators/plan';
import { addImport, insertAfterMarker } from '../generators/registration';
import {
  COMMANDS_REGISTRY,
  NOTIFICATION_CHANNELS,
  renderCommand,
  renderGuard,
  renderMail,
  renderNotification,
  renderSchedule,
  renderUserProvider,
  SCHEDULES_REGISTRY,
  type ScheduleTarget,
} from '../generators/scaffolds/templates-app';
import { runProcess, tail } from '../process';
import { COMMON_OPTIONS, camelVar, generate, names } from './generator-pipeline';

const DRIZZLE_TIMEOUT_MS = 120_000;
const MIGRATION_NAME = /^[a-z0-9][a-z0-9-_]{0,62}$/;
const COMMAND_SIGNATURE = /^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)+$/;
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
// Five space-separated cron fields of digits and cron punctuation only (no quotes reach the template).
const CRON = /^[\d*/,-]+( [\d*/,-]+){4}$/;

/** Generated code imports this package; refuse with the install hint instead of emitting broken imports. */
async function requireDependency(context: CommandContext, dependency: string): Promise<void> {
  const manifest = (await Bun.file(resolveInsideProject(context.root, 'package.json')).json()) as {
    readonly dependencies?: Readonly<Record<string, string>>;
  };
  if (!manifest.dependencies?.[dependency]) {
    const shortName = dependency.replace(/^@framework\//, '');
    throw usageError(
      `This generator needs ${dependency} in package.json dependencies`,
      `Add "${dependency}": "workspace:*" (or "github:mohamedhabibwork/framework-${shortName}"), run bun install, then retry.`,
    );
  }
}

/**
 * Registers `line` + `importStatement` into a marker registry, creating the
 * registry from `initial` when the application does not have one yet.
 */
async function registryChange(
  context: CommandContext,
  path: string,
  initial: string,
  marker: string,
  line: string,
  importStatement: string,
): Promise<{ readonly files: NewFile[]; readonly updates: FileUpdate[] }> {
  const transform = (source: string) => addImport(insertAfterMarker(source, marker, line, path), importStatement);
  if (await Bun.file(resolveInsideProject(context.root, path)).exists()) {
    return { files: [], updates: [{ path, transform }] };
  }
  return { files: [{ path, content: transform(initial) }], updates: [] };
}

/** Wires `app/commands` into bin/cli.ts once; later runs leave the file untouched. */
const wireCliCommands: FileUpdate = {
  path: 'bin/cli.ts',
  transform: (source) => {
    if (source.includes('...appCommands')) return source;
    if (!source.includes('commands: frameworkCommands,')) {
      throw failure(
        'REGISTRATION_TARGET_MISSING',
        'bin/cli.ts does not pass "commands: frameworkCommands," to runCli',
        'Append the app registry manually: commands: [...frameworkCommands, ...appCommands].',
      );
    }
    return addImport(
      source.replace('commands: frameworkCommands,', 'commands: [...frameworkCommands, ...appCommands],'),
      "import { commands as appCommands } from '../app/commands';",
    );
  },
};

export const appGeneratorCommands = [
  defineCommand({
    name: 'make:mail',
    group: 'generators',
    status: 'implemented',
    description: 'Mailable: typed data → subject/text/HTML (escaped) plus a send helper over the Mailer',
    arguments: [{ name: 'name', description: 'Mail name in PascalCase or kebab-case', required: true }],
    options: COMMON_OPTIONS,
    examples: ['make:mail welcome', 'make:mail OrderShipped --dry-run'],
    async run({ positionals, options }, context) {
      const name = names(positionals[0], 'Mail');
      await requireDependency(context, '@framework/mail');
      return generate(context, options, [
        { path: join('app/mail', `${name.kebab}.mail.ts`), content: renderMail(name) },
      ]);
    },
  }),
  defineCommand({
    name: 'make:notification',
    group: 'generators',
    status: 'implemented',
    description: 'Notification with explicit channels and one builder per channel',
    arguments: [{ name: 'name', description: 'Notification name in PascalCase or kebab-case', required: true }],
    options: [
      {
        name: 'channels',
        type: 'string',
        placeholder: '<list>',
        description: `Comma-separated channels (${NOTIFICATION_CHANNELS.join(', ')}); default email,database`,
      },
      ...COMMON_OPTIONS,
    ],
    examples: ['make:notification invoice-paid', 'make:notification InvoicePaid --channels database,push'],
    async run({ positionals, options }, context) {
      const name = names(positionals[0], 'Notification');
      const channels = (stringOption(options, 'channels') ?? 'email,database').split(',').map((c) => c.trim());
      const unknown = channels.filter((channel) => !NOTIFICATION_CHANNELS.includes(channel));
      if (unknown.length > 0 || new Set(channels).size !== channels.length) {
        throw usageError(`--channels must be distinct values from: ${NOTIFICATION_CHANNELS.join(', ')}`);
      }
      await requireDependency(context, '@framework/notifications');
      return generate(context, options, [
        {
          path: join('app/notifications', `${name.kebab}.notification.ts`),
          content: renderNotification(name, channels),
        },
      ]);
    },
  }),
  defineCommand({
    name: 'make:command',
    group: 'generators',
    status: 'implemented',
    description: 'Application CLI command registered next to the framework catalog',
    arguments: [{ name: 'name', description: 'Command name in PascalCase or kebab-case', required: true }],
    options: [
      { name: 'signature', type: 'string', placeholder: '<a:b>', description: 'Command name (default app:<name>)' },
      ...COMMON_OPTIONS,
    ],
    examples: ['make:command prune-carts', 'make:command ReportSales --signature reports:sales'],
    async run({ positionals, options }, context) {
      const name = names(positionals[0], 'Command');
      const signature = stringOption(options, 'signature') ?? `app:${name.kebab}`;
      if (!COMMAND_SIGNATURE.test(signature)) {
        throw usageError('--signature must be lowercase "group:name" segments (e.g. reports:sales)');
      }
      if (context.registry.get(signature)) throw usageError(`Command "${signature}" already exists`);
      const commandVar = camelVar(name.kebab, 'Command');
      const registry = await registryChange(
        context,
        'app/commands/index.ts',
        COMMANDS_REGISTRY,
        '@framework:commands',
        `  ${commandVar},`,
        `import { ${commandVar} } from './${name.kebab}.command';`,
      );
      return generate(
        context,
        options,
        [
          { path: join('app/commands', `${name.kebab}.command.ts`), content: renderCommand(name, signature) },
          ...registry.files,
        ],
        [...registry.updates, wireCliCommands],
      );
    },
  }),
  defineCommand({
    name: 'make:schedule',
    group: 'generators',
    status: 'implemented',
    description: 'Cron schedule dispatching a job or workflow, registered in app/schedules',
    arguments: [{ name: 'name', description: 'Schedule name in PascalCase or kebab-case', required: true }],
    options: [
      {
        name: 'cron',
        type: 'string',
        placeholder: '<expr>',
        description: '5-field cron expression (default "0 * * * *")',
      },
      { name: 'job', type: 'string', placeholder: '<name>', description: 'Job generated by make:job to dispatch' },
      { name: 'workflow', type: 'string', placeholder: '<name>', description: 'Registered workflow name to start' },
      ...COMMON_OPTIONS,
    ],
    examples: [
      'make:schedule nightly-report --job send-report --cron "0 3 * * *"',
      'make:schedule sync --workflow sync',
    ],
    async run({ positionals, options }, context) {
      const name = names(positionals[0], 'Schedule');
      const cron = stringOption(options, 'cron') ?? '0 * * * *';
      if (!CRON.test(cron)) throw usageError('--cron must be a 5-field cron expression (e.g. "0 3 * * *")');
      const job = stringOption(options, 'job');
      const workflow = stringOption(options, 'workflow');
      if ((job === undefined) === (workflow === undefined)) {
        throw usageError('Pass exactly one of --job <name> or --workflow <name>');
      }
      let target: ScheduleTarget;
      if (job !== undefined) {
        const jobName = names(job, 'Job');
        const jobFile = `${jobName.kebab}.job`;
        await assertPrerequisites(context.root, [
          { path: join('app/jobs', `${jobFile}.ts`), command: `make:job ${jobName.kebab}` },
        ]);
        target = { kind: 'job', jobVar: camelVar(jobName.kebab, 'Job'), jobFile };
      } else {
        target = { kind: 'workflow', workflow: names(workflow, 'Workflow').kebab };
      }
      await requireDependency(context, '@framework/scheduler');
      const scheduleVar = camelVar(name.kebab, 'Schedule');
      const registry = await registryChange(
        context,
        'app/schedules/index.ts',
        SCHEDULES_REGISTRY,
        '@framework:schedules',
        `  ${scheduleVar},`,
        `import { ${scheduleVar} } from './${name.kebab}.schedule';`,
      );
      return generate(
        context,
        options,
        [
          { path: join('app/schedules', `${name.kebab}.schedule.ts`), content: renderSchedule(name, cron, target) },
          ...registry.files,
        ],
        registry.updates,
      );
    },
  }),
  defineCommand({
    name: 'make:guard',
    group: 'generators',
    status: 'implemented',
    description: 'Header-credential authentication guard (ActorResolver) for the kernel',
    arguments: [{ name: 'name', description: 'Guard name in PascalCase or kebab-case', required: true }],
    options: [
      { name: 'header', type: 'string', placeholder: '<name>', description: 'Credential header (default x-api-key)' },
      ...COMMON_OPTIONS,
    ],
    examples: ['make:guard partner-key', 'make:guard Signed --header x-signature'],
    async run({ positionals, options }, context) {
      const name = names(positionals[0], 'Guard');
      const header = (stringOption(options, 'header') ?? 'x-api-key').toLowerCase();
      if (!HEADER_NAME.test(header)) throw usageError('--header must be a valid HTTP header name');
      return generate(context, options, [
        { path: join('app/auth/guards', `${name.kebab}.guard.ts`), content: renderGuard(name, header) },
      ]);
    },
  }),
  defineCommand({
    name: 'make:user-provider',
    group: 'generators',
    status: 'implemented',
    description: 'UserProvider implementation (decorates the database provider) for USER_PROVIDER',
    arguments: [{ name: 'name', description: 'Provider name in PascalCase or kebab-case', required: true }],
    options: COMMON_OPTIONS,
    examples: ['make:user-provider ldap'],
    async run({ positionals, options }, context) {
      const name = names(positionals[0], 'User provider');
      await requireDependency(context, '@framework/auth');
      return generate(context, options, [
        { path: join('app/auth', `${name.kebab}.user-provider.ts`), content: renderUserProvider(name) },
      ]);
    },
  }),
  defineCommand({
    name: 'make:migration',
    group: 'generators',
    status: 'implemented',
    description: 'Empty custom SQL migration registered in the Drizzle journal',
    arguments: [{ name: 'name', description: 'Migration name (lowercase, digits, - or _)', required: true }],
    options: [{ name: 'dry-run', type: 'boolean', description: 'Print the drizzle-kit invocation without running it' }],
    examples: ['make:migration backfill-slugs'],
    async run({ positionals, options }, context) {
      const name = positionals[0];
      if (!name || !MIGRATION_NAME.test(name)) {
        throw usageError('Migration name must be lowercase letters, digits, "-" or "_"');
      }
      const argv = [...context.project.tools.drizzleKit, 'generate', '--custom', '--name', name];
      if (flag(options, 'dry-run')) {
        context.print(`  would run ${argv.join(' ')}`);
        return { data: { dryRun: true, command: argv } };
      }
      const result = await runProcess(argv, {
        cwd: context.root,
        timeoutMs: DRIZZLE_TIMEOUT_MS,
        signal: context.signal,
        stream: context.verbose,
      });
      if (result.exitCode !== 0) {
        throw failure(
          'DB_GENERATE_FAILED',
          'drizzle-kit generate --custom failed',
          tail(`${result.stdout}\n${result.stderr}`),
        );
      }
      context.print(result.stdout.trim());
      return { data: { name, output: result.stdout } };
    },
  }),
];
