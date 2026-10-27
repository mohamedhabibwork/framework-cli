import type { NewFile } from '../plan';

export interface AppTemplateInput {
  /** Kebab-case application name (the target directory's basename). */
  readonly name: string;
  readonly className: string;
  readonly apiTitle: string;
}

const TSCONFIG_COMPILER_OPTIONS = `{
  "compilerOptions": {
    "target": "ES2023",
    "module": "Preserve",
    "moduleResolution": "bundler",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": ["bun"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "jsxImportSource": "hono/jsx"
  },
  "include": ["**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules", "dist", "storage"]
}`;

/**
 * Biome's `organizeImports` order for names inside a single import clause.
 * Derived empirically against the pinned Biome: a case-insensitive comparison
 * is primary, an ASCII tiebreak (upper-case sorts first) applies when two
 * names differ only by case at the first differing character, and the shorter
 * name wins on a prefix. Used so generated mixed type/value imports land in
 * the position Biome expects without a post-generation formatter pass.
 */
function compareImportNames(a: string, b: string): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    const left = a.charCodeAt(i);
    const right = b.charCodeAt(i);
    if (left === right) continue;
    const lowerLeft = left >= 65 && left <= 90 ? left + 32 : left;
    const lowerRight = right >= 65 && right <= 90 ? right + 32 : right;
    if (lowerLeft !== lowerRight) return lowerLeft - lowerRight;
    return left - right;
  }
  return a.length - b.length;
}

/**
 * The complete generated application: the same structure as the framework's
 * playground, minus the sample module (added by `make:crud`), plus events,
 * queue worker and audit wiring.
 */
export function appTemplateFiles(input: AppTemplateInput): readonly NewFile[] {
  return [
    { path: 'package.json', content: packageJson(input) },
    { path: 'tsconfig.json', content: `${TSCONFIG_COMPILER_OPTIONS}\n` },
    { path: 'biome.json', content: biomeJson() },
    { path: '.env.example', content: envExample(input) },
    { path: '.gitignore', content: gitignore() },
    { path: 'README.md', content: readme(input) },
    { path: 'drizzle.config.ts', content: drizzleConfig() },
    { path: 'config/index.ts', content: config(input) },
    { path: 'bootstrap/app.ts', content: bootstrapApp(input) },
    { path: 'bootstrap/http.ts', content: bootstrapHttp(input) },
    { path: 'bootstrap/middleware.ts', content: bootstrapMiddleware() },
    { path: 'bootstrap/openapi.ts', content: bootstrapOpenapi(input) },
    { path: 'bootstrap/providers.ts', content: bootstrapProviders() },
    { path: 'app/providers/cache.provider.ts', content: cacheProvider() },
    { path: 'app/providers/database.provider.ts', content: databaseProvider() },
    { path: 'app/providers/events.provider.ts', content: eventsProvider() },
    { path: 'app/providers/logging.provider.ts', content: loggingProvider() },
    { path: 'app/providers/storage.provider.ts', content: storageProvider() },
    { path: 'app/providers/data.tokens.ts', content: dataTokens() },
    { path: 'app/providers/data.provider.ts', content: dataProvider() },
    { path: 'app/jobs/index.ts', content: jobsRegistry() },
    { path: 'app/listeners/index.ts', content: listenersRegistry() },
    { path: 'app/listeners/listeners.provider.ts', content: listenersProvider() },
    { path: 'routes/api.ts', content: apiRoutes() },
    { path: 'routes/data.ts', content: dataRoutes() },
    { path: 'routes/health.ts', content: healthRoutes() },
    { path: 'database/schema/index.ts', content: schemaIndex() },
    { path: 'database/seeders.ts', content: seeders() },
    { path: 'bin/server.ts', content: server() },
    { path: 'bin/worker.ts', content: worker() },
    { path: 'bin/cli.ts', content: cli(input) },
    { path: 'Dockerfile', content: dockerfile() },
    { path: 'tests/support.ts', content: testSupport(input) },
    { path: 'tests/health.api.test.ts', content: healthTest() },
    { path: 'deployment/compose.yaml', content: compose(input) },
  ];
}

function packageJson({ name }: AppTemplateInput): string {
  return `{
  "name": "${name}",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun run --hot bin/server.ts",
    "start": "bun run bin/server.ts",
    "cli": "bun run bin/cli.ts",
    "worker": "bun run bin/worker.ts",
    "db:generate": "drizzle-kit generate",
    "typecheck": "tsc -p tsconfig.json",
    "test": "bun test"
  },
  "dependencies": {
    "@framework/cache": "workspace:*",
    "@framework/cli": "workspace:*",
    "@framework/core": "workspace:*",
    "@framework/crud": "workspace:*",
    "@framework/database": "workspace:*",
    "@framework/events": "workspace:*",
    "@framework/http": "workspace:*",
    "@framework/logging": "workspace:*",
    "@framework/openapi": "workspace:*",
    "@framework/queue": "workspace:*",
    "@framework/storage": "workspace:*",
    "@framework/support": "workspace:*",
    "@framework/validation": "workspace:*",
    "drizzle-orm": "0.45.4",
    "hono": "4.13.13",
    "zod": "4.6.7"
  },
  "devDependencies": {
    "@framework/testing": "workspace:*",
    "drizzle-kit": "0.31.11",
    "typescript": "7.0.2"
  }
}
`;
}

function biomeJson(): string {
  // `"root": false` lets the config compose when the app is generated *inside*
  // the framework workspace (apps/*) instead of replacing the root config —
  // without it, `biome check .` at the workspace root fails with a nested-root
  // configuration error. It is a no-op for a standalone app (no parent config).
  return `{
  "$schema": "https://biomejs.dev/schemas/2.5.15/schema.json",
  "root": false,
  "vcs": { "enabled": false },
  "files": { "includes": ["**", "!**/node_modules", "!**/dist", "!**/database/migrations/meta"] },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 120 },
  "javascript": { "formatter": { "quoteStyle": "single", "trailingCommas": "all", "semicolons": "always" } },
  "linter": {
    "enabled": true,
    "rules": {
      "preset": "recommended",
      "suspicious": { "noExplicitAny": "error", "noConsole": { "level": "warn", "options": { "allow": ["error"] } } },
      "style": { "noNonNullAssertion": "error", "useImportType": "error" }
    }
  },
  "assist": { "actions": { "source": { "organizeImports": "on" } } }
}
`;
}

function envExample({ name }: AppTemplateInput): string {
  return `# Placeholders only. Copy to .env and replace values; never commit real credentials.
APP_NAME=${name}
APP_ENV=development
APP_DEBUG=false

HTTP_HOST=127.0.0.1
HTTP_PORT=3000
CORS_ORIGINS=
HTTP_MAX_BODY_BYTES=1048576
# Strict hardening headers on every response (kernel preset).
HTTP_SECURE_HEADERS=true
# Coarse fixed-window ceiling for the \`api\` middleware group. Tests that make
# many rapid requests can set HTTP_THROTTLE_ENABLED=false.
HTTP_THROTTLE_ENABLED=true
HTTP_THROTTLE_LIMIT=120
HTTP_THROTTLE_WINDOW_SECONDS=60
SHUTDOWN_TIMEOUT_MS=10000

DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/${name.replaceAll('-', '_')}
DATABASE_MAX_CONNECTIONS=10

# Redis backs queues, the shared cache and (optionally) cross-instance events.
REDIS_URL=redis://127.0.0.1:6379
QUEUE_NAME=default
QUEUE_CONCURRENCY=4
QUEUE_PREFIX=${name}
EVENTS_DRIVER=memory

# Application cache (cache/locks/rate limiting on one driver).
CACHE_DRIVER=redis
CACHE_REDIS_URL=redis://127.0.0.1:6379
CACHE_REDIS_PREFIX=${name}

# Structured logging (console sink; use driver=file with LOG_FILE_PATH in production).
LOG_LEVEL=info
LOG_DRIVER=console
LOG_NAME=${name}

# Storage disks (the default disk is private and rooted inside the app).
STORAGE_DEFAULT=local
STORAGE_ROOT=storage
STORAGE_VISIBILITY=private
`;
}

function gitignore(): string {
  return `node_modules/
dist/
coverage/
storage/
.env
.env.*
!.env.example
*.log
.tmp/
`;
}

function readme({ className }: AppTemplateInput): string {
  return `# ${className}

Generated application on the framework workspace (Bun + Hono + Drizzle + Zod).

## Getting started

\`\`\`sh
bun install
cp .env.example .env          # then edit the values
docker compose -f deployment/compose.yaml up -d --wait   # PostgreSQL + Redis

bun run cli -- config:check
bun run cli -- db:migrate     # apply the generated migration(s)
bun run dev                   # HTTP server (bun run cli -- serve for production)
bun run worker                # queue worker (bun run cli -- queue:work)
bun test                      # endpoint suite on an isolated database
\`\`\`

If this app was created with \`--with-demo\`, a sample **products** module is
already generated (schema, migration, CRUD routes, OpenAPI, tests). Add more
resources any time:

\`\`\`sh
bun run cli -- make:crud Order --module orders \\\\
  --fields 'total:numeric:required' --access public --verify
\`\`\`

## Layout

- \`app/modules/<feature>/\` — business modules (generate with \`make:crud\`)
- \`app/providers/\` — application providers (database, events)
- \`bootstrap/\` — framework application, HTTP composition, middleware, OpenAPI
- \`config/\` — validated configuration (environment-mapped)
- \`database/schema\` — canonical Drizzle tables (including \`audit_logs\`)
- \`bin/\` — server, worker and CLI entry points
- \`tests/\` — endpoint tests (\`bun test\`)

Events: set \`EVENTS_DRIVER=redis\` to fan out \`entity.*\` / \`import.*\` /
\`export.*\` events across instances; \`GET /ws\` multiplexes them to WebSocket
clients (subscribe to allowlisted channels such as \`events\`).

## Kit-backed subsystems

The cache (\`CACHE\`/\`LOCK_STORE\`/\`RATE_LIMITER\` via \`@framework/cache\`),
structured logging (\`LOGGER\` via \`@framework/logging\`) and storage disks
(\`STORAGE\` via \`@framework/storage\`) are configured by the \`cache\`,
\`logging\` and \`storage\` sections of \`config/index.ts\` and registered in
\`bootstrap/providers.ts\`. Three CLI commands operate them:

\`\`\`sh
bun run cli -- cache:clear --dry-run    # preview; add --confirm to execute
bun run cli -- storage:check            # validate disk configuration (read-only)
bun run cli -- session:prune --dry-run  # available once make:auth is installed
\`\`\`
`;
}

function drizzleConfig(): string {
  return `import { defineConfig } from 'drizzle-kit';

// \`drizzle-kit generate\` diffs the schema offline; no database connection is needed.
// Migrations are applied by \`bun run cli -- db:migrate\` (locked, explicit release step).
export default defineConfig({
  dialect: 'postgresql',
  schema: './database/schema/index.ts',
  out: './database/migrations',
  strict: true,
  verbose: true,
});
`;
}

function config({ name }: AppTemplateInput): string {
  return `import { type DeepReadonly, loadConfig } from '@framework/core';
import { z } from 'zod/v4';

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');

export const configSchema = z.object({
  app: z.object({
    name: z.string().min(1).default('${name}'),
    env: z.enum(['development', 'test', 'production']).default('development'),
    debug: booleanString.default(false),
  }),
  http: z.object({
    host: z.string().min(1).default('127.0.0.1'),
    port: z.coerce.number().int().min(0).max(65535).default(3000),
    corsOrigins: z
      .string()
      .default('')
      .transform((value) =>
        value
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean),
      ),
    maxBodyBytes: z.coerce
      .number()
      .int()
      .min(1)
      .default(1024 * 1024),
    secureHeaders: booleanString.default(true),
    throttle: z.object({
      enabled: booleanString.default(true),
      limit: z.coerce.number().int().min(1).default(120),
      windowSeconds: z.coerce.number().int().min(1).default(60),
    }),
    shutdownTimeoutMs: z.coerce.number().int().min(100).default(10_000),
  }),
  database: z.object({
    url: z.url({ protocol: /^postgres(ql)?$/ }),
    maxConnections: z.coerce.number().int().min(1).max(100).default(10),
    migrationsFolder: z.string().default('database/migrations'),
  }),
  redis: z.object({
    url: z.url({ protocol: /^redis$/ }).default('redis://127.0.0.1:6379'),
  }),
  queue: z.object({
    name: z.string().min(1).default('default'),
    concurrency: z.coerce.number().int().min(1).max(64).default(4),
    prefix: z.string().min(1).default('${name}'),
  }),
  events: z.object({
    driver: z.enum(['memory', 'redis']).default('memory'),
  }),
  cache: z.object({
    driver: z.enum(['memory', 'redis']).default('redis'),
    redis: z.object({
      url: z.url({ protocol: /^redis$/ }).default('redis://127.0.0.1:6379'),
      prefix: z.string().min(1).default('${name}'),
    }),
  }),
  logging: z.object({
    level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    driver: z.enum(['console', 'file', 'memory']).default('console'),
    name: z.string().min(1).default('${name}'),
    filePath: z.string().min(1).optional(),
    maxBytes: z.coerce.number().int().positive().optional(),
  }),
  storage: z.object({
    default: z.string().min(1).default('local'),
    disks: z.object({
      local: z.object({
        driver: z.literal('local'),
        root: z.string().min(1).default('storage'),
        visibility: z.enum(['private', 'public']).default('private'),
      }),
    }),
  }),
  // @framework:config-schema-sections
});

export type AppConfig = DeepReadonly<z.output<typeof configSchema>>;

/** Maps environment variables onto the config schema. Precedence: process env > env file > defaults. */
export const mapEnvironment = (env: Readonly<Record<string, string>>): z.input<typeof configSchema> => ({
  app: { name: env.APP_NAME, env: env.APP_ENV as never, debug: env.APP_DEBUG as never },
  http: {
    host: env.HTTP_HOST,
    port: env.HTTP_PORT,
    corsOrigins: env.CORS_ORIGINS,
    maxBodyBytes: env.HTTP_MAX_BODY_BYTES,
    secureHeaders: env.HTTP_SECURE_HEADERS as never,
    throttle: {
      enabled: env.HTTP_THROTTLE_ENABLED as never,
      limit: env.HTTP_THROTTLE_LIMIT,
      windowSeconds: env.HTTP_THROTTLE_WINDOW_SECONDS,
    },
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
  },
  database: {
    url: env.DATABASE_URL as string,
    maxConnections: env.DATABASE_MAX_CONNECTIONS,
    migrationsFolder: env.DATABASE_MIGRATIONS_FOLDER,
  },
  redis: { url: env.REDIS_URL },
  queue: { name: env.QUEUE_NAME, concurrency: env.QUEUE_CONCURRENCY, prefix: env.QUEUE_PREFIX },
  events: { driver: env.EVENTS_DRIVER as never },
  cache: {
    driver: env.CACHE_DRIVER as never,
    redis: { url: env.CACHE_REDIS_URL, prefix: env.CACHE_REDIS_PREFIX },
  },
  logging: {
    level: env.LOG_LEVEL as never,
    driver: env.LOG_DRIVER as never,
    name: env.LOG_NAME,
    filePath: env.LOG_FILE_PATH,
    maxBytes: env.LOG_MAX_BYTES,
  },
  storage: {
    default: env.STORAGE_DEFAULT,
    disks: {
      local: { driver: 'local' as const, root: env.STORAGE_ROOT, visibility: env.STORAGE_VISIBILITY as never },
    },
  },
  // @framework:config-env-sections
});

export function loadAppConfig(options: { envFile?: string; processEnv?: Record<string, string | undefined> } = {}) {
  return loadConfig({ schema: configSchema, map: mapEnvironment, envFile: options.envFile ?? '.env', ...options });
}
`;
}

function bootstrapApp({ className }: AppTemplateInput): string {
  return `import { Application } from '@framework/core';
import type { AppConfig } from '../config';
import { providers } from './providers';

export type ${className}Application = Application<AppConfig>;

/** Builds the framework application. Callers boot it and own its shutdown. */
export function createApplication(config: AppConfig): ${className}Application {
  return new Application<AppConfig>({ config, providers });
}
`;
}

function bootstrapHttp({ className }: AppTemplateInput): string {
  return `import { auditRoutes } from '@framework/crud';
import { AUDIT_READER } from '@framework/database';
import { assertNoDuplicateRoutes, createHttpKernel, type FrameworkEnv, forbidden, resolve } from '@framework/http';
import type { Context } from 'hono';
import { WEBSOCKET_GATEWAY } from '../app/providers/events.provider';
import { apiRoutes } from '../routes/api';
import { healthRoutes } from '../routes/health';
import type { ${className}Application } from './app';
import { createMiddleware } from './middleware';

/**
 * Composes the typed Hono application. The kernel owns the fixed outer order:
 * request id -> body limit -> request scope -> secure headers (strict preset,
 * \`http.secureHeaders\`) -> CORS (\`http.corsOrigins\`, off when empty) ->
 * module routes. The \`api\` middleware group adds the shared throttle.
 *
 * Audit endpoints (\`/audit\`) read the framework-owned audit trail; they are
 * denied in production until an identity/authorization layer exists. The
 * \`/ws\` gateway opens private \`user.<id>\` channels for authenticated
 * actors and broadcasts presence.
 */
export function createHttp(application: ${className}Application) {
  const { config } = application;
  const http = createHttpKernel(application, {
    exposeInternalErrors: config.app.debug && config.app.env !== 'production',
    maxBodyBytes: config.http.maxBodyBytes,
    secureHeaders: config.http.secureHeaders,
    cors: { origins: config.http.corsOrigins },
    report: (error, context) => console.error('[http] unhandled error', context, error),
  })
    .use(...createMiddleware(config).resolve(['api']))
    .route('/health', healthRoutes)
    .route('/api/v1', apiRoutes)
    .route(
      '/audit',
      auditRoutes({
        authorize: (_c: Context<FrameworkEnv>) => {
          if (config.app.env === 'production') throw forbidden('Audit endpoints require authorization');
        },
        reader: (c: Context<FrameworkEnv>) => resolve(c, AUDIT_READER),
      }),
    )
    .route('/ws', application.container.resolve(WEBSOCKET_GATEWAY).routes());

  assertNoDuplicateRoutes(http);
  return http;
}

/** Route types for Hono RPC clients (\`hc<AppType>()\`). */
export type AppType = ReturnType<typeof createHttp>;
`;
}

function bootstrapMiddleware(): string {
  return `import { RATE_LIMITER } from '@framework/cache';
import { MiddlewareRegistry, resolve, throttle } from '@framework/http';
import type { AppConfig } from '../config';

/**
 * Named aliases and groups, derived from the validated config. Resolved and
 * validated at bootstrap so unknown names fail before any request is served.
 * Native \`hono/*\` middleware can always be registered directly instead.
 *
 * Secure headers and CORS are owned by the kernel (\`http.secureHeaders\`,
 * \`http.corsOrigins\`). \`throttle\` is the generic fixed-window limiter over
 * the cache package's \`RATE_LIMITER\` (Redis counters are cluster-wide); the
 * limiter resolves per request, so the alias is safe to declare pre-boot.
 * Mounted on the \`api\` group with the \`http.throttle\` knobs (120/min/IP by
 * default; test suites disable it via \`HTTP_THROTTLE_ENABLED=false\`).
 */
export function createMiddleware(config: AppConfig): MiddlewareRegistry {
  return (
    new MiddlewareRegistry()
      .alias(
        'throttle',
        throttle({
          limiter: (c) => resolve(c, RATE_LIMITER),
          enabled: config.http.throttle.enabled,
          limit: config.http.throttle.limit,
          windowSeconds: config.http.throttle.windowSeconds,
          prefix: 'http.api',
        }),
      )
      // @framework:middleware
      .group('api', ['throttle'])
  );
}
`;
}

function bootstrapOpenapi({ apiTitle }: AppTemplateInput): string {
  return `import { dataOperations } from '@framework/crud';
import { generateOpenApiDocument, type Operation } from '@framework/openapi';

/** Documented API operations. Generators append module operation lists below the marker. */
export const operations: readonly Operation[] = [
  // @framework:openapi-operations
  ...dataOperations({ mount: '/api/v1/data' }),
];

/** Session auth is a cookie; API clients authenticate with Bearer tokens. */
const securitySchemes = {
  sessionCookie: { type: 'apiKey', in: 'cookie', name: 'fw_session' },
  bearerAuth: { type: 'http', scheme: 'bearer' },
} as const;

export function buildOpenApiDocument(version = '1.0.0') {
  return generateOpenApiDocument({ title: '${apiTitle}', version, operations, securitySchemes });
}
`;
}

function bootstrapProviders(): string {
  return `import type { ServiceProvider } from '@framework/core';
import { listenersProvider } from '../app/listeners/listeners.provider';
import { cacheProvider } from '../app/providers/cache.provider';
import { dataProvider } from '../app/providers/data.provider';
import { databaseProvider } from '../app/providers/database.provider';
import { eventsProvider } from '../app/providers/events.provider';
import { loggingProvider } from '../app/providers/logging.provider';
import { storageProvider } from '../app/providers/storage.provider';
import type { AppConfig } from '../config';

/**
 * Explicit provider registration. Order is resolved from \`dependsOn\`, with
 * one exception: \`cacheProvider\` must stay above the \`@framework:providers\`
 * marker — \`make:auth\` appends the auth provider there, and it publishes the
 * cache's rate limiter during its own registration.
 */
export const providers: readonly ServiceProvider<AppConfig>[] = [
  cacheProvider,
  loggingProvider,
  storageProvider,
  databaseProvider,
  eventsProvider,
  listenersProvider,
  dataProvider,
  // @framework:providers
];
`;
}

function databaseProvider(): string {
  return `import { defineProvider, EXECUTION_CONTEXT } from '@framework/core';
import {
  AUDIT_READER,
  AuditReader,
  createConnection,
  DATA_CONTEXT,
  DATABASE,
  TRANSACTION_CONTEXT,
  TransactionContext,
} from '@framework/database';
import type { AppConfig } from '../../config';

/**
 * Pooled PostgreSQL connection (singleton, closed on shutdown) and per-scope
 * data access: a transaction context plus the execution context (actor,
 * correlation id) repositories use for auditing. The audit reader serves the
 * \`/audit\` endpoints.
 */
export const databaseProvider = defineProvider<AppConfig>({
  name: 'database',
  register({ container, config }) {
    container.singleton(
      DATABASE,
      () =>
        createConnection({
          url: config.database.url,
          maxConnections: config.database.maxConnections,
          applicationName: config.app.name,
        }),
      (connection) => connection.close(),
    );
    container.scoped(TRANSACTION_CONTEXT, (r) => new TransactionContext(r.resolve(DATABASE).db));
    container.scoped(DATA_CONTEXT, (r) => ({
      transactions: r.resolve(TRANSACTION_CONTEXT),
      execution: r.resolve(EXECUTION_CONTEXT),
    }));
    container.scoped(AUDIT_READER, (r) => new AuditReader(r.resolve(TRANSACTION_CONTEXT).executor));
  },
});
`;
}

function cacheProvider(): string {
  return `import { createCacheProvider } from '@framework/cache';
import type { AppConfig } from '../../config';

/**
 * The application cache stack — \`CACHE\`, \`LOCK_STORE\` and \`RATE_LIMITER\`
 * — on one driver (config \`cache.driver\`): in-process memory for
 * single-instance development/tests, redis for state shared across
 * instances. The auth provider publishes this stack's rate limiter for login
 * throttling, which is why it registers after this provider.
 */
export const cacheProvider = createCacheProvider<AppConfig>((config) => config.cache);
`;
}

function loggingProvider(): string {
  return `import { createLoggingProvider } from '@framework/logging';
import type { AppConfig } from '../../config';

/**
 * The shared structured logger (\`LOGGER\`) from the \`logging\` section:
 * console sink at info level by default; switch to \`file\` (with
 * \`LOG_FILE_PATH\`) for production. Every entry is redacted and enriched
 * with the ambient execution context (actor, correlation id).
 */
export const loggingProvider = createLoggingProvider<AppConfig>((config) => config.logging);
`;
}

function storageProvider(): string {
  return `import { createStorageProvider } from '@framework/storage';
import type { AppConfig } from '../../config';

/**
 * Storage disks from the \`storage\` section: every \`storage.disks\` entry
 * becomes a singleton under \`storageDiskToken(name)\` and the
 * \`storage.default\` disk is bound to \`STORAGE\`. The generated default is
 * one private local disk rooted inside the app (gitignored); add cloud
 * drivers as new entries with their kit \`options\`.
 */
export const storageProvider = createStorageProvider<AppConfig>();
`;
}

function dataTokens(): string {
  return `import { token } from '@framework/core';
import type { DataPorter, ExportStore } from '@framework/crud';

/** Shared export artifact store (local disk under storage/exports). */
export const EXPORT_STORE = token<ExportStore>('data.export-store');

/** Queued import/export dispatcher for the resources that opt in. */
export const DATA_PORTER = token<DataPorter>('data.porter');
`;
}

function dataProvider(): string {
  return `import { defineProvider } from '@framework/core';
import { DataPorter, LocalExportStore } from '@framework/crud';
import { QUEUE, QueueManager } from '@framework/queue';
import type { AppConfig } from '../../config';
import { DATA_PORTER, EXPORT_STORE } from './data.tokens';

/**
 * Queued import/export: a BullMQ connection (lazy — connects on first use),
 * the local export artifact store, and the dispatcher behind \`/api/v1/data\`.
 * To opt a module in: define its import/export jobs with \`defineImportJob\`
 * /\`defineExportJob\` (pass \`storeToken: EXPORT_STORE\`), list them below,
 * and add the resource name to \`dataOperations\` in \`bootstrap/openapi.ts\`.
 */
export const dataProvider = defineProvider<AppConfig>({
  name: 'data',
  register({ container, config }) {
    container.singleton(
      QUEUE,
      () =>
        new QueueManager({
          url: config.redis.url,
          prefix: config.queue.prefix,
          queue: config.queue.name,
        }),
      (queue) => queue.close(),
    );
    container.singleton(EXPORT_STORE, () => new LocalExportStore('storage/exports'));
    container.scoped(
      DATA_PORTER,
      (r) =>
        new DataPorter({
          queue: r.resolve(QUEUE),
          store: r.resolve(EXPORT_STORE),
          imports: [],
          exports: [],
        }),
    );
  },
});
`;
}

function eventsProvider(): string {
  return `import { defineProvider, EXECUTION_CONTEXT, token } from '@framework/core';
import { EVENT_BUS, MemoryEventBus, RedisEventBus, WebsocketGateway } from '@framework/events';
import { resolve } from '@framework/http';
import type { AppConfig } from '../../config';

export const WEBSOCKET_GATEWAY = token<WebsocketGateway>('events.websocket-gateway');

/**
 * In-process events by default; Redis pub/sub for cross-instance fan-out
 * (config \`events.driver\`). The WebSocket gateway serves \`/ws\`: private
 * \`user.<id>\` channels for authenticated actors and presence broadcasts.
 */
export const eventsProvider = defineProvider<AppConfig>({
  name: 'events',
  register({ container, config }) {
    container.singleton(
      EVENT_BUS,
      () =>
        config.events.driver === 'redis'
          ? new RedisEventBus({ url: config.redis.url, prefix: config.app.name })
          : new MemoryEventBus(),
      (bus) => bus.close(),
    );
    container.singleton(
      WEBSOCKET_GATEWAY,
      (r) =>
        new WebsocketGateway({
          bus: r.resolve(EVENT_BUS),
          authenticate: (c) => resolve(c, EXECUTION_CONTEXT).actor,
          channels: ['events'],
          presence: true,
        }),
      (gateway) => gateway.close(),
    );
  },
});
`;
}

function jobsRegistry(): string {
  return `import type { JobList } from '@framework/queue';

/**
 * The application's job handlers, run by \`bun run worker\`
 * (or \`bun run cli -- queue:work\`). Each job declares a versioned, validated
 * payload and an idempotent handler; add jobs with \`defineJob\`.
 */
export const jobs: JobList = [];
`;
}

function listenersRegistry(): string {
  return `import type { DomainEvent } from '@framework/events';

/**
 * A listener reacts to one event channel. The listeners provider subscribes
 * every entry below the marker when the application boots. Delivery is
 * at-least-once: keep handlers idempotent. Add listeners with \`make:listener\`.
 */
export interface Listener {
  readonly name: string;
  readonly channel: string;
  readonly handle: (event: DomainEvent) => void | Promise<void>;
}

export const listeners: Listener[] = [
  // @framework:listeners
];
`;
}

function listenersProvider(): string {
  return `import { defineProvider } from '@framework/core';
import { EVENT_BUS } from '@framework/events';
import type { AppConfig } from '../../config';
import { listeners } from './index';

/**
 * Subscribes every registered listener to the event bus at boot. Handlers
 * release with the bus itself, which the events provider closes.
 */
export const listenersProvider = defineProvider<AppConfig>({
  name: 'listeners',
  dependsOn: ['events'],
  register() {},
  async boot({ container }) {
    const bus = container.resolve(EVENT_BUS);
    for (const listener of listeners) await bus.subscribe(listener.channel, listener.handle);
  },
});
`;
}

function apiRoutes(): string {
  return `import type { FrameworkEnv } from '@framework/http';
import { Hono } from 'hono';
import { dataRoutes } from './data';

/** Versioned API composed from module routes; mounted at /api/v1. */
export const apiRoutes = new Hono<FrameworkEnv>()
  // @framework:routes
  .route('/data', dataRoutes);
`;
}

function dataRoutes(): string {
  return `import { EXECUTION_CONTEXT } from '@framework/core';
import { importExportRoutes } from '@framework/crud';
import { forbidden, resolve } from '@framework/http';
import { DATA_PORTER } from '../app/providers/data.tokens';
import { loadAppConfig } from '../config';

// Loaded once; the authorization guard reads the validated env from it.
const configPromise = loadAppConfig();
/**
 * Queued import/export endpoints (documented via \`dataOperations\` in
 * \`bootstrap/openapi.ts\`):
 *
 * \`\`\`text
 * POST /api/v1/data/import                 dispatch an import (CSV/JSON)
 * GET  /api/v1/data/import/status/:jobId   job state and row errors
 * POST /api/v1/data/export                 dispatch an export
 * GET  /api/v1/data/export/status/:jobId   job state and progress
 * GET  /api/v1/data/export/download/:jobId the finished artifact
 * \`\`\`
 *
 * Import/export touches every resource, so it is denied in production until
 * an authorization layer is wired: replace this guard with e.g.
 * \`requireAuth()\` or \`requireAbility('data.import')\` once auth exists.
 */
export const dataRoutes = importExportRoutes({
  porter: (c) => resolve(c, DATA_PORTER),
  execution: (c) => resolve(c, EXECUTION_CONTEXT),
  authorize: async () => {
    const config = await configPromise;
    if (config.app.env === 'production') throw forbidden('Import/export endpoints require authorization');
  },
});
`;
}

function healthRoutes(): string {
  return `import { CACHE } from '@framework/cache';
import { DATABASE, pingDatabase } from '@framework/database';
import { type FrameworkEnv, resolve } from '@framework/http';
import { QUEUE } from '@framework/queue';
import { Hono } from 'hono';

/** One dependency probe; a thrown error becomes a 'failed' check, never a 500. */
const check = async (name: string, probe: () => Promise<unknown>): Promise<[string, 'ok' | 'failed']> => {
  try {
    await probe();
    return [name, 'ok'];
  } catch {
    return [name, 'failed'];
  }
};

/** Liveness never touches dependencies; readiness probes every backing service. */
export const healthRoutes = new Hono<FrameworkEnv>()
  .get('/live', (c) => c.json({ status: 'ok' as const }))
  .get('/ready', async (c) => {
    // Cache \`has\` is a Redis round-trip (false on a missing key, error on an
    // unreachable engine); queue counts exercises the BullMQ connection.
    const checks = await Promise.all([
      check('database', () => pingDatabase(resolve(c, DATABASE))),
      check('redis', () => resolve(c, CACHE).has('__health__')),
      check('queue', () => resolve(c, QUEUE).counts()),
    ]);
    const failed = checks.some(([, state]) => state === 'failed');
    return c.json(
      { status: failed ? ('unavailable' as const) : ('ready' as const), checks: Object.fromEntries(checks) },
      failed ? 503 : 200,
    );
  });
`;
}

function schemaIndex(): string {
  return `import { auditLogs } from '@framework/database';

// Canonical Drizzle schema exports. Generators append below the marker.
// @framework:schema-exports
export { auditLogs };
`;
}

function seeders(): string {
  return `import { defineSeeder } from '@framework/database';

/**
 * Registered seeders, run in list order by \`bun run cli -- db:seed [name]\`.
 * Keep them idempotent (guard on existing rows or upsert) — re-running is a
 * routine operation. Factories (\`defineFactory\` from \`@framework/database\`)
 * share shapes with tests; define them next to the seeder that uses them.
 */
export const seeders = [
  defineSeeder({
    name: 'smoke',
    async run({ log }) {
      log('smoke: nothing to seed yet — replace or extend this seeder');
    },
  }),
  // @framework:seeders
];
`;
}

function server(): string {
  return `import { installGracefulShutdown, redact } from '@framework/core';
import { websocket } from '@framework/events';
import { createApplication } from '../bootstrap/app';
import { createHttp } from '../bootstrap/http';
import { loadAppConfig } from '../config';

const config = await loadAppConfig();
const application = await createApplication(config).boot();
const http = createHttp(application);

const server = Bun.serve({ hostname: config.http.host, port: config.http.port, fetch: http.fetch, websocket });
console.error(\`[server] listening on http://\${server.hostname}:\${server.port}\`, redact({ app: config.app }));

installGracefulShutdown({
  timeoutMs: config.http.shutdownTimeoutMs,
  onShutdown: async () => {
    await server.stop();
    await application.shutdown();
  },
});
`;
}

function worker(): string {
  return `import { installGracefulShutdown } from '@framework/core';
import { JobWorker, QueueManager } from '@framework/queue';
import { jobs } from '../app/jobs';
import { createApplication } from '../bootstrap/app';
import { loadAppConfig } from '../config';

const config = await loadAppConfig();
const application = await createApplication(config).boot();

const queue = new QueueManager({ url: config.redis.url, prefix: config.queue.prefix, queue: config.queue.name });
const worker = new JobWorker(queue, application, jobs, {
  concurrency: config.queue.concurrency,
  onFailed: (job, error) => console.error(\`[worker] job \${job.name} (\${job.id ?? '?'}) failed\`, error),
});
worker.start();
console.error(\`[worker] consuming queue "\${config.queue.name}" (concurrency \${config.queue.concurrency})\`);

installGracefulShutdown({
  timeoutMs: config.http.shutdownTimeoutMs,
  onShutdown: async () => {
    await worker.close();
    await queue.close();
    await application.shutdown();
  },
});
`;
}

function cli({ name }: AppTemplateInput): string {
  return `import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryCache, RedisCache } from '@framework/cache';
import { defineProject, frameworkCommands, runCli } from '@framework/cli';
import { createConnection, type DatabaseConnection } from '@framework/database';
import { listRoutes } from '@framework/http';
import { createApplication } from '../bootstrap/app';
import { createHttp } from '../bootstrap/http';
import { createMiddleware } from '../bootstrap/middleware';
import { buildOpenApiDocument, operations } from '../bootstrap/openapi';
import { providers } from '../bootstrap/providers';
import { type AppConfig, loadAppConfig } from '../config';

const root = join(import.meta.dir, '..');

// The middleware alias table is config-driven; load it once for \`middleware:list\`.
const middleware = createMiddleware(await loadAppConfig({ envFile: join(root, '.env') }));

/**
 * \`make:auth\` installs the auth module (and the \`@framework/auth\`
 * dependency) into an existing application, so a freshly created app has
 * neither: the \`sessions\` hook below therefore only exists once the module
 * does, and the package is loaded through a runtime specifier for the same
 * reason. Without it, \`session:prune\` reports itself as unsupported and
 * points at \`make:auth\`.
 */
const authInstalled = existsSync(join(root, 'app/modules/auth/provider.ts'));
const AUTH_SPECIFIER: string = '@framework/auth';

/** Opens the application cache for \`cache:clear\`; the driver comes from configuration. */
const openCache = async (rawConfig: unknown) => {
  const config = rawConfig as AppConfig;
  const cache =
    config.cache.driver === 'redis'
      ? new RedisCache({ url: config.cache.redis.url, prefix: config.cache.redis.prefix })
      : new MemoryCache();
  return {
    driver: config.cache.driver,
    clear: () => cache.clear(),
    close: () => cache.close(),
  };
};

/**
 * Opens the auth session store for \`session:prune\` on its own connection:
 * the store satisfies the CLI's structural contract (count/prune/close) and
 * \`close()\` releases that connection.
 */
const openSessionStore = authInstalled
  ? async (rawConfig: unknown) => {
      const config = rawConfig as AppConfig;
      const auth = (await import(AUTH_SPECIFIER)) as {
        PgSessionStore: new (
          connection: DatabaseConnection,
        ) => {
          countExpired(now?: Date): Promise<number>;
          prune(now?: Date): Promise<number>;
        };
      };
      const connection = createConnection({
        url: config.database.url,
        maxConnections: config.database.maxConnections,
        applicationName: config.app.name,
      });
      const store = new auth.PgSessionStore(connection);
      return {
        countExpired: (now?: Date) => store.countExpired(now),
        prune: (now?: Date) => store.prune(now),
        close: () => connection.close(),
      };
    }
  : undefined;

/**
 * Application-local CLI: the project root comes from this file, never from the
 * shell's cwd. Exported for embedders (e.g. the MCP server) that invoke
 * commands in-process.
 */
export const project = defineProject({
  name: '${name}',
  root,
  frameworkVersion: '0.2.0',
  apiPrefix: '/api/v1',
  paths: {
    modules: 'app/modules',
    schemaDir: 'database/schema',
    schemaIndex: 'database/schema/index.ts',
    factories: 'database/factories',
    migrations: 'database/migrations',
    apiRoutes: 'routes/api.ts',
    providers: 'bootstrap/providers.ts',
    middleware: 'bootstrap/middleware.ts',
    openapi: 'bootstrap/openapi.ts',
    config: 'config/index.ts',
    testSupport: 'tests/support.ts',
  },
  tools: {
    typecheck: ['bunx', 'tsc', '-p', 'tsconfig.json'],
    test: ['bun', 'test'],
    lint: ['bunx', 'biome', 'check', '.'],
    format: ['bunx', 'biome', 'format', '.'],
    drizzleKit: ['bunx', 'drizzle-kit'],
    dev: ['bun', 'run', '--hot', 'bin/server.ts'],
    serve: ['bun', 'run', 'bin/server.ts'],
    worker: ['bun', 'run', 'bin/worker.ts'],
  },
  loadConfig: (envFile) => loadAppConfig({ envFile: envFile ?? join(root, '.env') }),
  databaseUrl: (config) => (config as AppConfig).database.url,
  queueUrl: (config) => ({
    url: (config as AppConfig).redis.url,
    prefix: (config as AppConfig).queue.prefix,
    queue: (config as AppConfig).queue.name,
  }),
  cache: openCache,
  ...(openSessionStore ? { sessions: openSessionStore } : {}),
  routes: async (config) => {
    // Booting only registers bindings (nothing connects); it makes the
    // listed route table match what the server actually serves.
    const booted = await createApplication(config as AppConfig).boot();
    try {
      return listRoutes(createHttp(booted));
    } finally {
      await booted.shutdown();
    }
  },
  providers: () => providers.map((provider) => provider.name),
  seeders: async () => (await import('../database/seeders')).seeders,
  middleware: () => middleware.describe(),
  openapi: () => ({ operations, build: buildOpenApiDocument }),
});

if (import.meta.main) {
  process.exitCode = await runCli({
    argv: process.argv.slice(2),
    project,
    commands: frameworkCommands,
    cliVersion: '0.2.0',
  });
}
`;
}

function testSupport({ className }: AppTemplateInput): string {
  // The type name is app-specific, so its Biome-sorted position relative to
  // `createApplication` varies per app; compute it instead of hard-coding one
  // order (which is wrong for roughly half of all names).
  const applicationType = `${className}Application`;
  const applicationImport =
    compareImportNames(applicationType, 'createApplication') < 0
      ? `import { type ${applicationType}, createApplication } from '../bootstrap/app';`
      : `import { createApplication, type ${applicationType} } from '../bootstrap/app';`;
  return `import { join } from 'node:path';
import { parseConfig } from '@framework/core';
import {
  createTestDatabase,
  type JsonRequester,
  requireTestDatabaseUrl,
  serveOnEphemeralPort,
} from '@framework/testing';
${applicationImport}
import { createHttp } from '../bootstrap/http';
import { configSchema, mapEnvironment } from '../config';

const APP_ROOT = join(import.meta.dir, '..');

export interface TestContext {
  readonly application: ${className}Application;
  readonly http: ReturnType<typeof createHttp>;
  /** In-process \`http.request\` by default; real loopback HTTP when TEST_MODE=network. */
  readonly client: JsonRequester;
  close(): Promise<void>;
}

/**
 * Boots the complete application against a fresh, migrated PostgreSQL
 * database. \`close()\` shuts down, stops any listener and drops the database
 * even when an earlier step fails.
 */
export async function createTestContext(): Promise<TestContext> {
  const database = await createTestDatabase({
    adminUrl: requireTestDatabaseUrl(),
    migrationsFolder: join(APP_ROOT, 'database/migrations'),
    applicationUrl: process.env.DATABASE_URL,
    environment: process.env.APP_ENV,
  });

  let application: ${className}Application | undefined;
  try {
    const config = parseConfig(
      configSchema,
      mapEnvironment({
        APP_ENV: 'test',
        APP_DEBUG: 'false',
        DATABASE_URL: database.url,
        DATABASE_MAX_CONNECTIONS: '4',
        // Suites issue many rapid requests from one client; the coarse
        // api-group ceiling is production behavior, not a test subject here.
        HTTP_THROTTLE_ENABLED: 'false',
      }),
    );
    application = await createApplication(config).boot();
    const http = createHttp(application);
    const server = process.env.TEST_MODE === 'network' ? serveOnEphemeralPort(http.fetch) : undefined;
    const booted = application;

    return {
      application: booted,
      http,
      client: server?.requester ?? { request: async (path, init) => http.request(path, init) },
      async close() {
        try {
          await server?.stop();
          await booted.shutdown();
        } finally {
          await database.drop();
        }
      },
    };
  } catch (error) {
    await application?.shutdown().catch(() => undefined);
    await database.drop();
    throw error;
  }
}
`;
}

function healthTest(): string {
  return `import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { parseConfig } from '@framework/core';
import { createApplication } from '../bootstrap/app';
import { createHttp } from '../bootstrap/http';
import { configSchema, mapEnvironment } from '../config';

/**
 * Smoke test of the generated application: boots the real HTTP stack with a
 * placeholder database URL (nothing connects until a query runs) and checks
 * liveness plus the error envelope. Endpoint suites generated by
 * \`make:crud --verify\` run against a real migrated PostgreSQL database.
 */
let http: ReturnType<typeof createHttp>;
let application: Awaited<ReturnType<typeof createApplication>> | undefined;

beforeAll(async () => {
  const config = parseConfig(
    configSchema,
    mapEnvironment({
      APP_ENV: 'test',
      APP_DEBUG: 'false',
      // Never connected: /health/live does not touch the database.
      DATABASE_URL: 'postgres://app:unused@127.0.0.1:1/unused',
    }),
  );
  application = await createApplication(config).boot();
  http = createHttp(application);
});

afterAll(async () => {
  await application?.shutdown();
});

describe('generated application', () => {
  test('liveness responds and unknown routes use the error envelope', async () => {
    const call = (path: string) => http.fetch(new Request(\`http://localhost\${path}\`));
    const live = await call('/health/live');
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: 'ok' });

    const missing = await call('/api/v1/does-not-exist');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: 'ROUTE_NOT_FOUND' } });
  });
});
`;
}

function compose({ name }: AppTemplateInput): string {
  const db = name.replaceAll('-', '_');
  return `# Development infrastructure (default profile) and the full application
# stack (profile "app": server/worker containers from ./Dockerfile).
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: ${db}
    ports:
      - '127.0.0.1:5432:5432'
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U postgres']
      interval: 5s
      timeout: 3s
      retries: 10

  redis:
    image: redis:7.4-alpine
    ports:
      - '127.0.0.1:6379:6379'
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
      timeout: 3s
      retries: 10

  server:
    build: .
    profiles: ['app']
    command: ['bun', 'run', 'bin/server.ts']
    ports:
      - '3000:3000'
    environment: &app-env
      APP_ENV: production
      DATABASE_URL: postgres://postgres:postgres@postgres:5432/${db}
      REDIS_URL: redis://redis:6379
      CACHE_DRIVER: redis
      CACHE_REDIS_URL: redis://redis:6379
      CACHE_REDIS_PREFIX: ${name}
      QUEUE_NAME: default
      QUEUE_PREFIX: ${name}
      EVENTS_DRIVER: redis
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    healthcheck:
      test: ['CMD', 'wget', '-qO-', 'http://127.0.0.1:3000/health/ready']
      interval: 10s
      timeout: 5s
      retries: 6
      start_period: 15s

  worker:
    build: .
    profiles: ['app']
    command: ['bun', 'run', 'bin/worker.ts']
    environment: *app-env
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: unless-stopped
`;
}

function dockerfile(): string {
  return `# Multi-stage build: dependencies install and typecheck run in cached
# layers; the runtime image carries only production dependencies and source.
FROM oven/bun:1.4.2-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM deps AS build
COPY . .
# Fail the image build on a broken tree before it ships.
RUN bunx tsc -p tsconfig.json

FROM oven/bun:1.4.2-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/bun.lock ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/bin bin
COPY --from=build /app/bootstrap bootstrap
COPY --from=build /app/app app
COPY --from=build /app/routes routes
COPY --from=build /app/config config
COPY --from=build /app/database database
# Non-root runtime user.
USER bun
CMD ["bun", "run", "bin/server.ts"]
`;
}
