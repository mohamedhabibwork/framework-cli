import { join } from 'node:path';
import { defineCommand } from '../command';
import type { NewFile } from '../generators/plan';
import { addImport, insertAfterMarker } from '../generators/registration';
import { COMMON_OPTIONS, camelVar, generate, names } from './generator-pipeline';

export const simpleGeneratorCommands = [
  defineCommand({
    name: 'make:job',
    group: 'generators',
    status: 'implemented',
    description: 'Versioned, validated job payload and handler, registered in the jobs list',
    arguments: [{ name: 'name', description: 'Job name in PascalCase or kebab-case', required: true }],
    options: COMMON_OPTIONS,
    examples: ['make:job order-paid', 'make:job OrderPaid --dry-run'],
    async run({ positionals, options }, context) {
      const name = names(positionals[0], 'Job');
      const file = join('app/jobs', `${name.kebab}.job.ts`);
      const jobVar = camelVar(name.kebab, 'Job');
      const files: readonly NewFile[] = [
        {
          path: file,
          content: `import { defineJob } from '@framework/queue';
import { z } from 'zod/v4';

/**
 * ${name.pascal} job: the payload is versioned and validated before dispatch;
 * keep the handler idempotent — retries re-run it with the same payload.
 */
export const ${jobVar} = defineJob({
  name: '${name.kebab}',
  version: 1,
  attempts: 3,
  payload: z.object({}).strict(),
  async handle(_payload, context) {
    console.error('[${name.kebab}] started (correlation ' + context.execution.correlationId + ')');
    // TODO: do the work
    return { ok: true };
  },
});
`,
        },
      ];
      const updates = [
        {
          path: 'app/jobs/index.ts',
          transform: (source: string) =>
            addImport(
              source.includes('// @framework:jobs')
                ? insertAfterMarker(source, '@framework:jobs', `  ${jobVar},`, 'app/jobs/index.ts')
                : source.replace('export const jobs: JobList = [];', `export const jobs: JobList = [${jobVar}];`),
              `import { ${jobVar} } from './${name.kebab}.job';`,
            ),
        },
      ];
      return generate(context, options, files, updates);
    },
  }),
  defineCommand({
    name: 'make:seeder',
    group: 'generators',
    status: 'implemented',
    description: 'Named seeder registered in the application seeder list',
    arguments: [{ name: 'name', description: 'Seeder name in PascalCase or kebab-case', required: true }],
    options: COMMON_OPTIONS,
    examples: ['make:seeder demo-orders'],
    async run({ positionals, options }, context) {
      const name = names(positionals[0], 'Seeder');
      const file = join('database/seeders', `${name.kebab}.seeder.ts`);
      const seederVar = camelVar(name.kebab, 'Seeder');
      const files: readonly NewFile[] = [
        {
          path: file,
          content: `import { defineSeeder } from '@framework/database';

/**
 * ${name.pascal} seeder. Runs in registry order via \`db:seed\`; keep it
 * idempotent — guard on existing rows or upsert.
 */
export const ${seederVar} = defineSeeder({
  name: '${name.kebab}',
  async run({ execution, log }) {
    log('${name.kebab}: seeding (correlation ' + execution.correlationId + ')');
    // TODO: insert seed data through a repository or direct connection.
  },
});
`,
        },
      ];
      const updates = [
        {
          path: join('database', 'seeders.ts'),
          transform: (source: string) =>
            addImport(
              insertAfterMarker(source, '@framework:seeders', `  ${seederVar},`, join('database', 'seeders.ts')),
              `import { ${seederVar} } from './seeders/${name.kebab}.seeder';`,
            ),
        },
      ];
      return generate(context, options, files, updates);
    },
  }),
  defineCommand({
    name: 'make:factory',
    group: 'generators',
    status: 'implemented',
    description: 'Database factory shared by seeders and tests',
    arguments: [{ name: 'name', description: 'Factory name in PascalCase or kebab-case', required: true }],
    options: COMMON_OPTIONS,
    examples: ['make:factory product'],
    async run({ positionals, options }, context) {
      const name = names(positionals[0], 'Factory');
      const file = join('database/factories', `${name.kebab}.factory.ts`);
      const factoryVar = camelVar(name.kebab, 'Factory');
      const files: readonly NewFile[] = [
        {
          path: file,
          content: `import { defineFactory } from '@framework/database';

/**
 * ${name.pascal} factory: \`make()\` builds in-memory attributes (tests),
 * \`create()\` persists them. The definition receives a 1-based build counter
 * — handy for unique fields.
 */
export const ${factoryVar} = defineFactory({
  definition: (n) => ({
    // TODO: derive attributes from the Drizzle–Zod insert schema.
    name: \`${name.kebab}-\${n}\`,
  }),
  // persist: async (attributes) => repository.create(attributes),
});
`,
        },
      ];
      return generate(context, options, files, []);
    },
  }),
];
