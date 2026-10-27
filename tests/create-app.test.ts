import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { requireTestDatabaseUrl } from '@framework/testing';

/**
 * Release gate for the app startup generator: a clean generated application,
 * created as a member of the framework workspace (so workspace:* packages
 * resolve after a root install), must typecheck, pass its own suite, generate
 * an audit-table migration, and accept a full `make:crud --verify` run
 * against real PostgreSQL. `bun.lock` is restored afterwards.
 *
 * The `--with-demo` describe proves the one-command path: `create --with-demo`
 * produces an application whose sample module's endpoint suite passes as-is.
 *
 * Commands are literal argument arrays; Bun.spawn executes exactly this argv.
 */
const WORKSPACE = join(import.meta.dir, '../../..');
const PLAYGROUND = join(WORKSPACE, 'apps/playground');
const SCRATCH = join(WORKSPACE, '.tmp');
const TIMEOUT = 300_000;

/** Set once a describe's beforeAll has generated the app under test. */
let app = SCRATCH;

function childEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    TEST_DATABASE_URL: requireTestDatabaseUrl(),
    // Route/config inspection never connects; the URL only satisfies validation.
    DATABASE_URL: 'postgres://app:unused@127.0.0.1:1/unused',
    // Bun hides passing test names when it detects an AI agent; the gates
    // assert on those names, so the nested `bun test` must report normally.
    CLAUDECODE: undefined,
    AGENT: undefined,
  };
}

async function capture(child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>) {
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

beforeAll(async () => {
  await mkdir(SCRATCH, { recursive: true });
  // One lockfile backup for the whole file; restored in the final afterAll.
  await Bun.write(join(SCRATCH, 'bun.lock.create-backup'), await Bun.file(join(WORKSPACE, 'bun.lock')).text());
  await rm(join(WORKSPACE, 'apps/created-app'), { recursive: true, force: true });
  await rm(join(WORKSPACE, 'apps/created-demo'), { recursive: true, force: true });
});

afterAll(async () => {
  await rm(join(WORKSPACE, 'apps/created-app'), { recursive: true, force: true }).catch(() => undefined);
  await rm(join(WORKSPACE, 'apps/created-demo'), { recursive: true, force: true }).catch(() => undefined);
  const backup = Bun.file(join(SCRATCH, 'bun.lock.create-backup'));
  if (await backup.exists()) {
    await Bun.write(join(WORKSPACE, 'bun.lock'), await backup.text());
    await capture(Bun.spawn(['bun', 'install'], { cwd: WORKSPACE, stdout: 'pipe', stderr: 'pipe' })).catch(
      () => undefined,
    );
  }
}, TIMEOUT);

describe('create (app startup generator)', () => {
  beforeAll(async () => {
    // Spawned from the playground (which owns the `cli` script); the target
    // escapes to a workspace-level apps/ member so dependencies resolve.
    const created = await capture(
      Bun.spawn(['bun', 'run', 'cli', '--', 'create', '../../apps/created-app', '--no-install'], {
        cwd: PLAYGROUND,
        env: childEnv(),
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    );
    expect(created.stderr).not.toContain('error');
    expect(created.code).toBe(0);
    app = join(WORKSPACE, 'apps/created-app');

    const install = await capture(
      Bun.spawn(['bun', 'install'], { cwd: WORKSPACE, env: childEnv(), stdout: 'pipe', stderr: 'pipe' }),
    );
    expect(install.code).toBe(0);
  }, TIMEOUT);

  test('refuses non-empty directories and invalid names', async () => {
    const invalid = await capture(
      Bun.spawn(['bun', 'run', 'cli', '--', 'create', 'Bad_Name', '--no-install'], {
        cwd: PLAYGROUND,
        env: childEnv(),
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    );
    expect(invalid.code).toBe(2);

    const occupied = await capture(
      Bun.spawn(['bun', 'run', 'cli', '--', 'create', '../../apps/playground', '--no-install'], {
        cwd: PLAYGROUND,
        env: childEnv(),
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    );
    expect(occupied.code).toBe(2);
    expect(occupied.stderr).toContain('not empty');
  });

  test(
    'generated application typechecks, validates configuration and passes its suite',
    async () => {
      for (const path of [
        'package.json',
        'bootstrap/http.ts',
        'bootstrap/providers.ts',
        'app/providers/cache.provider.ts',
        'app/providers/database.provider.ts',
        'app/providers/events.provider.ts',
        'app/providers/logging.provider.ts',
        'app/providers/storage.provider.ts',
        'app/jobs/index.ts',
        'bin/server.ts',
        'bin/worker.ts',
        'bin/cli.ts',
        'database/schema/index.ts',
        'tests/health.api.test.ts',
        'deployment/compose.yaml',
        '.env.example',
      ]) {
        expect(await Bun.file(join(app, path)).exists()).toBe(true);
      }

      const typecheck = await capture(
        Bun.spawn(['bunx', 'tsc', '-p', 'tsconfig.json'], {
          cwd: app,
          env: childEnv(),
          stdout: 'pipe',
          stderr: 'pipe',
        }),
      );
      expect(`${typecheck.code}: ${typecheck.stderr}`).toBe('0: ');

      const config = await capture(
        Bun.spawn(['bun', 'run', 'cli', '--', 'config:check'], {
          cwd: app,
          env: childEnv(),
          stdout: 'pipe',
          stderr: 'pipe',
        }),
      );
      expect(config.code).toBe(0);

      const suite = await capture(
        Bun.spawn(['bun', 'test'], { cwd: app, env: childEnv(), stdout: 'pipe', stderr: 'pipe' }),
      );
      expect(`${suite.code}: ${suite.stderr}`).toMatch(/^\s*0: /);
      expect(suite.stderr).toMatch(/\b0 fail\b/);
    },
    TIMEOUT,
  );

  test(
    'the generated CLI lists health, audit and realtime routes',
    async () => {
      const routes = await capture(
        Bun.spawn(['bun', 'run', 'cli', '--', 'route:list', '--json'], {
          cwd: app,
          env: childEnv(),
          stdout: 'pipe',
          stderr: 'pipe',
        }),
      );
      expect(routes.code).toBe(0);
      const table = JSON.parse(routes.stdout) as { data: { routes: { method: string; path: string }[] } };
      const paths = table.data.routes.map((route) => `${route.method} ${route.path}`);
      for (const expected of ['GET /health/live', 'GET /health/ready', 'GET /audit', 'GET /ws']) {
        expect(paths).toContain(expected);
      }
    },
    TIMEOUT,
  );

  test(
    'kit-backed subsystems are registered and their commands work',
    async () => {
      // (a) The three kit-backed providers are registered in the providers
      // file (this is also the CLI's textual capability gate).
      const providersSource = await Bun.file(join(app, 'bootstrap/providers.ts')).text();
      for (const provider of ['cacheProvider', 'loggingProvider', 'storageProvider']) {
        expect(providersSource).toContain(provider);
      }

      // (b) storage:check is read-only: it validates the generated disk
      // configuration without creating the root.
      const storage = await capture(
        Bun.spawn(['bun', 'run', 'cli', '--', '--json', 'storage:check'], {
          cwd: app,
          env: childEnv(),
          stdout: 'pipe',
          stderr: 'pipe',
        }),
      );
      expect(storage.code).toBe(0);
      const storageBody = JSON.parse(storage.stdout) as {
        data: {
          default: string;
          valid: boolean;
          disks: {
            name: string;
            driver: string;
            visibility: string;
            root: string;
            publicBaseUrl: string;
            status: string;
          }[];
        };
      };
      expect(storageBody.data).toMatchObject({ default: 'local', valid: true });
      expect(storageBody.data.disks).toHaveLength(1);
      expect(storageBody.data.disks[0]).toMatchObject({
        name: 'local',
        driver: 'local',
        visibility: 'private',
        publicBaseUrl: '-',
      });
      expect(storageBody.data.disks[0]?.status).toMatch(/^ok/);
      expect(storageBody.data.disks[0]?.root).toMatch(/storage$/);

      // (c) cache:clear --dry-run previews without touching anything.
      const dryRun = await capture(
        Bun.spawn(['bun', 'run', 'cli', '--', 'cache:clear', '--dry-run'], {
          cwd: app,
          env: childEnv(),
          stdout: 'pipe',
          stderr: 'pipe',
        }),
      );
      expect(dryRun.code).toBe(0);
      expect(dryRun.stdout).toContain('Dry run');

      // The default (redis) driver refuses a namespace clear by design
      // (CACHE_UNSUPPORTED_OPERATION), so --confirm runs against the memory
      // driver, which clears natively and needs no infrastructure.
      const confirm = await capture(
        Bun.spawn(['bun', 'run', 'cli', '--', '--json', 'cache:clear', '--confirm'], {
          cwd: app,
          env: { ...childEnv(), CACHE_DRIVER: 'memory' },
          stdout: 'pipe',
          stderr: 'pipe',
        }),
      );
      expect(confirm.code).toBe(0);
      const confirmBody = JSON.parse(confirm.stdout) as {
        data: { cleared: boolean; driver: string; entries: number };
      };
      expect(confirmBody.data).toEqual({ cleared: true, driver: 'memory', entries: 0 });

      // (d) Without the auth module, session:prune is unsupported (exit 3)
      // with the quality message pointing at make:auth.
      const prune = await capture(
        Bun.spawn(['bun', 'run', 'cli', '--', 'session:prune', '--dry-run'], {
          cwd: app,
          env: childEnv(),
          stdout: 'pipe',
          stderr: 'pipe',
        }),
      );
      expect(prune.code).toBe(3);
      expect(prune.stderr).toContain('make:auth');
    },
    TIMEOUT,
  );

  test(
    'audit table migrates and make:crud --verify passes in the generated app',
    async () => {
      const generated = await capture(
        Bun.spawn(['bun', 'run', 'cli', '--', 'db:generate', '--name', 'create-audit-logs'], {
          cwd: app,
          env: childEnv(),
          stdout: 'pipe',
          stderr: 'pipe',
        }),
      );
      expect(generated.code).toBe(0);
      const migration = await Bun.file(join(app, 'database/migrations/0000_create-audit-logs.sql')).text();
      expect(migration).toContain('"audit_logs"');

      const crud = await capture(
        Bun.spawn(
          [
            'bun',
            'run',
            'cli',
            '--',
            '--json',
            'make:crud',
            'Item',
            '--module',
            'items',
            '--fields',
            'name:text:required,price:numeric:required',
            '--access',
            'public',
            '--verify',
          ],
          { cwd: app, env: childEnv(), stdout: 'pipe', stderr: 'pipe' },
        ),
      );
      expect(crud.stderr).not.toContain('VERIFICATION_FAILED');
      expect(crud.code).toBe(0);
      const body = JSON.parse(crud.stdout) as {
        data: { verification: { status: string; typecheck: string; failed: number; cleanup: string } };
      };
      expect(body.data.verification).toMatchObject({
        status: 'passed',
        typecheck: 'passed',
        failed: 0,
        cleanup: 'clean',
      });

      // The whole generated application (health + item suites) still passes.
      const suite = await capture(
        Bun.spawn(['bun', 'test'], { cwd: app, env: childEnv(), stdout: 'pipe', stderr: 'pipe' }),
      );
      expect(`${suite.code}: ${suite.stderr}`).toMatch(/^\s*0: /);
      expect(suite.stderr).toMatch(/\b0 fail\b/);
    },
    TIMEOUT,
  );
});

describe('create --with-demo (one-command full generation)', () => {
  beforeAll(async () => {
    // The real one-command experience: create generates the app, installs
    // through the workspace, and generates the demo module + migration.
    const created = await capture(
      Bun.spawn(['bun', 'run', 'cli', '--', '--json', 'create', '../../apps/created-demo', '--with-demo'], {
        cwd: PLAYGROUND,
        env: childEnv(),
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    );
    expect(created.stderr).not.toContain('error');
    expect(created.code).toBe(0);
    const body = JSON.parse(created.stdout) as { data: { demo: { module: string } | null } };
    expect(body.data.demo).toMatchObject({ module: 'products' });
    app = join(WORKSPACE, 'apps/created-demo');
  }, TIMEOUT);

  test(
    'the generated app ships a products module with migration and passing endpoint tests',
    async () => {
      for (const path of [
        'app/modules/products/routes.ts',
        'app/modules/products/provider.ts',
        'app/modules/products/tests/product.crud.api.test.ts',
        'database/schema/products.ts',
        'database/factories/product.factory.ts',
      ]) {
        expect(await Bun.file(join(app, path)).exists()).toBe(true);
      }
      // The schema index re-exports auditLogs, so the first drizzle-kit
      // migration contains both the audit trail and the products table.
      const schemaIndex = await Bun.file(join(app, 'database/schema/index.ts')).text();
      expect(schemaIndex).toContain('./products');
      const migrations = await Array.fromAsync(new Bun.Glob('*.sql').scan({ cwd: join(app, 'database/migrations') }));
      const initial = migrations.find((file) => file.includes('create-products'));
      expect(initial).toBeDefined();
      const sql = await Bun.file(join(app, 'database/migrations', initial as string)).text();
      expect(sql).toContain('"audit_logs"');
      expect(sql).toContain('"products"');

      // The suite applies the migration to an isolated database per run.
      const suite = await capture(
        Bun.spawn(['bun', 'test'], { cwd: app, env: childEnv(), stdout: 'pipe', stderr: 'pipe' }),
      );
      expect(`${suite.code}: ${suite.stderr}`).toMatch(/^\s*0: /);
      expect(suite.stderr).toMatch(/\b0 fail\b/);
      expect(suite.stderr).toContain('Product API');
    },
    TIMEOUT,
  );

  test(
    'the sample module is registered: routes and OpenAPI list it',
    async () => {
      const routes = await capture(
        Bun.spawn(['bun', 'run', 'cli', '--', 'route:list', '--json'], {
          cwd: app,
          env: childEnv(),
          stdout: 'pipe',
          stderr: 'pipe',
        }),
      );
      expect(routes.code).toBe(0);
      const table = JSON.parse(routes.stdout) as { data: { routes: { method: string; path: string }[] } };
      const paths = table.data.routes.map((route) => `${route.method} ${route.path}`);
      for (const expected of ['POST /api/v1/products', 'GET /api/v1/products', 'PATCH /api/v1/products/:id']) {
        expect(paths).toContain(expected);
      }

      const openapi = await capture(
        Bun.spawn(['bun', 'run', 'cli', '--', 'openapi:generate', '--output', 'docs/openapi.json'], {
          cwd: app,
          env: childEnv(),
          stdout: 'pipe',
          stderr: 'pipe',
        }),
      );
      expect(openapi.code).toBe(0);
      const spec = (await Bun.file(join(app, 'docs/openapi.json')).json()) as { paths: Record<string, unknown> };
      expect(Object.keys(spec.paths)).toContain('/api/v1/products');
    },
    TIMEOUT,
  );
});
