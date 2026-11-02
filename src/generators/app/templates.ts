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
    { path: '.oxlintrc.json', content: oxlintJson() },
    { path: '.oxfmtrc.json', content: oxfmtJson() },
    { path: '.env.example', content: envExample(input) },
    { path: '.gitignore', content: gitignore() },
    { path: 'README.md', content: readme(input) },
    { path: 'drizzle.config.ts', content: drizzleConfig() },
    { path: 'config/index.ts', content: config(input) },
    { path: 'bootstrap/app.ts', content: bootstrapApp(input) },
    { path: 'bootstrap/middleware.ts', content: bootstrapMiddleware() },
    { path: 'app/jobs/index.ts', content: jobsRegistry() },
    { path: 'app/notifications/index.ts', content: notificationsRegistry() },
    { path: 'app/listeners/index.ts', content: listenersRegistry() },
    { path: 'app/listeners/listeners.provider.ts', content: listenersProvider() },
    { path: 'routes/data.ts', content: dataRoutes() },
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
    "lint": "oxlint",
    "lint:fix": "oxlint --fix",
    "format": "oxfmt",
    "format:check": "oxfmt --check",
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
    "@framework/mail": "workspace:*",
    "@framework/notifications": "workspace:*",
    "@framework/openapi": "workspace:*",
    "@framework/queue": "workspace:*",
    "@framework/presets": "workspace:*",
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

function oxlintJson(): string {
  return `{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "categories": {
    "correctness": "error",
    "suspicious": "error"
  },
  "plugins": ["typescript", "unicorn", "import", "promise"],
  "rules": {
    "eslint/no-unused-vars": [
      "error",
      { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_", "caughtErrorsIgnorePattern": "^_" }
    ],
    "eslint/no-console": ["warn", { "allow": ["warn", "error"] }],
    "eslint/no-await-in-loop": "off",
    "eslint/no-shadow": "off",
    "eslint/no-unused-expressions": "off",
    "eslint/no-new": "off",
    "eslint/no-useless-constructor": "off",
    "eslint/no-underscore-dangle": "off",
    "typescript/no-explicit-any": "error",
    "typescript/no-non-null-assertion": "error",
    "typescript/no-this-alias": "off",
    "unicorn/prefer-node-protocol": "error",
    "unicorn/no-array-sort": "off",
    "unicorn/no-array-reverse": "off",
    "unicorn/consistent-function-scoping": "off",
    "unicorn/no-useless-spread": "off",
    "unicorn/no-useless-fallback-in-spread": "off",
    "import/no-duplicates": "off"
  },
  "overrides": [
    {
      "files": ["tests/**/*.ts", "**/tests/**/*.ts"],
      "rules": {
        "eslint/no-console": "off"
      }
    }
  ],
  "ignorePatterns": ["dist", "coverage", "node_modules", "**/database/migrations/meta"]
}
`;
}

function oxfmtJson(): string {
  return `{
  "$schema": "./node_modules/oxfmt/configuration_schema.json",
  "printWidth": 120,
  "tabWidth": 2,
  "useTabs": false,
  "singleQuote": true,
  "semi": true,
  "trailingComma": "all",
  "ignorePatterns": ["dist", "coverage", "node_modules", "**/database/migrations/meta"]
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

# Outbound mail (console transport by default; memory for tests).
MAIL_DRIVER=console
MAIL_FROM=no-reply@${name}.local
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
- \`app/providers/\` — your own providers (\`make:provider\`)
- \`bootstrap/app.ts\` — the application in one place: providers, modules, health, routes, OpenAPI
- \`bootstrap/middleware.ts\` — named middleware aliases and groups
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
\`logging\` and \`storage\` sections of \`config/index.ts\` and installed by
\`apiPreset\` (\`@framework/presets\`) in \`bootstrap/app.ts\`. Three CLI commands operate them:

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
  return `import { type DefineConfigLoadOptions, defineConfig, fromEnv, type InferConfig } from '@framework/core';
import { z } from 'zod/v4';

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');

/** One schema per setting, bound to its variable. Precedence: process env > env file > defaults. */
export const appConfig = defineConfig({
  app: z.object({
    name: fromEnv('APP_NAME', z.string().min(1).default('${name}')),
    env: fromEnv('APP_ENV', z.enum(['development', 'test', 'production']).default('development')),
    debug: fromEnv('APP_DEBUG', booleanString.default(false)),
  }),
  http: z.object({
    host: fromEnv('HTTP_HOST', z.string().min(1).default('127.0.0.1')),
    port: fromEnv('HTTP_PORT', z.coerce.number().int().min(0).max(65535).default(3000)),
    corsOrigins: fromEnv(
      'CORS_ORIGINS',
      z
        .string()
        .default('')
        .transform((value) =>
          value
            .split(',')
            .map((origin) => origin.trim())
            .filter(Boolean),
        ),
    ),
    maxBodyBytes: fromEnv(
      'HTTP_MAX_BODY_BYTES',
      z.coerce
        .number()
        .int()
        .min(1)
        .default(1024 * 1024),
    ),
    secureHeaders: fromEnv('HTTP_SECURE_HEADERS', booleanString.default(true)),
    throttle: z.object({
      enabled: fromEnv('HTTP_THROTTLE_ENABLED', booleanString.default(true)),
      limit: fromEnv('HTTP_THROTTLE_LIMIT', z.coerce.number().int().min(1).default(120)),
      windowSeconds: fromEnv('HTTP_THROTTLE_WINDOW_SECONDS', z.coerce.number().int().min(1).default(60)),
    }),
    shutdownTimeoutMs: fromEnv('SHUTDOWN_TIMEOUT_MS', z.coerce.number().int().min(100).default(10_000)),
  }),
  database: z.object({
    url: fromEnv('DATABASE_URL', z.url({ protocol: /^postgres(ql)?$/ })),
    maxConnections: fromEnv('DATABASE_MAX_CONNECTIONS', z.coerce.number().int().min(1).max(100).default(10)),
    migrationsFolder: fromEnv('DATABASE_MIGRATIONS_FOLDER', z.string().default('database/migrations')),
  }),
  redis: z.object({
    url: fromEnv('REDIS_URL', z.url({ protocol: /^redis$/ }).default('redis://127.0.0.1:6379')),
  }),
  queue: z.object({
    name: fromEnv('QUEUE_NAME', z.string().min(1).default('default')),
    concurrency: fromEnv('QUEUE_CONCURRENCY', z.coerce.number().int().min(1).max(64).default(4)),
    prefix: fromEnv('QUEUE_PREFIX', z.string().min(1).default('${name}')),
  }),
  events: z.object({
    driver: fromEnv('EVENTS_DRIVER', z.enum(['memory', 'redis']).default('memory')),
  }),
  cache: z.object({
    driver: fromEnv('CACHE_DRIVER', z.enum(['memory', 'redis']).default('redis')),
    redis: z.object({
      url: fromEnv('CACHE_REDIS_URL', z.url({ protocol: /^redis$/ }).default('redis://127.0.0.1:6379')),
      prefix: fromEnv('CACHE_REDIS_PREFIX', z.string().min(1).default('${name}')),
    }),
  }),
  logging: z.object({
    level: fromEnv('LOG_LEVEL', z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info')),
    driver: fromEnv('LOG_DRIVER', z.enum(['console', 'file', 'memory']).default('console')),
    name: fromEnv('LOG_NAME', z.string().min(1).default('${name}')),
    filePath: fromEnv('LOG_FILE_PATH', z.string().min(1).optional()),
    maxBytes: fromEnv('LOG_MAX_BYTES', z.coerce.number().int().positive().optional()),
  }),
  storage: z.object({
    default: fromEnv('STORAGE_DEFAULT', z.string().min(1).default('local')),
    disks: z.object({
      local: z.object({
        driver: z.literal('local').default('local'),
        root: fromEnv('STORAGE_ROOT', z.string().min(1).default('storage')),
        visibility: fromEnv('STORAGE_VISIBILITY', z.enum(['private', 'public']).default('private')),
      }),
    }),
  }),
  mail: z.object({
    driver: fromEnv('MAIL_DRIVER', z.enum(['console', 'memory']).default('console')),
    from: fromEnv('MAIL_FROM', z.string().trim().toLowerCase().email().default('no-reply@${name}.local')),
  }),
  notifications: z.object({
    providers: z
      .object({
        push: z
          .object({
            type: fromEnv('NOTIFICATIONS_PUSH_TYPE', z.string().trim().min(1)),
            target: z.string().trim().min(1).optional(),
            options: z.record(z.string(), z.unknown()).optional(),
          })
          .optional(),
        messaging: z
          .object({
            type: fromEnv('NOTIFICATIONS_MESSAGING_TYPE', z.string().trim().min(1)),
            target: z.string().trim().min(1).optional(),
            options: z.record(z.string(), z.unknown()).optional(),
          })
          .optional(),
      })
      .optional(),
  }),
  // @framework:config-schema-sections
});

export type AppConfig = InferConfig<typeof appConfig>;

export const loadAppConfig = (options?: DefineConfigLoadOptions) => appConfig.load(options);
`;
}

function bootstrapApp({ className, apiTitle }: AppTemplateInput): string {
  return `import type { Application } from '@framework/core';
import { auditRoutes, dataOperations } from '@framework/crud';
import { AUDIT_READER } from '@framework/database';
import { defineApp, defineModule, type FrameworkEnv, forbidden, resolve } from '@framework/http';
import { generateOpenApiDocument, type Operation } from '@framework/openapi';
import { apiPreset, WEBSOCKET_GATEWAY } from '@framework/presets';
import type { Context } from 'hono';
import { notificationDeliveryJob } from '../app/jobs';
import { listenersProvider } from '../app/listeners/listeners.provider';
import { notifications } from '../app/notifications';
import type { AppConfig } from '../config';
import { dataRoutes } from '../routes/data';
import { createMiddleware } from './middleware';

export type ${className}Application = Application<AppConfig>;

/** Queued import/export endpoints under /api/v1/data (see \`routes/data.ts\`). */
const dataModule = defineModule<AppConfig, Operation>({
  name: 'data',
  routes: { path: '/data', app: dataRoutes },
  operations: dataOperations({ mount: '/api/v1/data' }),
});

/**
 * Database, cache, queue, events, logging, storage, mail, notifications and
 * import/export, configured by \`config/index.ts\`. Replace a part by passing
 * a provider (\`mail: myMailProvider\`) or remove it (\`data: false\`).
 */
const api = apiPreset<AppConfig>({ notifications: { definitions: notifications, job: notificationDeliveryJob } });

/**
 * The application, registered in one place. Generators add providers and
 * modules below their markers; list order does not matter (boot order comes
 * from each provider's \`dependsOn\` / \`provides\` / \`requires\`).
 *
 * The kernel owns the fixed outer order: request id -> body limit -> request
 * scope -> secure headers (\`http.secureHeaders\`) -> CORS (\`http.corsOrigins\`,
 * off when empty). The \`api\` middleware group (shared throttle) then wraps
 * \`/health\`, every module under \`/api/v1\`, and the app routes.
 *
 * Audit endpoints (\`/audit\`) are denied in production until an
 * identity/authorization layer exists. The \`/ws\` gateway opens private
 * \`user.<id>\` channels for authenticated actors and broadcasts presence.
 * Replace any binding with \`overrides: (container) => container.override(…)\`.
 */
export const app = defineApp<AppConfig, Operation>({
  http: (config) => ({
    exposeInternalErrors: config.app.debug && config.app.env !== 'production',
    maxBodyBytes: config.http.maxBodyBytes,
    secureHeaders: config.http.secureHeaders,
    cors: { origins: config.http.corsOrigins },
    report: (error, context) => console.error('[http] unhandled error', context, error),
  }),
  middleware: (config) => createMiddleware(config).resolve(['api']),
  providers: [
    ...api.providers,
    listenersProvider,
    // @framework:providers
  ],
  modules: [
    dataModule,
    // @framework:modules
  ],
  health: api.health,
  routes: (http, { config, container }) => {
    // @framework:app-routes
    http.route(
      '/audit',
      auditRoutes({
        authorize: (_c: Context<FrameworkEnv>) => {
          if (config.app.env === 'production') throw forbidden('Audit endpoints require authorization');
        },
        reader: (c: Context<FrameworkEnv>) => resolve(c, AUDIT_READER),
      }),
    );
    http.route('/ws', container.resolve(WEBSOCKET_GATEWAY).routes());
  },
});

/** Builds the framework application with overrides applied. Callers boot it and own its shutdown. */
export const createApplication = (config: AppConfig): ${className}Application => app.createApplication(config);

/**
 * The HTTP app. Hono RPC clients type against a module's routes, e.g.
 * \`hc<typeof productRoutes>('/api/v1/products')\`.
 */
export const createHttp = (application: ${className}Application) => app.createHttp(application);

/** Session auth is a cookie; API clients authenticate with Bearer tokens. */
const securitySchemes = {
  sessionCookie: { type: 'apiKey', in: 'cookie', name: 'fw_session' },
  bearerAuth: { type: 'http', scheme: 'bearer' },
} as const;

export function buildOpenApiDocument(version = '1.0.0') {
  return generateOpenApiDocument({ title: '${apiTitle}', version, operations: app.operations, securitySchemes });
}
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

function notificationsRegistry(): string {
  return `import type { AnyNotificationDefinition } from '@framework/notifications';

/**
 * Application notifications registered with \`NotificationsService\`.
 * Generate new notifications with \`make:notification\` and add them below.
 */
export const notifications: readonly AnyNotificationDefinition[] = [
  // @framework:notifications
];
`;
}

function jobsRegistry(): string {
  return `import { defineNotificationJob } from '@framework/notifications';
import type { JobList } from '@framework/queue';

/** Built-in queued notification delivery job (\`@framework/notifications\`). */
export const notificationDeliveryJob = defineNotificationJob();

/**
 * The application's job handlers, run by \`bun run worker\`
 * (or \`bun run cli -- queue:work\`). Each job declares a versioned, validated
 * payload and an idempotent handler; add jobs with \`defineJob\`.
 */
export const jobs: JobList = [
  notificationDeliveryJob,
  // @framework:jobs
];
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

function dataRoutes(): string {
  return `import { EXECUTION_CONTEXT } from '@framework/core';
import { importExportRoutes } from '@framework/crud';
import { forbidden, resolve } from '@framework/http';
import { DATA_PORTER } from '@framework/presets';
import { loadAppConfig } from '../config';

// Loaded once; the authorization guard reads the validated env from it.
const configPromise = loadAppConfig();
/**
 * Queued import/export endpoints (registered and documented as the \`data\`
 * module in \`bootstrap/app.ts\`):
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
  return `import { websocket } from '@framework/events';
import { runServer } from '@framework/http';
import { createApplication, createHttp } from '../bootstrap/app';
import { loadAppConfig } from '../config';

const config = await loadAppConfig();
const application = await createApplication(config).boot();

// Drains in-flight requests on SIGTERM/SIGINT, then shuts the application down.
await runServer({
  application,
  fetch: createHttp(application).fetch,
  hostname: config.http.host,
  port: config.http.port,
  websocket,
  shutdownTimeoutMs: config.http.shutdownTimeoutMs,
});
`;
}

function worker(): string {
  return `import { QueueManager, runWorker } from '@framework/queue';
import { jobs } from '../app/jobs';
import { createApplication } from '../bootstrap/app';
import { loadAppConfig } from '../config';

const config = await loadAppConfig();
const application = await createApplication(config).boot();

// Drains in-flight jobs on SIGTERM/SIGINT, then shuts the application down.
runWorker({
  application,
  queue: new QueueManager({ url: config.redis.url, prefix: config.queue.prefix, queue: config.queue.name }),
  jobs,
  concurrency: config.queue.concurrency,
  shutdownTimeoutMs: config.http.shutdownTimeoutMs,
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
import { app, buildOpenApiDocument, createApplication, createHttp } from '../bootstrap/app';
import { createMiddleware } from '../bootstrap/middleware';
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
        PgSessionStore: new (connection: DatabaseConnection) => {
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
    app: 'bootstrap/app.ts',
    providers: 'bootstrap/app.ts',
    middleware: 'bootstrap/middleware.ts',
    config: 'config/index.ts',
    testSupport: 'tests/support.ts',
  },
  tools: {
    typecheck: ['bunx', 'tsc', '-p', 'tsconfig.json'],
    test: ['bun', 'test'],
    lint: ['bunx', 'oxlint', '.'],
    format: ['bunx', 'oxfmt', '.'],
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
  providers: () => app.providers.map((provider) => provider.name),
  seeders: async () => (await import('../database/seeders')).seeders,
  middleware: () => middleware.describe(),
  openapi: () => ({ operations: app.operations, build: buildOpenApiDocument }),
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
  const applicationNames = [applicationType, 'createApplication', 'createHttp']
    .sort(compareImportNames)
    .map((name) => (name === applicationType ? `type ${name}` : name));
  const applicationImport = `import { ${applicationNames.join(', ')} } from '../bootstrap/app';`;
  return `import { join } from 'node:path';
import {
  createTestDatabase,
  type JsonRequester,
  requireTestDatabaseUrl,
  serveOnEphemeralPort,
} from '@framework/testing';
${applicationImport}
import { appConfig } from '../config';

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
    const config = appConfig.parse({
      APP_ENV: 'test',
      APP_DEBUG: 'false',
      DATABASE_URL: database.url,
      DATABASE_MAX_CONNECTIONS: '4',
      // Suites issue many rapid requests from one client; the coarse
      // api-group ceiling is production behavior, not a test subject here.
      HTTP_THROTTLE_ENABLED: 'false',
    });
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
import { createApplication, createHttp } from '../bootstrap/app';
import { appConfig } from '../config';

/**
 * Smoke test of the generated application: boots the real HTTP stack with a
 * placeholder database URL (nothing connects until a query runs) and checks
 * liveness plus the error envelope. Endpoint suites generated by
 * \`make:crud --verify\` run against a real migrated PostgreSQL database.
 */
let http: ReturnType<typeof createHttp>;
let application: Awaited<ReturnType<typeof createApplication>> | undefined;

beforeAll(async () => {
  const config = appConfig.parse({
    APP_ENV: 'test',
    APP_DEBUG: 'false',
    // Never connected: /health/live does not touch the database.
    DATABASE_URL: 'postgres://app:unused@127.0.0.1:1/unused',
  });
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
