import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { requireTestDatabaseUrl } from '@framework/testing';

/**
 * Release gate for the one-command CRUD contract: a scratch copy of the
 * starter application (inside the workspace so packages resolve) gets new
 * and existing-table resources generated and verified against PostgreSQL.
 */
const WORKSPACE = join(import.meta.dir, '../../..');
const STARTER = join(WORKSPACE, 'apps/playground');
const SCRATCH = join(WORKSPACE, '.tmp');
const GENERATOR_TIMEOUT_MS = 300_000;

let app: string;

async function run(command: string[], cwd = app) {
  const child = Bun.spawn(command, {
    cwd,
    // Route/OpenAPI inspection never connects; the URL only satisfies config validation.
    env: {
      ...process.env,
      TEST_DATABASE_URL: requireTestDatabaseUrl(),
      DATABASE_URL: 'postgres://app:unused@127.0.0.1:1/unused',
    },
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

async function hashes(paths: readonly string[]): Promise<Record<string, number | bigint>> {
  return Object.fromEntries(
    await Promise.all(paths.map(async (p) => [p, Bun.hash(await Bun.file(join(app, p)).text())])),
  );
}

const UNRELATED = [
  'app/modules/products/routes.ts',
  'app/modules/products/schemas.ts',
  'database/schema/products.ts',
  'database/migrations/0000_create-products.sql',
  'config/index.ts',
  'bootstrap/http.ts',
];

beforeAll(async () => {
  await mkdir(SCRATCH, { recursive: true });
  app = join(SCRATCH, `e2e-${randomBytes(4).toString('hex')}`);
  const copy = await run(['cp', '-R', STARTER, app], WORKSPACE);
  expect(copy.code).toBe(0);
}, GENERATOR_TIMEOUT_MS);

afterAll(async () => {
  if (app) await rm(app, { recursive: true, force: true });
});

interface CrudResult {
  status: string;
  data: {
    generation: { status: string; changes: { path: string; action: string }[] };
    verification: { status: string; typecheck: string; passed: number; failed: number; cleanup: string; mode: string };
  };
}

describe('make:crud end to end', () => {
  test(
    'new table: generate, migrate, typecheck and pass all endpoint tests in one command',
    async () => {
      const before = await hashes(UNRELATED);
      const result = await run([
        'bun',
        'run',
        'bin/cli.ts',
        '--json',
        'make:crud',
        'Category',
        '--fields',
        'title:text:required,position:integer:default=0,active:boolean:required,budget:numeric:nullable,launchAt:timestamp:nullable',
        '--access',
        'public',
        '--soft-delete',
        '--verify',
      ]);
      expect(result.stderr).not.toContain('VERIFICATION_FAILED');
      expect(result.code).toBe(0);
      const body = JSON.parse(result.stdout) as CrudResult;
      expect(body.status).toBe('ok');
      expect(body.data.generation.status).toBe('generated');
      expect(body.data.verification).toMatchObject({
        status: 'passed',
        typecheck: 'passed',
        failed: 0,
        cleanup: 'clean',
      });
      expect(body.data.verification.passed).toBeGreaterThanOrEqual(6);
      // The categories migration is whatever the journal appended for this
      // run (the starter may legitimately carry migrations of its own).
      const categoriesMigration = await Promise.all(
        (await Array.fromAsync(new Bun.Glob('*.sql').scan({ cwd: join(app, 'database/migrations') }))).map(
          async (file) =>
            [
              file,
              (await Bun.file(join(app, 'database/migrations', file)).text()).includes('CREATE TABLE "categories"'),
            ] as const,
        ),
      ).then((pairs) => pairs.find(([, isCategories]) => isCategories)?.[0]);
      if (!categoriesMigration) throw new Error('no categories migration was generated');
      expect(await Bun.file(join(app, 'database/migrations', categoriesMigration)).text()).toContain('"deleted_at"');
      expect(await hashes(UNRELATED)).toEqual(before);
    },
    GENERATOR_TIMEOUT_MS,
  );

  test(
    'existing table with integer key: introspect, generate and verify over the network',
    async () => {
      await Bun.write(
        join(app, 'database/schema/tags.ts'),
        [
          "import { integer, pgTable, serial, timestamp, varchar } from 'drizzle-orm/pg-core';",
          '',
          "export const tags = pgTable('tags', {",
          "  id: serial('id').primaryKey(),",
          "  label: varchar('label', { length: 80 }).notNull(),",
          "  weight: integer('weight').notNull().default(1),",
          "  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),",
          '});',
          '',
        ].join('\n'),
      );
      const index = join(app, 'database/schema/index.ts');
      await Bun.write(index, `${await Bun.file(index).text()}export * from './tags';\n`);
      expect((await run(['bun', 'run', 'bin/cli.ts', 'db:generate', '--name', 'create-tags'])).code).toBe(0);

      const result = await run([
        'bun',
        'run',
        'bin/cli.ts',
        '--json',
        'make:crud',
        'Tag',
        '--table',
        'tags',
        '--access',
        'public',
        '--verify',
        '--test-mode',
        'network',
      ]);
      expect(result.code).toBe(0);
      const body = JSON.parse(result.stdout) as CrudResult;
      expect(body.data.generation.changes.some((c) => c.path.startsWith('database/schema/'))).toBe(false);
      expect(body.data.verification).toMatchObject({ status: 'passed', mode: 'network', failed: 0, cleanup: 'clean' });
    },
    GENERATOR_TIMEOUT_MS,
  );

  test(
    'regenerating an existing module is refused without --force and route collisions are detected',
    async () => {
      const again = await run([
        'bun',
        'run',
        'bin/cli.ts',
        'make:crud',
        'Category',
        '--fields',
        'title:text:required',
        '--access',
        'public',
      ]);
      expect(again.code).toBe(2);
      expect(again.stderr).toContain('already exists');

      const collision = await run([
        'bun',
        'run',
        'bin/cli.ts',
        'make:crud',
        'Shelf',
        '--module',
        'shelves',
        '--route',
        '/api/v1/products',
        '--fields',
        'name:text:required',
        '--access',
        'public',
        '--dry-run',
      ]);
      expect(collision.code).toBe(2);
      expect(collision.stderr).toContain('Route collision');
    },
    GENERATOR_TIMEOUT_MS,
  );

  test(
    'the generated application still typechecks, documents every route and passes its full suite',
    async () => {
      expect((await run(['bun', 'run', 'bin/cli.ts', 'openapi:check'])).code).toBe(0);
      const suite = await run(['bun', 'test']);
      expect(suite.stderr).toMatch(/\b0 fail\b/);
      expect(suite.code).toBe(0);
    },
    GENERATOR_TIMEOUT_MS,
  );
});
