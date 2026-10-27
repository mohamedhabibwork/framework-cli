import { dirname, join, relative, resolve } from 'node:path';
import { failure, usageError } from '../../errors';
import { importPath } from '../paths';
import { buildChanges, type FileChange, type FileUpdate, type NewFile } from '../plan';
import { addImport, insertAfterMarker } from '../registration';
import { type AuthFiles, authFiles, renderAuthIndex, renderAuthProvider, renderAuthRoutes } from './templates';

/** The bootstrap composition file both `create` and existing apps use. */
const BOOTSTRAP_HTTP = 'bootstrap/http.ts';
const ROUTE_MOUNT = ".route('/api/v1/auth', authRoutes(config))";

/** Framework auth tables re-exported from the app's schema index. */
const AUTH_TABLE_EXPORTS = ['accountTokens', 'apiTokens', 'sessions', 'totpRecoveryCodes', 'users'] as const;

/** Line width of the generated app's `biome.json` formatter (see app templates). */
const FORMATTER_LINE_WIDTH = 120;

/**
 * The `@framework:schema-exports` statement for the auth tables, emitted in the
 * exact shape Biome's formatter produces: a single line when it fits, otherwise
 * one name per line. Keeps generated output lint-clean even with a long
 * workspace-relative specifier.
 */
function authSchemaExport(specifier: string): string {
  const oneLine = `export { ${AUTH_TABLE_EXPORTS.join(', ')} } from '${specifier}';`;
  if (oneLine.length <= FORMATTER_LINE_WIDTH) return oneLine;
  return `export {\n  ${AUTH_TABLE_EXPORTS.join(',\n  ')},\n} from '${specifier}';`;
}

/** Nearest enclosing framework workspace (a directory owning packages/cli), if any. */
async function frameworkWorkspaceRoot(from: string): Promise<string | null> {
  let current = resolve(from);
  for (;;) {
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
    if (await Bun.file(join(current, 'packages/cli/package.json')).exists()) return current;
  }
}

/**
 * Import specifier for the framework-owned auth tables. Inside the framework
 * workspace, drizzle-kit's CJS loader cannot resolve `@framework/*` exports,
 * so generators use a workspace-relative source path (as `create` does for
 * its schema docs); standalone installs fall back to the package specifier.
 */
async function authTablesSpecifier(context: { root: string }, schemaIndex: string): Promise<string> {
  const workspace = await frameworkWorkspaceRoot(context.root);
  const target = workspace ? join(workspace, 'packages/auth/src/schema/tables') : null;
  if (target && (await Bun.file(`${target}.ts`).exists())) {
    return relative(join(context.root, dirname(schemaIndex)), target)
      .split('\\')
      .join('/');
  }
  return '@framework/auth';
}

export interface AuthPlan {
  readonly files: AuthFiles;
  readonly guards: readonly string[];
  readonly changes: readonly FileChange[];
  readonly migrationName: 'create-auth-tables';
}

/** Computes the reviewed change set for installing the auth module. */
export async function planAuth(
  context: { root: string; project: { paths: import('../../project').ProjectPaths } },
  guards: readonly string[],
  force: boolean,
): Promise<AuthPlan> {
  const paths = context.project.paths;
  const files = authFiles(paths);
  if (!force && (await Bun.file(join(context.root, files.index)).exists())) {
    throw usageError(
      `Auth module ${files.moduleDir} already exists`,
      'It is already installed; use --force to regenerate its generator-owned files.',
    );
  }

  // A single selected guard is pinned in config; both stay the validated default.
  const schemaSection =
    guards.length === 2 ? 'auth: authConfigSchema,' : `auth: authConfigSchema.prefault({ guards: ['${guards[0]}'] }),`;

  const newFiles: readonly NewFile[] = [
    { path: files.provider, content: renderAuthProvider(files, paths.config) },
    { path: files.routes, content: renderAuthRoutes(files, paths.config) },
    { path: files.index, content: renderAuthIndex() },
  ];

  const workspace = await frameworkWorkspaceRoot(context.root);
  const authDepSpec = workspace ? 'workspace:*' : 'github:mohamedhabibwork/framework-auth#standalone';
  const tablesSpecifier = await authTablesSpecifier(context, paths.schemaIndex);

  const updates: readonly FileUpdate[] = [
    {
      path: 'package.json',
      transform: (source) => {
        const pkg = JSON.parse(source) as { dependencies: Record<string, string> };
        pkg.dependencies['@framework/auth'] = authDepSpec;
        pkg.dependencies = Object.fromEntries(Object.entries(pkg.dependencies).sort(([a], [b]) => a.localeCompare(b)));
        return `${JSON.stringify(pkg, null, 2)}\n`;
      },
    },
    {
      path: paths.config,
      transform: (source) => {
        let next = addImport(source, "import { authConfigSchema } from '@framework/auth';");
        next = insertAfterMarker(next, '@framework:config-schema-sections', schemaSection, paths.config);
        return insertAfterMarker(next, '@framework:config-env-sections', 'auth: {},', paths.config);
      },
    },
    {
      path: paths.schemaIndex,
      transform: (source) =>
        insertAfterMarker(source, '@framework:schema-exports', authSchemaExport(tablesSpecifier), paths.schemaIndex),
    },
    {
      path: paths.providers,
      transform: (source) =>
        insertAfterMarker(
          addImport(source, `import { authProvider } from '${importPath(paths.providers, files.index)}';`),
          '@framework:providers',
          'authProvider,',
          paths.providers,
        ),
    },
    {
      path: BOOTSTRAP_HTTP,
      transform: (source) => {
        if (source.includes('/api/v1/auth')) {
          throw usageError(`Route collision: /api/v1/auth is already mounted in ${BOOTSTRAP_HTTP}`);
        }
        const mountAnchor = ".route('/api/v1', apiRoutes)";
        if (!source.includes(mountAnchor)) {
          throw failure(
            'REGISTRATION_MARKER_MISSING',
            `Anchor "${mountAnchor}" not found in ${BOOTSTRAP_HTTP}`,
            "Mount the auth routes manually: .route('/api/v1/auth', authRoutes(config)),",
          );
        }
        // The guard resolves identity before the request scope exists; without
        // it the kernel would treat every request as anonymous.
        const kernelAnchor = 'createHttpKernel(application, {';
        if (!source.includes(kernelAnchor)) {
          throw failure(
            'REGISTRATION_MARKER_MISSING',
            `Anchor "${kernelAnchor}" not found in ${BOOTSTRAP_HTTP}`,
            'Wire the guard manually: resolveActor: authActorResolver(application), in the kernel options.',
          );
        }
        const withImports = addImport(
          addImport(source, `import { authActorResolver } from '@framework/auth';`),
          `import { authRoutes } from '${importPath(BOOTSTRAP_HTTP, files.index)}';`,
        );
        return withImports
          .replace(kernelAnchor, `${kernelAnchor}\n    resolveActor: authActorResolver(application),`)
          .replace(mountAnchor, `${mountAnchor}\n    ${ROUTE_MOUNT}`);
      },
    },
  ];

  const changes = await buildChanges(context.root, newFiles, updates, force);
  return { files, guards, changes, migrationName: 'create-auth-tables' };
}
