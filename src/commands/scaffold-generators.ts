import { join } from 'node:path';
import { flag, type OptionSpec, type OptionValues, stringOption } from '../args';
import { type CommandContext, type CommandResult, defineCommand } from '../command';
import { usageError } from '../errors';
import { resourceNames } from '../generators/naming';
import { addImport, insertAfterMarker } from '../generators/registration';
import { planSlice, type SliceKind } from '../generators/scaffolds/slices';
import {
  renderApiTest,
  renderEvent,
  renderListener,
  renderMiddleware,
  renderProvider,
  renderUnitTest,
  splitEventName,
} from '../generators/scaffolds/templates-runtime';
import { COMMON_OPTIONS, camelVar, generate, names } from './generator-pipeline';

/** Shared options of the table-derived single slices (make:crud's vocabulary). */
const SLICE_OPTIONS: readonly OptionSpec[] = [
  {
    name: 'module',
    type: 'string',
    placeholder: '<name>',
    description: 'Destination module (default: plural of the resource)',
  },
  {
    name: 'table',
    type: 'string',
    placeholder: '<export>',
    description: 'Drizzle table export (default: plural camel of the resource)',
  },
  {
    name: 'schema-file',
    type: 'string',
    placeholder: '<path>',
    description: 'Module that exports --table (default: schema index)',
  },
  { name: 'soft-delete', type: 'boolean', description: 'Table carries deletedAt (string mode)' },
];

const RESOURCE_ARGUMENT = {
  name: 'resource',
  description: 'PascalCase resource name, e.g. Product',
  required: true,
} as const;

async function runSlice(kind: SliceKind, options: OptionValues, context: CommandContext): Promise<CommandResult> {
  const resource = resourceNames(stringOption(options, 'resource') ?? '', {}).pascal;
  const plan = await planSlice(
    context,
    kind,
    {
      resource,
      module: stringOption(options, 'module'),
      table: stringOption(options, 'table'),
      schemaFile: stringOption(options, 'schema-file'),
      softDelete: flag(options, 'soft-delete'),
      access: stringOption(options, 'access'),
      fields: stringOption(options, 'fields'),
      definitionFile: stringOption(options, 'definition'),
    },
    { requestKind: stringOption(options, 'kind') },
  );
  const result = await generate(context, options, plan.files, plan.updates);
  if (plan.hint && !flag(options, 'dry-run')) context.print(`  hint      ${plan.hint}`);
  return result;
}

function sliceCommand(
  name: string,
  kind: SliceKind,
  description: string,
  examples: readonly string[],
  extraOptions: readonly OptionSpec[] = [],
  baseOptions: readonly OptionSpec[] = SLICE_OPTIONS,
) {
  return defineCommand({
    name,
    group: 'generators',
    status: 'implemented',
    description,
    arguments: [RESOURCE_ARGUMENT],
    options: [...baseOptions, ...extraOptions, ...COMMON_OPTIONS],
    examples,
    async run({ positionals, options }, context) {
      if (!positionals[0]) throw usageError(`Missing <resource> argument for ${name}`);
      if (positionals.length > 1) throw usageError(`Unexpected arguments: ${positionals.slice(1).join(' ')}`);
      return runSlice(kind, { ...options, resource: positionals[0] }, context);
    },
  });
}

/** Valid event/listener channel: the same shape @framework/events enforces. */
const CHANNEL_PATTERN = /^[a-z][a-z0-9_.:-]{0,127}$/;

function resolveChannel(options: OptionValues, kebab: string, what: string): { channel: string; verb: string } {
  const explicit = stringOption(options, 'channel');
  if (explicit !== undefined) {
    if (!CHANNEL_PATTERN.test(explicit)) {
      throw usageError(
        `Invalid --channel "${explicit}"`,
        'Channels look like orders, audit.orders or workflow.run.<id>.',
      );
    }
    return { channel: explicit, verb: kebab.split('-').at(-1) as string };
  }
  try {
    return splitEventName(kebab);
  } catch {
    throw usageError(
      `A single-word ${what} name needs an explicit --channel`,
      'Example: make:event ping --channel app',
    );
  }
}

export const scaffoldGeneratorCommands = [
  sliceCommand(
    'make:schema',
    'schema',
    'Canonical Drizzle table definition registered in the schema index',
    [
      "make:schema Product --fields 'name:text:required,price:numeric:required'",
      "make:schema Product --fields 'name:text:required' --soft-delete --dry-run",
    ],
    [
      {
        name: 'fields',
        type: 'string',
        placeholder: "'<definition>'",
        description: 'New table fields: name:type:required|nullable|default=<literal>',
      },
      { name: 'definition', type: 'string', placeholder: '<path>', description: 'JSON resource definition' },
    ],
    // make:schema authors a new table: --table/--schema-file would contradict it.
    SLICE_OPTIONS.filter((option) => option.name === 'module' || option.name === 'soft-delete'),
  ),
  sliceCommand('make:repository', 'repository', 'Typed Drizzle repository composed from CRUD mixins', [
    'make:repository Product',
    'make:repository Product --table products',
  ]),
  sliceCommand('make:dto', 'dto', 'Inferred Zod input/output DTO types from the module schemas', ['make:dto Product']),
  sliceCommand(
    'make:request',
    'request',
    'Form request (schema + authorization hook) for one operation kind',
    ['make:request Product', 'make:request Product --kind update'],
    [
      {
        name: 'kind',
        type: 'string',
        values: ['create', 'update', 'list'],
        description: 'Which operation (default create)',
      },
    ],
  ),
  sliceCommand('make:response', 'response', 'Public response projection and serializer', ['make:response Product']),
  sliceCommand('make:service', 'service', 'Business service over the repository and DTOs', ['make:service Product']),
  sliceCommand('make:controller', 'controller', 'Typed controller mapping HTTP input to the service', [
    'make:controller Product',
  ]),
  sliceCommand(
    'make:policy',
    'policy',
    'Resource policy for the five CRUD abilities',
    ['make:policy Product --access public', 'make:policy Product --access authenticated'],
    [
      {
        name: 'access',
        type: 'string',
        values: ['public', 'authenticated'],
        description: 'Declared resource access (required)',
      },
    ],
    // Policies reference neither the table nor module siblings, so the
    // table/schema/soft-delete slice options would be silent no-ops here.
    [],
  ),
  defineCommand({
    name: 'make:middleware',
    group: 'generators',
    status: 'implemented',
    description: 'Native typed Hono middleware registered as a named alias',
    arguments: [{ name: 'name', description: 'Middleware name in PascalCase or kebab-case', required: true }],
    options: COMMON_OPTIONS,
    examples: ['make:middleware tenant-scope', 'make:middleware TenantScope --dry-run'],
    async run({ positionals, options }, context) {
      const id = names(positionals[0], 'Middleware');
      const file = join('app/middleware', `${id.kebab}.middleware.ts`);
      const variable = camelVar(id.kebab, 'Middleware');
      const bootstrap = context.project.paths.middleware;
      const files = [{ path: file, content: renderMiddleware(id) }];
      const updates = [
        {
          path: bootstrap,
          transform: (source: string) =>
            addImport(
              insertAfterMarker(source, '@framework:middleware', `.alias('${id.kebab}', ${variable})`, bootstrap),
              `import { ${variable} } from '../app/middleware/${id.kebab}.middleware';`,
            ),
        },
      ];
      return generate(context, options, files, updates);
    },
  }),
  defineCommand({
    name: 'make:provider',
    group: 'generators',
    status: 'implemented',
    description: 'Provider lifecycle factory registered in bootstrap/providers.ts',
    arguments: [{ name: 'name', description: 'Provider name in PascalCase or kebab-case', required: true }],
    options: COMMON_OPTIONS,
    examples: ['make:provider search'],
    async run({ positionals, options }, context) {
      const id = names(positionals[0], 'Provider');
      const file = join('app/providers', `${id.kebab}.provider.ts`);
      const providerVar = camelVar(id.kebab, 'Provider');
      const providers = context.project.paths.providers;
      const files = [{ path: file, content: renderProvider(id) }];
      const updates = [
        {
          path: providers,
          transform: (source: string) =>
            addImport(
              insertAfterMarker(source, '@framework:providers', `${providerVar},`, providers),
              `import { ${providerVar} } from '../app/providers/${id.kebab}.provider';`,
            ),
        },
      ];
      return generate(context, options, files, updates);
    },
  }),
  defineCommand({
    name: 'make:event',
    group: 'generators',
    status: 'implemented',
    description: 'Typed domain event contract with a validated payload',
    arguments: [{ name: 'name', description: 'Event name as <channel>-<verb>, e.g. order-paid', required: true }],
    options: [
      {
        name: 'channel',
        type: 'string',
        placeholder: '<channel>',
        description: 'Fan-out channel (required for single-word names)',
      },
      ...COMMON_OPTIONS,
    ],
    examples: ['make:event order-paid', 'make:event ping --channel app'],
    async run({ positionals, options }, context) {
      const id = names(positionals[0], 'Event');
      const { channel, verb } = resolveChannel(options, id.kebab, 'event');
      const file = join('app/events', `${id.kebab}.event.ts`);
      return generate(context, options, [{ path: file, content: renderEvent(id, channel, verb) }], []);
    },
  }),
  defineCommand({
    name: 'make:listener',
    group: 'generators',
    status: 'implemented',
    description: 'Event listener subscribed through the listeners registry',
    arguments: [{ name: 'name', description: 'Listener name in PascalCase or kebab-case', required: true }],
    options: [
      { name: 'channel', type: 'string', placeholder: '<channel>', description: 'Channel to subscribe to (required)' },
      ...COMMON_OPTIONS,
    ],
    examples: ['make:listener order-auditor --channel orders'],
    async run({ positionals, options }, context) {
      const id = names(positionals[0], 'Listener');
      const channel = stringOption(options, 'channel');
      if (channel === undefined)
        throw usageError('--channel is required', 'Example: make:listener order-auditor --channel orders');
      if (!CHANNEL_PATTERN.test(channel)) throw usageError(`Invalid --channel "${channel}"`);
      const file = join('app/listeners', `${id.kebab}.listener.ts`);
      const listenerVar = camelVar(id.kebab, 'Listener');
      const registry = join('app/listeners', 'index.ts');
      const files = [{ path: file, content: renderListener(id, channel) }];
      const updates = [
        {
          path: registry,
          transform: (source: string) =>
            addImport(
              insertAfterMarker(source, '@framework:listeners', `  ${listenerVar},`, registry),
              `import { ${listenerVar} } from './${id.kebab}.listener';`,
            ),
        },
      ];
      return generate(context, options, files, updates);
    },
  }),
  defineCommand({
    name: 'make:test',
    group: 'generators',
    status: 'implemented',
    description: 'Test scaffold; --api boots the app through tests/support.ts',
    arguments: [{ name: 'name', description: 'Test name in PascalCase or kebab-case', required: true }],
    options: [
      { name: 'api', type: 'boolean', description: 'Endpoint scaffold against the registered application' },
      ...COMMON_OPTIONS,
    ],
    examples: ['make:test pricing-calculator', 'make:test products --api'],
    async run({ positionals, options }, context) {
      const id = names(positionals[0], 'Test');
      const file = flag(options, 'api')
        ? join('tests', `${id.kebab}.api.test.ts`)
        : join('tests', `${id.kebab}.test.ts`);
      const content = flag(options, 'api') ? renderApiTest(id) : renderUnitTest(id);
      return generate(context, options, [{ path: file, content }], []);
    },
  }),
];
