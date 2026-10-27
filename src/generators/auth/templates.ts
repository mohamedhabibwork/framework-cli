import type { ProjectPaths } from '../../project';
import { importPath } from '../paths';

export interface AuthFiles {
  readonly moduleDir: string;
  readonly provider: string;
  readonly routes: string;
  readonly index: string;
}

/** Destination of the generated auth module (fixed at `app/modules/auth`). */
export function authFiles(paths: ProjectPaths): AuthFiles {
  const moduleDir = `${paths.modules}/auth`;
  return {
    moduleDir,
    provider: `${moduleDir}/provider.ts`,
    routes: `${moduleDir}/routes.ts`,
    index: `${moduleDir}/index.ts`,
  };
}

export function renderAuthProvider(files: AuthFiles, configFile: string): string {
  return [
    "import { createAuthProvider } from '@framework/auth';",
    `import type { AppConfig } from '${importPath(files.provider, configFile)}';`,
    '',
    '/**',
    ' * Session + personal API token authentication over the framework-owned',
    ' * `users`/`sessions`/`api_tokens` tables (singletons on the database',
    ' * connection). The guard is wired into the HTTP kernel by bootstrap/http.ts.',
    ' */',
    'export const authProvider = createAuthProvider<AppConfig>();',
    '',
  ].join('\n');
}

export function renderAuthRoutes(files: AuthFiles, configFile: string): string {
  return [
    "import { AUTH_SERVICE, type AuthConfig, defineAuthRoutes } from '@framework/auth';",
    "import { csrf } from 'hono/csrf';",
    `import type { AppConfig } from '${importPath(files.routes, configFile)}';`,
    '',
    '/**',
    ' * Framework auth endpoints (register/login/logout/me + API tokens). CSRF',
    ' * guards the cookie flows with the app\u2019s CORS origins; AUTH_SERVICE is',
    ' * resolved per request, so composition order stays free.',
    ' */',
    "export const authRoutes = (config: Pick<AppConfig, 'auth' | 'http'>) =>",
    '  defineAuthRoutes({',
    '    service: AUTH_SERVICE,',
    "    session: config.auth.session as Pick<AuthConfig['session'], 'cookie' | 'ttlSeconds' | 'secure'>,",
    '    csrf: csrf({ origin: [...config.http.corsOrigins] }),',
    '  });',
    '',
  ].join('\n');
}

export function renderAuthIndex(): string {
  return ["export { authProvider } from './provider';", "export { authRoutes } from './routes';", ''].join('\n');
}
