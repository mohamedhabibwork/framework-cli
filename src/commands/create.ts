import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { defineCommand } from '../command';
import { usageError } from '../errors';
import { type AppTemplateInput, appTemplateFiles } from '../generators/app/templates';
import { applyChanges, buildChanges, describeChanges, type NewFile } from '../generators/plan';

const APP_NAME = /^[a-z][a-z0-9-]*$/;

function pascalCase(kebab: string): string {
  return kebab
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function templateInput(directory: string): AppTemplateInput {
  const name = basename(resolve(directory));
  if (!APP_NAME.test(name)) {
    throw usageError(
      `Application name "${name}" must be kebab-case (letters, digits, dashes)`,
      'Example: bun run cli -- create apps/inventory-api',
    );
  }
  return { name, className: pascalCase(name), apiTitle: `${pascalCase(name)} API` };
}

async function directoryIsEmpty(target: string): Promise<boolean> {
  const entries = await readdir(target);
  return entries.length === 0;
}

/** Nearest enclosing framework workspace (a directory owning packages/cli), if any. */
async function frameworkWorkspaceRoot(target: string): Promise<string | null> {
  let current = resolve(target);
  while (true) {
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
    if (await Bun.file(join(current, 'packages/cli/package.json')).exists()) return current;
  }
}

/**
 * Rewrites `@framework/<pkg>: "workspace:*"` to `"github:mohamedhabibwork/framework-<pkg>"`
 * and includes `@types/bun` in `devDependencies` when generating a standalone application
 * outside the framework monorepo.
 */
export function toStandalonePackageJson(source: string): string {
  const rewritten = source.replaceAll(
    /"@framework\/([a-z0-9-]+)":\s*"workspace:\*"/g,
    '"@framework/$1": "github:mohamedhabibwork/framework-$1#standalone"',
  );
  const pkg = JSON.parse(rewritten) as {
    devDependencies?: Record<string, string>;
    [key: string]: unknown;
  };
  const devDeps: Record<string, string> = {
    '@types/bun': '1.4.2',
    oxfmt: '0.75.0',
    oxlint: '1.90.0',
    ...(pkg.devDependencies ?? {}),
  };
  pkg.devDependencies = Object.fromEntries(Object.entries(devDeps).sort(([a], [b]) => a.localeCompare(b)));
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/**
 * Installs dependencies without polluting stdout (which carries the --json
 * envelope); progress goes to stderr diagnostics instead.
 */
async function runInstall(cwd: string, context: { log(line: string): void }): Promise<void> {
  const child = Bun.spawn(['bun', 'install'], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  for (const line of `${out}${err}`.split('\n').filter(Boolean)) context.log(line);
  if (code !== 0) throw new Error(`bun install exited with code ${code}`);
}

interface DemoResult {
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * Runs the generated app's own `make:crud` (the same single pipeline, no
 * duplication) to add a sample products module plus its migration. Pure file
 * generation: no database connection is needed.
 */
async function generateDemoModule(target: string, context: { log(line: string): void }): Promise<DemoResult> {
  const child = Bun.spawn(
    [
      'bun',
      'run',
      'bin/cli.ts',
      'make:crud',
      'Product',
      '--module',
      'products',
      '--fields',
      'name:text:required,price:numeric:required',
      '--access',
      'public',
    ],
    { cwd: target, env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  for (const line of stdout.split('\n').filter(Boolean)) context.log(`  ${line}`);
  if (code !== 0) {
    for (const line of stderr.split('\n').filter(Boolean)) context.log(`  ${line}`);
    return { ok: false, detail: `make:crud exited with code ${code}` };
  }
  return { ok: true, detail: 'sample module "products" generated with migration' };
}

export const createCommands = [
  defineCommand({
    name: 'create',
    group: 'project',
    status: 'implemented',
    description: 'Generate a new application into an empty directory',
    arguments: [
      { name: 'directory', description: 'Target directory (created if missing, must be empty)', required: true },
    ],
    options: [
      {
        name: 'template',
        type: 'string',
        values: ['api'],
        placeholder: 'api',
        description: 'Application template (only api)',
      },
      {
        name: 'runtime',
        type: 'string',
        values: ['bun'],
        placeholder: 'bun',
        description: 'Runtime (only bun is validated)',
      },
      {
        name: 'package-manager',
        type: 'string',
        values: ['bun'],
        placeholder: 'bun',
        description: 'Package manager (only bun)',
      },
      { name: 'no-install', type: 'boolean', description: 'Skip dependency installation' },
      {
        name: 'with-demo',
        type: 'boolean',
        description: 'Also generate a sample products module (with migration) via make:crud',
      },
    ],
    examples: [
      'bun run cli -- create apps/inventory-api --with-demo',
      'bun run cli -- create apps/inventory-api',
      'bun run cli -- create ../my-app --no-install',
    ],
    async run({ positionals, options }, context) {
      const directory = positionals[0];
      if (!directory) throw usageError('create requires a target directory');
      const input = templateInput(directory);
      const target = resolve(process.cwd(), directory);

      const existing = await stat(target).catch(() => null);
      if (existing && !existing.isDirectory()) {
        throw usageError(`Target "${directory}" exists and is not a directory`);
      }
      if (existing && !(await directoryIsEmpty(target))) {
        throw usageError(
          `Target directory "${directory}" is not empty`,
          'create only generates into empty directories; move existing files first.',
        );
      }

      const workspace = await frameworkWorkspaceRoot(target);
      const files: readonly NewFile[] = appTemplateFiles(input).map((file) =>
        file.path === 'package.json' && !workspace
          ? { path: file.path, content: toStandalonePackageJson(file.content) }
          : file,
      );
      const changes = await buildChanges(target, files, [], false);
      const applied = await applyChanges(target, changes);
      try {
        const warnings: string[] = [];
        let dependenciesInstalled = false;
        if (options['no-install'] === true) {
          context.print(`Created application "${input.name}" in ${target} (dependencies not installed).`);
        } else {
          // Inside the framework workspace, membership is what makes the
          // workspace:* dependencies resolve; install at the root, not in
          // the new app (a standalone install there cannot resolve them).
          const installRoot = workspace ?? target;
          try {
            context.print('Installing dependencies (through the framework workspace when inside one)...');
            await runInstall(installRoot, context);
            dependenciesInstalled = true;
            context.print(`Created application "${input.name}" in ${target} and installed dependencies.`);
          } catch (error) {
            context.print(`Created application "${input.name}" in ${target}; dependency installation failed.`);
            context.log(`Install error: ${error instanceof Error ? error.message : String(error)}`);
            context.log('Run `bun install` inside the framework workspace, then retry or use --no-install.');
          }
        }

        let demo: DemoResult | null = null;
        if (options['with-demo'] === true) {
          if (dependenciesInstalled) {
            context.print('Generating sample products module (make:crud inside the new app)...');
            demo = await generateDemoModule(target, context);
            context.print(`Sample module: ${demo.detail}`);
            if (!demo.ok) warnings.push('--with-demo could not finish; run make:crud inside the app to retry.');
          } else {
            demo = { ok: false, detail: 'skipped: dependencies are not installed' };
            warnings.push('--with-demo skipped: run `bun install` first, then `make:crud` inside the app.');
          }
        }

        for (const line of describeChanges(changes)) context.print(line);
        if (workspace) {
          warnings.push(
            `Installed through the framework workspace at ${relative(target, workspace) || '.'}; a generated app is a workspace member.`,
          );
        } else {
          warnings.push(
            'Standalone app configured to resolve @framework/* packages from github:mohamedhabibwork/framework-*.',
          );
        }
        const nextSteps = [
          `cd ${directory}`,
          'cp .env.example .env',
          'docker compose -f deployment/compose.yaml up -d --wait',
          'bun run cli -- db:migrate',
          ...(demo?.ok
            ? []
            : ["bun run cli -- make:crud Product --module products --fields 'name:text:required' --access public"]),
          'bun run dev                        # http://127.0.0.1:3000/health/ready',
          'bun run worker                     # optional: queue worker',
        ];
        for (const step of nextSteps) context.print(`  next: ${step}`);
        return {
          data: {
            application: input.name,
            directory: target,
            files: changes.map((c) => c.path),
            demo: demo?.ok ? { resource: 'Product', module: 'products', mount: '/api/v1/products' } : null,
          },
          warnings,
        };
      } catch (error) {
        await applied.rollback();
        throw error;
      }
    },
  }),
];
