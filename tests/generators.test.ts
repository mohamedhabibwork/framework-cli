import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { requireTestDatabaseUrl } from '@framework/testing';

/**
 * Release gate for the scaffold generators: every make:* slice and runtime
 * scaffold (dry-run byte-neutrality, conflict refusal, marker registration
 * visible to runtime commands, and one typecheck over all generated code) in
 * a single scratch copy of the playground, so the working tree is untouched.
 */
const WORKSPACE = join(import.meta.dir, '../../..');
const STARTER = join(WORKSPACE, 'apps/playground');
const SCRATCH = join(WORKSPACE, '.tmp');

let app = SCRATCH;

const env = () => ({
  ...process.env,
  TEST_DATABASE_URL: requireTestDatabaseUrl(),
  DATABASE_URL: requireTestDatabaseUrl(),
  REDIS_URL: process.env.REDIS_URL,
});

async function cli(args: readonly string[]) {
  const child = Bun.spawn(['bun', 'run', 'bin/cli.ts', ...args], {
    cwd: app,
    env: env(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

async function snapshot(root: string): Promise<string[]> {
  const glob = new Bun.Glob('**/*.{ts,sql,json}');
  const entries: string[] = [];
  for await (const path of glob.scan({ cwd: root, onlyFiles: true })) {
    if (path.startsWith('node_modules/')) continue;
    entries.push(`${path}:${Bun.hash(await Bun.file(join(root, path)).text())}`);
  }
  return entries.sort();
}

/**
 * Self-contained dry runs against a pristine tree: the module-coupled slices
 * point at the playground's existing products module with --force (a dry run
 * writes nothing, but existing files are still conflicts by contract).
 */
const DRY_RUNS: readonly (readonly string[])[] = [
  ['make:schema', 'Invoice', '--fields', 'total:numeric:required,status:text:required', '--soft-delete'],
  ['make:repository', 'Product', '--table', 'products', '--force'],
  ['make:dto', 'Product', '--table', 'products', '--force'],
  ['make:policy', 'Product', '--access', 'public', '--force'],
  ['make:request', 'Product', '--table', 'products', '--force'],
  ['make:request', 'Product', '--table', 'products', '--kind', 'list', '--force'],
  ['make:response', 'Product', '--table', 'products', '--force'],
  ['make:service', 'Product', '--table', 'products', '--force'],
  ['make:controller', 'Product', '--table', 'products', '--force'],
  ['make:middleware', 'idempotency-key'],
  ['make:provider', 'search'],
  ['make:event', 'order-paid'],
  ['make:listener', 'order-auditor', '--channel', 'orders'],
  ['make:test', 'invoice-saga'],
  ['make:test', 'invoices', '--api'],
  ['make:mail', 'welcome'],
  ['make:notification', 'invoice-paid'],
  ['make:command', 'prune-carts'],
  ['make:schedule', 'hourly-sync', '--workflow', 'order-fulfillment'],
  ['make:guard', 'partner-key'],
  ['make:user-provider', 'ldap'],
  ['make:migration', 'backfill-slugs'],
];

/**
 * Real runs in two chains: a fresh Invoice module starts table-first
 * (schema → repository → policy need no module siblings), while the
 * module-coupled slices regenerate the products module's own artifacts with
 * --force — the same renderers make:crud used, so the module stays coherent.
 */
const GENERATIONS: readonly (readonly string[])[] = [
  ['make:schema', 'Invoice', '--fields', 'total:numeric:required,status:text:required', '--soft-delete'],
  ['make:repository', 'Invoice'],
  ['make:policy', 'Invoice', '--access', 'public'],
  ['make:dto', 'Product', '--table', 'products', '--force'],
  ['make:request', 'Product', '--table', 'products', '--force'],
  ['make:request', 'Product', '--table', 'products', '--kind', 'list', '--force'],
  ['make:response', 'Product', '--table', 'products', '--force'],
  ['make:service', 'Product', '--table', 'products', '--force'],
  ['make:controller', 'Product', '--table', 'products', '--force'],
  ['make:middleware', 'idempotency-key'],
  ['make:provider', 'search'],
  ['make:event', 'order-paid'],
  ['make:listener', 'order-auditor', '--channel', 'orders'],
  ['make:test', 'invoice-saga'],
  ['make:test', 'invoices', '--api'],
  ['make:job', 'send-report'],
  ['make:schedule', 'nightly-report', '--job', 'send-report', '--cron', '0 3 * * *'],
  ['make:mail', 'welcome'],
  ['make:notification', 'invoice-paid', '--channels', 'email,database,push'],
  ['make:command', 'prune-carts'],
  ['make:guard', 'partner-key'],
  ['make:user-provider', 'ldap'],
];

/** The same commands without --force: every artifact now exists, so all conflict. */
const REPEATS: readonly (readonly string[])[] = GENERATIONS.map((args) => args.filter((arg) => arg !== '--force'));

beforeAll(async () => {
  await mkdir(SCRATCH, { recursive: true });
  app = join(SCRATCH, `generators-${randomBytes(4).toString('hex')}`);
  const copy = Bun.spawn(['cp', '-R', STARTER, app], { cwd: WORKSPACE, stdout: 'pipe', stderr: 'pipe' });
  expect(await copy.exited).toBe(0);
}, 300_000);

afterAll(async () => {
  if (app !== SCRATCH) await rm(app, { recursive: true, force: true });
});

describe('scaffold generators (one scratch playground)', () => {
  test('dry runs are byte-neutral for every generator', async () => {
    const before = await snapshot(app);
    for (const args of DRY_RUNS) {
      const result = await cli([...args, '--dry-run']);
      expect(`${args.join(' ')} → ${result.code}: ${result.stderr}`).toBe(`${args.join(' ')} → 0: `);
    }
    expect(await snapshot(app)).toEqual(before);
  }, 300_000);

  test('every generator writes, registers, and refuses duplicates without --force', async () => {
    for (const args of GENERATIONS) {
      const result = await cli(args);
      expect(`${args.join(' ')} → ${result.code}: ${result.stderr}`).toBe(`${args.join(' ')} → 0: `);
    }
    for (const args of REPEATS) {
      const repeat = await cli(['--json', ...args]);
      expect(`${args.join(' ')} repeat → ${repeat.code}`).toBe(`${args.join(' ')} repeat → 2`);
    }
    // Marker-registered artifacts cannot re-register: --force overwrites the
    // file, and the duplicate marker insert fails with a catalogued error.
    const forced = await cli(['--json', 'make:middleware', 'idempotency-key', '--force']);
    expect(forced.code).toBe(1);
    expect(JSON.parse(forced.stdout)).toMatchObject({ error: { code: 'ALREADY_REGISTERED' } });

    // The registry markers received every registration.
    const middleware = await Bun.file(join(app, 'bootstrap/middleware.ts')).text();
    expect(middleware).toContain(".alias('idempotency-key', idempotencyKeyMiddleware)");
    const listeners = await Bun.file(join(app, 'app/listeners/index.ts')).text();
    expect(listeners).toContain('orderAuditorListener');
    const schema = await Bun.file(join(app, 'database/schema/index.ts')).text();
    expect(schema).toContain("export * from './invoices';");
    const schedules = await Bun.file(join(app, 'app/schedules/index.ts')).text();
    expect(schedules).toContain('nightlyReportSchedule,');
    const bin = await Bun.file(join(app, 'bin/cli.ts')).text();
    expect(bin).toContain('commands: [...frameworkCommands, ...appCommands],');
  }, 600_000);

  test('generator inputs are validated before anything is planned', async () => {
    const invalid: readonly (readonly string[])[] = [
      ['make:notification', 'x-y', '--channels', 'email,sms'],
      ['make:schedule', 'x-y'],
      ['make:schedule', 'x-y', '--job', 'missing-job'],
      ['make:schedule', 'x-y', '--workflow', 'w', '--cron', "0 3 * * *'"],
      ['make:command', 'x-y', '--signature', 'NoColon'],
      ['make:guard', 'x-y', '--header', 'bad header'],
      ['make:migration', '../escape'],
    ];
    for (const args of invalid) {
      const result = await cli(['--json', ...args]);
      expect(`${args.join(' ')} → ${result.code}`).toBe(`${args.join(' ')} → 2`);
    }
  });

  test('generated application commands run through the project CLI', async () => {
    const listed = await cli(['--json', 'list']);
    expect(listed.stdout).toContain('app:prune-carts');
    const run = await cli(['--json', 'app:prune-carts', '--dry-run']);
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ data: { dryRun: true } });
  });

  test('make:migration adds an empty custom migration to the journal', async () => {
    const result = await cli(['--json', 'make:migration', 'backfill-slugs']);
    expect(`${result.code}: ${result.stderr}`).toBe('0: ');
    const journal = await Bun.file(join(app, 'database/migrations/meta/_journal.json')).text();
    expect(journal).toContain('backfill-slugs');
  }, 300_000);

  test('registrations are visible to the runtime commands', async () => {
    const modules = await cli(['--json', 'module:list']);
    expect(modules.code).toBe(0);
    const providers = JSON.parse(modules.stdout).data.providers as string[];
    expect(providers).toContain('search');
    expect(providers).toContain('listeners');

    const middlewareListing = await cli(['--json', 'middleware:list']);
    expect(middlewareListing.code).toBe(0);
    expect(middlewareListing.stdout).toContain('idempotency-key');
  });

  test('db:generate sees the new table export and produces its migration', async () => {
    const result = await cli(['--json', 'db:generate', '--name', 'generators-gate']);
    expect(result.code).toBe(0);
    const migrations = join(app, 'database/migrations');
    const sql: string[] = [];
    for await (const path of new Bun.Glob('*.sql').scan({ cwd: migrations, onlyFiles: true })) sql.push(path);
    const gate = sql.find((file) => file.includes('generators-gate'));
    expect(gate).toBeDefined();
    expect(await Bun.file(join(migrations, gate as string)).text()).toContain('invoices');
  }, 300_000);

  test('all generated code typechecks together with the playground', async () => {
    const typecheck = Bun.spawn(['bunx', 'tsc', '-p', 'tsconfig.json'], {
      cwd: app,
      env: env(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(typecheck.stdout).text(),
      new Response(typecheck.stderr).text(),
      typecheck.exited,
    ]);
    expect(`${code}: ${stdout}${stderr}`).toBe('0: ');
  }, 300_000);
});
