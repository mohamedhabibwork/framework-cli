import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GLOBAL_OPTIONS, parseArgs, splitCommand } from '../src/args';
import { frameworkCommands } from '../src/commands';
import { CliError, EXIT, type ExitCode } from '../src/errors';
import { parseDefinitionFile, parseFieldSpec } from '../src/generators/crud/definition';
import { parseJunit } from '../src/generators/crud/verify';
import { columnName, pluralize, resourceNames } from '../src/generators/naming';
import { importPath, resolveInsideProject } from '../src/generators/paths';
import { applyChanges, buildChanges } from '../src/generators/plan';
import { addImport, insertAfterMarker } from '../src/generators/registration';
import type { ProjectAdapter } from '../src/project';
import { runCli } from '../src/run';

const PLAYGROUND = join(import.meta.dir, '../../../apps/playground');

function expectCliError(fn: () => unknown, exitCode: ExitCode, pattern: RegExp) {
  try {
    fn();
    throw new Error('expected CliError');
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(exitCode);
    expect((error as CliError).message).toMatch(pattern);
  }
}

describe('argument parsing', () => {
  test('finds the command after global options and parses values', () => {
    const { command, rest } = splitCommand(['--', '--cwd', '/x', 'make:crud', 'Product', '--fields=a:text:required']);
    expect(command).toBe('make:crud');
    const parsed = parseArgs(rest, [...GLOBAL_OPTIONS, { name: 'fields', type: 'string', description: '' }]);
    expect(parsed.positionals).toEqual(['Product']);
    expect(parsed.options).toEqual({ cwd: '/x', fields: 'a:text:required' });
  });

  test('unknown options, missing values and invalid enum values are usage errors (exit 2)', () => {
    const specs = [{ name: 'mode', type: 'string', values: ['a', 'b'], description: '' }] as const;
    expectCliError(() => parseArgs(['--nope'], specs), EXIT.USAGE, /Unknown option/);
    expectCliError(() => parseArgs(['--mode'], specs), EXIT.USAGE, /requires a value/);
    expectCliError(() => parseArgs(['--mode', 'c'], specs), EXIT.USAGE, /must be one of/);
    expectCliError(() => parseArgs(['--mode', 'a', '--mode', 'b'], specs), EXIT.USAGE, /more than once/);
  });
});

describe('naming and paths', () => {
  test('derives consistent names', () => {
    expect(resourceNames('OrderItem')).toMatchObject({
      camel: 'orderItem',
      kebab: 'order-item',
      constant: 'ORDER_ITEM',
      pluralCamel: 'orderItems',
      table: 'order_items',
      module: 'order-items',
    });
    expect(pluralize('category')).toBe('categories');
    expect(pluralize('box')).toBe('boxes');
    expect(columnName('launchAt')).toBe('launch_at');
    expectCliError(() => resourceNames('product'), EXIT.USAGE, /PascalCase/);
    expectCliError(() => resourceNames('Product', { module: 'Bad_Module' }), EXIT.USAGE, /kebab-case/);
  });

  test('rejects traversal and absolute paths', () => {
    expectCliError(() => resolveInsideProject('/root/app', '../etc/passwd'), EXIT.USAGE, /escapes/);
    expectCliError(() => resolveInsideProject('/root/app', '/etc/passwd'), EXIT.USAGE, /relative/);
    expect(importPath('bootstrap/providers.ts', 'app/modules/x/index.ts')).toBe('../app/modules/x');
    expect(importPath('app/modules/x/routes.ts', 'app/modules/x/schemas.ts')).toBe('./schemas');
  });
});

describe('field definitions', () => {
  test('parses compact syntax with modifiers', () => {
    const fields = parseFieldSpec(
      'name:text:required, price:numeric:default=9.99, note:text:nullable, on:boolean:default=true',
    );
    expect(fields.map((f) => [f.name, f.column, f.type, f.nullable, f.hasDefault, f.defaultLiteral])).toEqual([
      ['name', 'name', 'text', false, false, undefined],
      ['price', 'price', 'numeric', false, true, '9.99'],
      ['note', 'note', 'text', true, false, undefined],
      ['on', 'on', 'boolean', false, true, true],
    ]);
  });

  test('rejects unsupported types, reserved names, duplicates and missing modifiers', () => {
    expectCliError(() => parseFieldSpec('a:json:required'), EXIT.USAGE, /Unsupported type/);
    expectCliError(() => parseFieldSpec('id:uuid:required'), EXIT.USAGE, /generated automatically/);
    expectCliError(() => parseFieldSpec('a:text:required,a:text:nullable'), EXIT.USAGE, /declared twice/);
    expectCliError(() => parseFieldSpec('a:text'), EXIT.USAGE, /Invalid field/);
    expectCliError(() => parseFieldSpec('a:integer:default=x'), EXIT.USAGE, /must be an integer/);
    expectCliError(() => parseFieldSpec('a:uuid:default=x'), EXIT.USAGE, /not supported/);
  });

  test('definition files are strict about unknown features', () => {
    expect(parseDefinitionFile({ access: 'public', fields: [{ name: 'title', type: 'text' }] }).fields).toHaveLength(1);
    expectCliError(
      () => parseDefinitionFile({ access: 'public', fields: [{ name: 'title', type: 'text', unique: true }] }),
      EXIT.USAGE,
      /Invalid resource definition/,
    );
  });
});

describe('registration edits', () => {
  test('imports go after the last (multi-line) import and entries after markers', () => {
    const source =
      "import { a } from 'a';\nimport {\n  b,\n} from 'b';\n\nexport const list = [\n  // @framework:providers\n  x,\n];\n";
    const withImport = addImport(source, "import { c } from 'c';");
    expect(withImport.split('\n')[4]).toBe("import { c } from 'c';");
    const registered = insertAfterMarker(withImport, '@framework:providers', 'c,', 'file.ts');
    expect(registered).toContain('  // @framework:providers\n  c,\n  x,');
    expectCliError(
      () => insertAfterMarker(registered, '@framework:providers', 'c,', 'file.ts'),
      EXIT.FAILURE,
      /already contains/,
    );
    expectCliError(
      () => insertAfterMarker('no markers', '@framework:routes', 'x', 'file.ts'),
      EXIT.FAILURE,
      /not found/,
    );
  });
});

describe('staged file plans', () => {
  test('conflicts require --force; rollback restores updates and removes creations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fw-plan-'));
    try {
      await Bun.write(join(root, 'existing.ts'), 'original');
      await expect(buildChanges(root, [{ path: 'existing.ts', content: 'new' }], [], false)).rejects.toThrow(
        /Refusing to overwrite/,
      );

      const changes = await buildChanges(
        root,
        [{ path: 'nested/created.ts', content: 'created' }],
        [{ path: 'existing.ts', transform: (s) => `${s}+updated` }],
        false,
      );
      expect(changes.map((c) => c.action)).toEqual(['create', 'update']);
      const applied = await applyChanges(root, changes);
      expect(await Bun.file(join(root, 'existing.ts')).text()).toBe('original+updated');
      await applied.rollback();
      expect(await Bun.file(join(root, 'existing.ts')).text()).toBe('original');
      expect(await Bun.file(join(root, 'nested/created.ts')).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('verification report parsing', () => {
  test('reads passed and failed test cases from JUnit XML', () => {
    const xml =
      '<testsuite><testcase name="a &gt; b" time="0.1" /><testcase name="c"><failure message="x"/></testcase></testsuite>';
    expect(parseJunit(xml)).toEqual([
      { name: 'a > b', status: 'passed' },
      { name: 'c', status: 'failed' },
    ]);
  });
});

async function cli(args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn(['bun', 'run', 'bin/cli.ts', ...args], {
    cwd: PLAYGROUND,
    env: { ...process.env, ...env },
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

describe('CLI process contract', () => {
  test('exit codes: 0 success, 2 usage, 3 unsupported; JSON envelope on stdout', async () => {
    const list = await cli(['--json', 'list']);
    expect(list.code).toBe(0);
    const body = JSON.parse(list.stdout) as {
      command: string;
      status: string;
      data: { commands: { status: string }[] };
      warnings: unknown[];
    };
    expect(body).toMatchObject({ command: 'list', status: 'ok', warnings: [] });
    expect(body.data.commands.some((c) => c.status === 'planned')).toBe(true);

    expect((await cli(['make:crud'])).code).toBe(EXIT.USAGE);
    expect((await cli(['nope'])).code).toBe(EXIT.USAGE);
    // queue:failed moved from planned to implemented (real Redis); a command
    // that is still planned keeps the exit-3 contract (make:policy is now a
    // scaffold generator; make:guard is built; make:model remains planned).
    const planned = await cli(['--json', 'make:model']);
    expect(planned.code).toBe(EXIT.UNSUPPORTED);
    expect(JSON.parse(planned.stdout)).toMatchObject({ status: 'error', error: { code: 'UNSUPPORTED_CAPABILITY' } });
    // The playground registers the auth module, so authenticated access is a
    // legal dry run here; the refusal path (no auth module) is covered by the
    // generated-app e2e suite.
    expect(
      (await cli(['make:crud', 'Thing', '--fields', 'a:text:required', '--access', 'authenticated', '--dry-run'])).code,
    ).toBe(0);
  });

  test('dry run writes nothing and needs no database', async () => {
    const before = await snapshot(PLAYGROUND);
    const result = await cli([
      '--json',
      'make:crud',
      'Widget',
      '--fields',
      'label:text:required',
      '--access',
      'public',
      '--dry-run',
      '--verify',
    ]);
    expect(result.code).toBe(0);
    const data = JSON.parse(result.stdout).data as {
      dryRun: boolean;
      changes: { path: string }[];
      endpoints: unknown[];
    };
    expect(data.dryRun).toBe(true);
    expect(data.changes.map((c) => c.path)).toContain('app/modules/widgets/routes.ts');
    expect(data.endpoints).toHaveLength(5);
    expect(await snapshot(PLAYGROUND)).toEqual(before);
  });

  test('help describes options and examples', async () => {
    const help = await cli(['make:crud', '--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('--fields');
    expect(help.stdout).toContain('Examples:');
  });
});

async function snapshot(root: string): Promise<string[]> {
  const glob = new Bun.Glob('**/*.{ts,sql,json}');
  const entries: string[] = [];
  for await (const path of glob.scan({ cwd: root, onlyFiles: true })) {
    if (path.startsWith('node_modules/')) continue;
    entries.push(`${path}:${Bun.hash(await Bun.file(join(root, path)).text())}`);
  }
  return entries.sort();
}

// -- Infrastructure commands (cache:clear, storage:check, session:prune) --------

interface Envelope {
  command: string;
  status: string;
  data: unknown;
  error?: { code: string; message: string };
}

describe('infrastructure command gating (process contract)', () => {
  test('the three commands moved from planned to implemented in the catalog', async () => {
    const list = await cli(['--json', 'list']);
    expect(list.code).toBe(0);
    const body = JSON.parse(list.stdout) as { data: { commands: { name: string; status: string }[] } };
    for (const name of ['cache:clear', 'storage:check', 'session:prune']) {
      expect(body.data.commands.find((c) => c.name === name)?.status).toBe('implemented');
    }
  });

  // PENDING `bun install`: the playground CLI now imports @framework/cache
  // (its `cache(config)` adapter hook), so every spawned process below fails
  // on module resolution until the workspace dependency is installed. These
  // end-to-end assertions are written for the post-install reality:
  // cacheProvider/storageProvider are registered in bootstrap/providers.ts and
  // bin/cli.ts defines the cache/sessions hooks, so the old exit-3 provider
  // gates no longer fire here — they are covered against a synthetic fixture
  // in the in-process suite below instead.
  describe('PENDING bun install: playground end-to-end through the real adapter hooks', () => {
    test('cache:clear --confirm clears through the playground cache hook (memory driver)', async () => {
      // The config defaults to the redis driver, which deliberately refuses
      // namespace clears (CACHE_UNSUPPORTED_OPERATION); CACHE_DRIVER=memory
      // selects the driver that clears natively so the command succeeds.
      const result = await cli(['--json', 'cache:clear', '--confirm'], { CACHE_DRIVER: 'memory' });
      expect(result.code).toBe(0);
      const body = JSON.parse(result.stdout) as Envelope;
      expect(body).toMatchObject({ status: 'ok', data: { cleared: true, driver: 'memory' } });
    });

    test('storage:check reports the configured local disk', async () => {
      const result = await cli(['--json', 'storage:check']);
      expect(result.code).toBe(0);
      const body = JSON.parse(result.stdout) as Envelope;
      expect(body.status).toBe('ok');
      expect(body.data).toMatchObject({ default: 'local', valid: true });
    });

    test('session:prune passes the provider gate and the adapter hook (usage error without flags)', async () => {
      // Gating and hook checks run before --confirm is required, so a bare
      // invocation proves the authProvider gate and the sessions hook are in
      // place without opening a database connection.
      const refused = await cli(['--json', 'session:prune']);
      expect(refused.code).toBe(EXIT.USAGE);
      expect((JSON.parse(refused.stdout) as Envelope).error?.message).toMatch(/--confirm/);
    });
  });
});

describe('infrastructure command execution (in process)', () => {
  const WITH_CACHE = 'export const providers = [cacheProvider];\n';
  const WITH_AUTH = 'export const providers = [authProvider];\n';
  const WITH_STORAGE = 'export const providers = [storageProvider];\n';

  let root: string;

  const infrastructureProject = (overrides: Partial<ProjectAdapter>): ProjectAdapter => ({
    name: 'fixture',
    root,
    frameworkVersion: '0.0.0',
    apiPrefix: '/api/v1',
    paths: {
      modules: 'app/modules',
      schemaDir: 'database/schema',
      schemaIndex: 'database/schema/index.ts',
      factories: 'database/factories',
      migrations: 'database/migrations',
      apiRoutes: 'routes/api.ts',
      providers: 'providers.ts',
      middleware: 'middleware.ts',
      openapi: 'bootstrap/openapi.ts',
      config: 'config/index.ts',
      testSupport: 'tests/support.ts',
    },
    tools: {
      typecheck: [],
      test: [],
      lint: [],
      format: [],
      drizzleKit: [],
      dev: [],
      serve: [],
    },
    loadConfig: async () => ({}),
    databaseUrl: () => 'postgres://localhost/fixture',
    routes: async () => [],
    providers: () => [],
    middleware: () => [],
    openapi: () => ({ operations: [], build: () => ({}) }),
    ...overrides,
  });

  async function runInfra(args: string[], project: ProjectAdapter): Promise<{ code: number; envelope: Envelope }> {
    const chunks: string[] = [];
    const code = await runCli({
      argv: args,
      project,
      commands: frameworkCommands,
      cliVersion: '0.0.0',
      isTTY: false,
      stdout: (text) => chunks.push(text),
      stderr: () => {},
    });
    return { code, envelope: JSON.parse(chunks.join('\n')) as Envelope };
  }

  function cacheHandle(overrides: Partial<{ clear: () => Promise<number>; driver: string }>) {
    const state = { closed: false, calls: 0 };
    return {
      state,
      handle: {
        driver: overrides.driver ?? 'memory',
        clear: async () => {
          state.calls++;
          return overrides.clear ? overrides.clear() : 2;
        },
        close: async () => {
          state.closed = true;
        },
      },
    };
  }

  function sessionHandle(overrides: Partial<{ expired: number; removed: number }>) {
    const state = { closed: false, pruned: false };
    return {
      state,
      handle: {
        countExpired: async () => overrides.expired ?? 3,
        prune: async () => {
          state.pruned = true;
          return overrides.removed ?? 5;
        },
        close: async () => {
          state.closed = true;
        },
      },
    };
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'fw-infra-'));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('cache:clear and storage:check gate on their providers before honoring flags', async () => {
    // Gating runs before --confirm/--dry-run are honored: without the provider
    // there is no capability to preview either. (The playground registers both
    // providers now, so this refusal path is exercised on this synthetic
    // fixture instead.)
    await Bun.write(join(root, 'providers.ts'), 'export const providers = [];\n');
    const cache = await runInfra(['--json', 'cache:clear', '--confirm'], infrastructureProject({}));
    expect(cache.code).toBe(EXIT.UNSUPPORTED);
    expect(cache.envelope).toMatchObject({ status: 'error', error: { code: 'UNSUPPORTED_CAPABILITY' } });
    expect(cache.envelope.error?.message).toMatch(/cacheProvider/);
    expect(cache.envelope.error?.message).toMatch(/providers\.ts/);

    const storage = await runInfra(['--json', 'storage:check'], infrastructureProject({}));
    expect(storage.code).toBe(EXIT.UNSUPPORTED);
    expect(storage.envelope.error?.message).toMatch(/storageProvider/);
  });

  test('cache:clear without --confirm is a usage error; --dry-run never opens the cache', async () => {
    await Bun.write(join(root, 'providers.ts'), WITH_CACHE);
    const refused = await runInfra(['--json', 'cache:clear'], infrastructureProject({}));
    expect(refused.code).toBe(EXIT.USAGE);
    expect(refused.envelope.error?.code).toBe('INVALID_USAGE');
    expect(refused.envelope.error?.message).toMatch(/--confirm/);

    const dry = await runInfra(['--json', 'cache:clear', '--dry-run'], infrastructureProject({}));
    expect(dry.code).toBe(0);
    expect(dry.envelope).toMatchObject({ status: 'ok', data: { dryRun: true, cleared: false } });
  });

  test('cache:clear --confirm clears through the adapter hook and closes it', async () => {
    await Bun.write(join(root, 'providers.ts'), WITH_CACHE);
    const { handle, state } = cacheHandle({});
    const result = await runInfra(
      ['--json', 'cache:clear', '--confirm'],
      infrastructureProject({
        cache: async () => handle,
      }),
    );
    expect(result.code).toBe(0);
    expect(result.envelope).toMatchObject({ status: 'ok', data: { cleared: true, driver: 'memory', entries: 2 } });
    expect(state.calls).toBe(1);
    expect(state.closed).toBe(true);
  });

  test('cache:clear surfaces catalogued cache failures with exit 1 (redis namespace clear)', async () => {
    await Bun.write(join(root, 'providers.ts'), WITH_CACHE);
    const { handle, state } = cacheHandle({
      clear: () =>
        Promise.reject(Object.assign(new Error('redis cannot clear'), { code: 'CACHE_UNSUPPORTED_OPERATION' })),
    });
    const result = await runInfra(
      ['--json', 'cache:clear', '--confirm'],
      infrastructureProject({
        cache: async () => handle,
      }),
    );
    expect(result.code).toBe(EXIT.FAILURE);
    expect(result.envelope.error?.code).toBe('CACHE_UNSUPPORTED_OPERATION');
    expect(result.envelope.error?.message).toMatch(/cannot clear/);
    expect(state.closed).toBe(true);
  });

  test('cache:clear rejects unknown store names', async () => {
    await Bun.write(join(root, 'providers.ts'), WITH_CACHE);
    const result = await runInfra(
      ['--json', 'cache:clear', '--confirm', '--store', 'other'],
      infrastructureProject({}),
    );
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.envelope.error?.message).toMatch(/Unknown cache store "other"/);
  });

  test('session:prune gates on authProvider, then on the adapter sessions hook', async () => {
    await Bun.write(join(root, 'providers.ts'), 'export const providers = [];\n');
    const noAuth = await runInfra(['--json', 'session:prune', '--dry-run'], infrastructureProject({}));
    expect(noAuth.code).toBe(EXIT.UNSUPPORTED);
    expect(noAuth.envelope.error?.message).toMatch(/authProvider/);

    await Bun.write(join(root, 'providers.ts'), WITH_AUTH);
    const noHook = await runInfra(['--json', 'session:prune', '--dry-run'], infrastructureProject({}));
    expect(noHook.code).toBe(EXIT.UNSUPPORTED);
    expect(noHook.envelope.error?.message).toMatch(/session-store access/);
  });

  test('session:prune --dry-run counts via countExpired without pruning; --confirm prunes', async () => {
    await Bun.write(join(root, 'providers.ts'), WITH_AUTH);
    const { handle, state } = sessionHandle({});
    const dry = await runInfra(
      ['--json', 'session:prune', '--dry-run'],
      infrastructureProject({
        sessions: async () => handle,
      }),
    );
    expect(dry.code).toBe(0);
    expect(dry.envelope).toMatchObject({ status: 'ok', data: { dryRun: true, expired: 3, removed: 0 } });
    expect(state.pruned).toBe(false);
    expect(state.closed).toBe(true);

    const confirmed = await runInfra(
      ['--json', 'session:prune', '--confirm'],
      infrastructureProject({
        sessions: async () => handle,
      }),
    );
    expect(confirmed.code).toBe(0);
    expect(confirmed.envelope).toMatchObject({ status: 'ok', data: { dryRun: false, removed: 5 } });
    expect(state.pruned).toBe(true);
    expect(state.closed).toBe(true);

    const refused = await runInfra(
      ['--json', 'session:prune'],
      infrastructureProject({ sessions: async () => handle }),
    );
    expect(refused.code).toBe(EXIT.USAGE);
    expect(refused.envelope.error?.message).toMatch(/--confirm/);
  });

  test('storage:check validates disks read-only and reports per-disk rows', async () => {
    await Bun.write(join(root, 'providers.ts'), WITH_STORAGE);
    const config = {
      storage: {
        default: 'local',
        disks: { local: { driver: 'local', root: 'storage/local', visibility: 'private' } },
      },
    };
    const ok = await runInfra(['--json', 'storage:check'], infrastructureProject({ loadConfig: async () => config }));
    expect(ok.code).toBe(0);
    const disks = (ok.envelope.data as { default: string; valid: boolean; disks: { status: string }[] }).disks;
    expect(ok.envelope.data).toMatchObject({ default: 'local', valid: true });
    expect(disks).toHaveLength(1);
    expect(disks[0]?.status).toBe('ok (root is created on first use)');

    const brokenDefault = {
      storage: { default: 'missing', disks: { local: { driver: 'local', root: 'x', visibility: 'private' } } },
    };
    const bad = await runInfra(
      ['--json', 'storage:check'],
      infrastructureProject({
        loadConfig: async () => brokenDefault,
      }),
    );
    expect(bad.code).toBe(EXIT.FAILURE);
    expect(bad.envelope.error?.code).toBe('STORAGE_CHECK_FAILED');
    expect(bad.envelope.error?.message).toMatch(/unknown disk "missing"/);
  });

  test('storage:check enforces publicBaseUrl on public disks (provider rule)', async () => {
    await Bun.write(join(root, 'providers.ts'), WITH_STORAGE);
    const config = {
      storage: { default: 'pub', disks: { pub: { driver: 'local', root: 'pub', visibility: 'public' } } },
    };
    const result = await runInfra(
      ['--json', 'storage:check'],
      infrastructureProject({ loadConfig: async () => config }),
    );
    expect(result.code).toBe(EXIT.FAILURE);
    expect(result.envelope.error?.message).toMatch(/publicBaseUrl/);
  });
});
