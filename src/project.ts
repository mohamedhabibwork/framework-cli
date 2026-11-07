import type { Seeder } from '@framework/database';
import type { MiddlewareDescription, RouteInfo } from '@framework/http';
import type { Operation } from '@framework/openapi';
import { unsupported } from './errors';

/** Project-relative locations used by generators and operational commands. */
export interface ProjectPaths {
  readonly modules: string;
  readonly schemaDir: string;
  readonly schemaIndex: string;
  readonly factories: string;
  readonly migrations: string;
  /**
   * `defineApp` module: `make:crud` registers each generated module once, at
   * its `@framework:modules` marker. When set, `apiRoutes` and `openapi` are unused.
   */
  readonly app?: string;
  /** Legacy route table (`@framework:routes`), used by `make:crud` when `app` is unset. */
  readonly apiRoutes?: string;
  readonly providers: string;
  /** Middleware registry module receiving `make:middleware` aliases. */
  readonly middleware: string;
  /** Legacy operations list (`@framework:openapi-operations`), used when `app` is unset. */
  readonly openapi?: string;
  /** Module exporting the application's `AppConfig` type. */
  readonly config: string;
  /** Module exporting `createTestContext()` for endpoint tests. */
  readonly testSupport: string;
}

/** External executables delegated to; the CLI never re-implements them. */
export interface ProjectTools {
  readonly typecheck: readonly string[];
  readonly test: readonly string[];
  readonly lint: readonly string[];
  readonly format: readonly string[];
  readonly drizzleKit: readonly string[];
  readonly dev: readonly string[];
  readonly serve: readonly string[];
  /** Queue worker entry point; enables `queue:work`. */
  readonly worker?: readonly string[];
  /** Scheduler process entry point; enables `schedule:work`. */
  readonly scheduler?: readonly string[];
}

/** Queue coordinates derived from the project's configuration. */
export interface QueueTarget {
  readonly url: string;
  readonly prefix: string;
  readonly queue?: string;
}

/**
 * Runtime cache access for `cache:clear`, opened by the application adapter
 * from its own `@framework/cache` dependency (structurally satisfied by the
 * framework `Cache`). The command calls `close()` exactly once.
 */
export interface CacheClearHandle {
  /** Backend powering the cache (`memory` or `redis`), for reporting. */
  readonly driver: string;
  /** Deletes the namespace's keys; resolves with the number removed. */
  clear(): Promise<number>;
  /** Releases the underlying connection; idempotent. */
  close(): Promise<void>;
}

/**
 * Runtime session-store access for `session:prune`, opened by the application
 * adapter from its own `@framework/auth` dependency (structurally satisfied by
 * `PgSessionStore`). The command calls `close()` exactly once.
 */
export interface SessionPruneHandle {
  /** Counts expired sessions without deleting them (`--dry-run`). */
  countExpired(now?: Date): Promise<number>;
  /** Removes expired sessions; returns the number deleted. */
  prune(now?: Date): Promise<number>;
  /** Releases the underlying connection; idempotent. */
  close(): Promise<void>;
}

/** The role store, for `permission:sync`. */
export interface AuthorizationHandle {
  /** Makes each role in config hold exactly its listed permissions. */
  sync(): Promise<{ readonly roles: number; readonly added: number; readonly removed: number }>;
  close(): Promise<void>;
}

/** One observatory entry, as `observatory:list` prints it. */
export interface ObservatoryEntryRow {
  readonly watcher: string;
  readonly status: string;
  readonly summary: string;
  readonly occurredAt: string;
}

/** The observatory store, for the `observatory:*` commands. */
export interface ObservatoryHandle {
  query(filter: { readonly watcher?: string; readonly limit?: number }): Promise<readonly ObservatoryEntryRow[]>;
  /** Removes entries older than `before`; returns the number deleted. */
  prune(before: Date): Promise<number>;
  clear(): Promise<void>;
  /** Releases the underlying connection; idempotent. */
  close(): Promise<void>;
}

/**
 * Application-local hooks. Everything that needs the application's own code
 * goes through here, so the framework CLI never guesses project structure
 * from the shell's working directory.
 */
export interface ProjectAdapter {
  readonly name: string;
  readonly root: string;
  readonly frameworkVersion: string;
  readonly apiPrefix: string;
  readonly paths: ProjectPaths;
  readonly tools: ProjectTools;
  /** Env file holding TEST_DATABASE_URL for verification runs (absolute path). */
  readonly testEnvFile?: string;
  loadConfig(envFile?: string): Promise<unknown>;
  databaseUrl(config: unknown): string;
  /** Queue connection for queue commands; omitting it disables them (exit 3). */
  queueUrl?(config: unknown): QueueTarget;
  /** Opens the application cache for `cache:clear`; omitting it disables execution (exit 3). */
  cache?(config: unknown): Promise<CacheClearHandle>;
  /** Opens the session store for `session:prune`; omitting it disables execution (exit 3). */
  sessions?(config: unknown): Promise<SessionPruneHandle>;
  /** Opens the role store for `permission:sync`; omitting it disables execution (exit 3). */
  authorization?(config: unknown): Promise<AuthorizationHandle>;
  /** Opens the observatory store for `observatory:*`; omitting it disables execution (exit 3). */
  observatory?(config: unknown): Promise<ObservatoryHandle>;
  /** Registered seeders for `db:seed`; omitting it disables execution (exit 3). */
  seeders?(): Promise<readonly Seeder[]>;
  /** Route table of the composed HTTP app; must not open connections. */
  routes(config: unknown): Promise<readonly RouteInfo[]>;
  providers(): readonly string[];
  middleware(): readonly MiddlewareDescription[];
  openapi(): { readonly operations: readonly Operation[]; build(version?: string): object };
}

export const defineProject = (project: ProjectAdapter): ProjectAdapter => project;

function requireAppProject(): never {
  throw unsupported(
    'This command requires an application project',
    'Run inside a generated application directory (containing bin/cli.ts), or create one first with `bunx @framework/cli create <directory>`.',
  );
}

/**
 * Fallback project adapter used when the CLI is invoked outside an existing
 * application (e.g. `bunx @framework/cli create my-api`, `list`, `help`, `--version`).
 */
export function createStandaloneProject(root: string, frameworkVersion = '0.2.0'): ProjectAdapter {
  return {
    name: 'standalone',
    root,
    frameworkVersion,
    apiPrefix: '/api/v1',
    paths: {
      modules: 'app/modules',
      schemaDir: 'database/schema',
      schemaIndex: 'database/schema/index.ts',
      factories: 'database/factories',
      migrations: 'database/migrations',
      app: 'bootstrap/app.ts',
      providers: 'bootstrap/app.ts',
      middleware: 'bootstrap/middleware.ts',
      config: 'config/index.ts',
      testSupport: 'tests/support.ts',
    },
    tools: {
      typecheck: ['bunx', 'tsc', '-p', 'tsconfig.json'],
      test: ['bun', 'test'],
      lint: ['bun', 'run', 'lint'],
      format: ['bun', 'run', 'format'],
      drizzleKit: ['bunx', 'drizzle-kit'],
      dev: ['bun', 'run', '--hot', 'bin/server.ts'],
      serve: ['bun', 'run', 'bin/server.ts'],
      worker: ['bun', 'run', 'bin/worker.ts'],
    },
    loadConfig: async () => requireAppProject(),
    databaseUrl: () => requireAppProject(),
    routes: async () => requireAppProject(),
    providers: () => requireAppProject(),
    middleware: () => requireAppProject(),
    openapi: () => requireAppProject(),
  };
}
