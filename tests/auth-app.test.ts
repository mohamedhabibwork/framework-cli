import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { requireTestDatabaseUrl } from '@framework/testing';

/**
 * Phase 3 release gate: sessions/tokens/policies verified through endpoints in
 * a clean generated application. `create` produces the app, `make:auth`
 * installs the auth module (dependency, registrations, migration), and
 * `make:crud --access authenticated --verify` proves the resource pipeline —
 * including its 401/403 endpoint cases — against real PostgreSQL.
 *
 * `bun.lock` is backed up and restored around the run (make:auth installs).
 */
const WORKSPACE = join(import.meta.dir, '../../..');
const PLAYGROUND = join(WORKSPACE, 'apps/playground');
const SCRATCH = join(WORKSPACE, '.tmp');
const TIMEOUT = 300_000;

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

const cli = (args: string[]) =>
  capture(
    Bun.spawn(['bun', 'run', 'cli', '--', ...args], {
      cwd: PLAYGROUND,
      env: childEnv(),
      stdout: 'pipe',
      stderr: 'pipe',
    }),
  );

const cliIn = (args: string[]) =>
  capture(
    Bun.spawn(['bun', 'run', 'cli', '--', ...args], { cwd: app, env: childEnv(), stdout: 'pipe', stderr: 'pipe' }),
  );

beforeAll(async () => {
  await mkdir(SCRATCH, { recursive: true });
  await Bun.write(join(SCRATCH, 'bun.lock.auth-backup'), await Bun.file(join(WORKSPACE, 'bun.lock')).text());
  await rm(join(WORKSPACE, 'apps/created-auth'), { recursive: true, force: true });

  const created = await cli(['create', '../../apps/created-auth', '--no-install']);
  expect(created.code).toBe(0);
  app = join(WORKSPACE, 'apps/created-auth');
  const install = await capture(
    Bun.spawn(['bun', 'install'], { cwd: WORKSPACE, env: childEnv(), stdout: 'pipe', stderr: 'pipe' }),
  );
  expect(install.code).toBe(0);
}, TIMEOUT);

afterAll(async () => {
  await rm(join(WORKSPACE, 'apps/created-auth'), { recursive: true, force: true }).catch(() => undefined);
  const backup = Bun.file(join(SCRATCH, 'bun.lock.auth-backup'));
  if (await backup.exists()) {
    await Bun.write(join(WORKSPACE, 'bun.lock'), await backup.text());
    await capture(Bun.spawn(['bun', 'install'], { cwd: WORKSPACE, stdout: 'pipe', stderr: 'pipe' })).catch(
      () => undefined,
    );
  }
}, TIMEOUT);

describe('Phase 3 gate: authenticated CRUD in a generated app', () => {
  test(
    'authenticated make:crud is refused before the auth module exists',
    async () => {
      const refused = await cliIn([
        'make:crud',
        'Note',
        '--fields',
        'body:text:required',
        '--access',
        'authenticated',
        '--dry-run',
      ]);
      expect(refused.code).toBe(2);
      expect(refused.stderr).toContain('make:auth');
    },
    TIMEOUT,
  );

  test(
    'make:auth installs the module, registrations, dependency and migration',
    async () => {
      const dryRun = await cliIn(['--json', 'make:auth', '--dry-run']);
      expect(dryRun.code).toBe(0);
      const dryBody = JSON.parse(dryRun.stdout) as { data: { dryRun: boolean; changes: unknown[] } };
      expect(dryBody.data.dryRun).toBe(true);

      const installed = await cliIn(['--json', 'make:auth', '--guards', 'session,api-token']);
      expect(installed.stderr).not.toContain('error:');
      expect(installed.code).toBe(0);
      const body = JSON.parse(installed.stdout) as {
        data: { generation: { status: string; changes: { path: string; action: string }[]; migration: string } };
      };
      expect(body.data.generation.status).toBe('generated');
      const paths = body.data.generation.changes.map((c) => c.path);
      for (const expected of [
        'app/modules/auth/provider.ts',
        'app/modules/auth/routes.ts',
        'config/index.ts',
        'database/schema/index.ts',
        'bootstrap/providers.ts',
        'bootstrap/http.ts',
        'package.json',
      ]) {
        expect(paths).toContain(expected);
      }

      // Dependency, registrations and migration are real.
      const pkg = (await Bun.file(join(app, 'package.json')).json()) as { dependencies: Record<string, string> };
      expect(pkg.dependencies['@framework/auth']).toBe('workspace:*');
      const schemaIndex = await Bun.file(join(app, 'database/schema/index.ts')).text();
      expect(schemaIndex).toContain('apiTokens');
      const providers = await Bun.file(join(app, 'bootstrap/providers.ts')).text();
      expect(providers).toContain('authProvider');
      const http = await Bun.file(join(app, 'bootstrap/http.ts')).text();
      expect(http).toContain('/api/v1/auth');
      const config = await Bun.file(join(app, 'config/index.ts')).text();
      expect(config).toContain('auth: authConfigSchema');

      const migration = await Bun.file(join(app, 'database/migrations/0000_create-auth-tables.sql')).text();
      for (const table of ['"users"', '"sessions"', '"api_tokens"']) {
        expect(migration).toContain(table);
      }
    },
    TIMEOUT,
  );

  test(
    'make:crud --access authenticated --verify passes with 401/403 endpoint cases',
    async () => {
      const crud = await cliIn([
        '--json',
        'make:crud',
        'Note',
        '--module',
        'notes',
        '--fields',
        'title:text:required,body:text:required',
        '--access',
        'authenticated',
        '--verify',
      ]);
      if (crud.code !== 0)
        console.error('\n[gate] crud stderr:\n', crud.stderr, '\n[gate] crud stdout:\n', crud.stdout);
      expect(crud.stderr).not.toContain('VERIFICATION_FAILED');
      expect(crud.code).toBe(0);
      const body = JSON.parse(crud.stdout) as {
        data: {
          generation: { mount: string };
          verification: { status: string; typecheck: string; passed: number; failed: number; cleanup: string };
        };
      };
      expect(body.data.generation.mount).toBe('/api/v1/notes');
      expect(body.data.verification).toMatchObject({
        status: 'passed',
        typecheck: 'passed',
        failed: 0,
        cleanup: 'clean',
      });
      // Five CRUD assertions plus the 401/403 auth cases.
      expect(body.data.verification.passed).toBeGreaterThanOrEqual(7);

      const policy = await Bun.file(join(app, 'app/modules/notes/policies/note.policy.ts')).text();
      expect(policy).toContain('hasAbility');
      const routes = await Bun.file(join(app, 'app/modules/notes/routes.ts')).text();
      expect(routes).toContain('requireAuth()');
    },
    TIMEOUT,
  );

  test(
    'the full generated suite (health + notes + auth fixtures) passes',
    async () => {
      const suite = await capture(
        Bun.spawn(['bun', 'test'], { cwd: app, env: childEnv(), stdout: 'pipe', stderr: 'pipe' }),
      );
      expect(`${suite.code}: ${suite.stderr}`).toMatch(/^\s*0: /);
      expect(suite.stderr).toMatch(/\b0 fail\b/);
      expect(suite.stderr).toContain('Note API');

      // The composed app exposes the auth endpoints and OpenAPI documents them.
      const routes = await cliIn(['route:list', '--json']);
      expect(routes.code).toBe(0);
      const table = JSON.parse(routes.stdout) as { data: { routes: { method: string; path: string }[] } };
      const paths = table.data.routes.map((route) => `${route.method} ${route.path}`);
      for (const expected of ['POST /api/v1/auth/login', 'POST /api/v1/auth/register', 'GET /api/v1/auth/me']) {
        expect(paths).toContain(expected);
      }
    },
    TIMEOUT,
  );
});
