import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { requireTestDatabaseUrl } from '@framework/testing';

/**
 * Release gate for the M3 lifecycle commands: queue management over real
 * Redis, the seeder pipeline over real PostgreSQL, the simple generators
 * (generate → typecheck), and the production build. Everything runs in a
 * scratch copy of the playground (same pattern as the make:crud e2e gate) so
 * parallel test files never observe mid-generation state, and the working
 * tree is left untouched.
 */
const WORKSPACE = join(import.meta.dir, '../../..');
const STARTER = join(WORKSPACE, 'apps/playground');
const SCRATCH = join(WORKSPACE, '.tmp');

let app = SCRATCH;

const env = () => ({
  ...process.env,
  TEST_DATABASE_URL: requireTestDatabaseUrl(),
  // The spawned CLI needs a *connectable* database (CI's app DATABASE_URL is
  // deliberately unusable) and the real Redis service — both from the
  // environment, never hardcoded ports.
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

beforeAll(async () => {
  await mkdir(SCRATCH, { recursive: true });
  app = join(SCRATCH, `lifecycle-${randomBytes(4).toString('hex')}`);
  const copy = Bun.spawn(['cp', '-R', STARTER, app], { cwd: WORKSPACE, stdout: 'pipe', stderr: 'pipe' });
  expect(await copy.exited).toBe(0);
}, 300_000);

afterAll(async () => {
  if (app !== SCRATCH) await rm(app, { recursive: true, force: true });
});

describe('queue management (real Redis)', () => {
  test('pause then resume flips the queue state', async () => {
    expect((await cli(['--json', 'queue:pause'])).code).toBe(0);
    const resumed = await cli(['--json', 'queue:resume']);
    expect(resumed.code).toBe(0);
    expect(JSON.parse(resumed.stdout)).toMatchObject({ status: 'ok', data: { paused: false } });
  });

  test('queue:failed lists (possibly empty) records with exit 0', async () => {
    const result = await cli(['--json', 'queue:failed', '--limit', '5']);
    expect(result.code).toBe(0);
    const body = JSON.parse(result.stdout) as { data: { failed: unknown[] } };
    expect(Array.isArray(body.data.failed)).toBe(true);
  });

  test('queue:retry on an unknown id exits 1 with a catalogued error', async () => {
    const result = await cli(['--json', 'queue:retry', 'no-such-job']);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'error', error: { code: 'QUEUE_JOB_NOT_FAILED' } });
  });
});

describe('seeder pipeline (real PostgreSQL)', () => {
  test('db:fresh drops and re-applies the schema behind the production guard', async () => {
    // Runs first so the seed tests below always see a migrated schema (CI's
    // database starts empty).
    const fresh = await cli(['--json', 'db:fresh']);
    expect(fresh.code).toBe(0);
    const body = JSON.parse(fresh.stdout) as { data: { migrations: { applied: boolean }[] } };
    expect(body.data.migrations.length).toBeGreaterThanOrEqual(3);
    expect(body.data.migrations.every((migration) => migration.applied)).toBe(true);
  });

  test('db:seed runs the registered playground seeders and is idempotent', async () => {
    const first = await cli(['--json', 'db:seed']);
    expect(first.code).toBe(0);
    expect(JSON.parse(first.stdout).data.seeders).toContain('products');

    const second = await cli(['--json', 'db:seed', 'products']);
    expect(second.code).toBe(0);
    expect(JSON.parse(second.stdout).data.seeders).toEqual(['products']);

    const unknown = await cli(['--json', 'db:seed', 'nope']);
    expect(unknown.code).toBe(1);
    expect(JSON.parse(unknown.stdout)).toMatchObject({ status: 'error', error: { code: 'SEEDER_UNKNOWN' } });
  });
});

describe('simple generators (generate → typecheck)', () => {
  test('make:job, make:seeder and make:factory produce typechecking files and register cleanly', async () => {
    expect((await cli(['make:job', 'order-paid'])).code).toBe(0);
    expect((await cli(['make:seeder', 'demo-orders'])).code).toBe(0);
    expect((await cli(['make:factory', 'widget'])).code).toBe(0);

    // Conflicts are refused without --force.
    expect((await cli(['--json', 'make:job', 'order-paid'])).code).toBe(2);

    // The generated tree compiles with the playground sources.
    const typecheck = Bun.spawn(['bunx', 'tsc', '-p', 'tsconfig.json'], {
      cwd: app,
      env: env(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderr = await new Response(typecheck.stderr).text();
    expect(`${await typecheck.exited}: ${stderr}`).toBe('0: ');

    // The seeder generator registered the new seeder (visible in db:seed usage).
    const seeded = await cli(['--json', 'db:seed', 'demo-orders']);
    expect(seeded.code).toBe(0);
  }, 300_000);

  test('the production build compiles the server entry point', async () => {
    const result = await cli(['--json', 'build', '--target', 'server']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).data.built).toEqual([join('dist', 'server')]);
    expect(await Bun.file(join(app, 'dist/server')).exists()).toBe(true);
  }, 300_000);
});
