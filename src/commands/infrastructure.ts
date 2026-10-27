import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { flag, stringOption } from '../args';
import { type CommandContext, defineCommand } from '../command';
import { failure, unsupported, usageError } from '../errors';
import { resolveInsideProject } from '../generators/paths';
import { table } from '../output';
import { loadConfigOrFail } from './project';

/**
 * Textual capability gate for infrastructure commands: the corresponding
 * provider must be registered before the command runs. Same approach as
 * `resolveAccess` for `authProvider` — the providers file is read as text, so
 * no application code is booted and no connections are opened.
 */
async function requireProvider(
  context: CommandContext,
  command: string,
  symbol: string,
  moduleName: string,
  hint: string,
): Promise<void> {
  const file = resolveInsideProject(context.root, context.project.paths.providers);
  const source = await Bun.file(file)
    .text()
    .catch(() => '');
  if (!source.includes(symbol)) {
    throw unsupported(
      `"${command}" requires the ${moduleName} module (no ${symbol} registered in ${context.project.paths.providers})`,
      hint,
    );
  }
}

/** Destructive operations execute only with --confirm; --dry-run writes nothing. */
function requireConfirmation(command: string, dryRun: boolean, confirmed: boolean): void {
  if (!dryRun && !confirmed) {
    throw usageError(`"${command}" is destructive: re-run with --confirm to proceed, or with --dry-run to preview`);
  }
}

export const infrastructureCommands = [
  defineCommand({
    name: 'cache:clear',
    group: 'cache',
    status: 'implemented',
    description: "Clear the application's cache namespace (--confirm required; --dry-run writes nothing)",
    options: [
      {
        name: 'store',
        type: 'string',
        placeholder: '<name>',
        description: 'Named store; the provider registers a single default namespace',
      },
      { name: 'dry-run', type: 'boolean', description: 'Preview the operation; write nothing' },
      { name: 'confirm', type: 'boolean', description: 'Confirm deleting every cached entry in the namespace' },
    ],
    requires: ['@framework/cache (cacheProvider registered)'],
    async run({ options }, context) {
      await requireProvider(
        context,
        'cache:clear',
        'cacheProvider',
        'cache',
        'Add @framework/cache and register createCacheProvider(...) in the providers file first.',
      );
      const store = stringOption(options, 'store');
      if (store && store !== 'default') {
        throw usageError(
          `Unknown cache store "${store}"`,
          'The cache provider registers a single default namespace; omit --store.',
        );
      }
      const dryRun = flag(options, 'dry-run');
      requireConfirmation('cache:clear', dryRun, flag(options, 'confirm'));
      if (dryRun) {
        context.print('Dry run: would clear the application cache namespace (no entries touched)');
        return { data: { dryRun: true, cleared: false } };
      }
      if (!context.project.cache) {
        throw unsupported(
          '"cache:clear" needs runtime cache access',
          'Add a `cache(config)` hook to this project CLI adapter that opens the CACHE binding created by createCacheProvider.',
        );
      }
      const handle = await context.project.cache(await loadConfigOrFail(context));
      try {
        let entries: number;
        try {
          entries = await handle.clear();
        } catch (error) {
          // Capability-honest failures: the catalogued cache codes stay visible
          // (redis engines deliberately cannot clear a namespace).
          const code = (error as { code?: string }).code;
          if (code === 'CACHE_UNSUPPORTED_OPERATION') {
            throw failure(
              code,
              'The configured cache driver cannot clear its namespace (redis engines cannot clear by namespace)',
              'The memory driver clears natively; on redis, delete known keys instead.',
              error,
            );
          }
          if (typeof code === 'string' && code.startsWith('CACHE_')) {
            throw failure(code, error instanceof Error ? error.message : 'Cache operation failed', undefined, error);
          }
          throw error;
        }
        context.print(`Cleared the ${handle.driver} cache namespace (${entries} entries removed).`);
        return { data: { cleared: true, driver: handle.driver, entries } };
      } finally {
        await handle.close();
      }
    },
  }),
  defineCommand({
    name: 'storage:check',
    group: 'storage',
    status: 'implemented',
    description: 'Validate disk configuration (read-only; roots are reported, never created)',
    requires: ['@framework/storage (storageProvider registered)'],
    async run(_input, context) {
      await requireProvider(
        context,
        'storage:check',
        'storageProvider',
        'storage',
        'Add @framework/storage and register createStorageProvider(...) in the providers file first.',
      );
      const config = await loadConfigOrFail(context);
      const section = (config as { storage?: { default?: unknown; disks?: unknown } }).storage;
      if (!section || typeof section !== 'object' || !section.disks || typeof section.disks !== 'object') {
        throw failure(
          'STORAGE_CONFIG_INVALID',
          'The configuration has no usable `storage` section (storage.disks is missing)',
          'Define storage.default and storage.disks for the storage provider.',
        );
      }
      const disks = section.disks as Record<string, unknown>;
      const issues: string[] = [];
      const declaredDefault = typeof section.default === 'string' ? section.default : undefined;
      if (!declaredDefault) issues.push('storage.default must name the default disk');
      else if (!(declaredDefault in disks)) issues.push(`storage.default references unknown disk "${declaredDefault}"`);

      const rows = Object.entries(disks).map(([name, entry]) => inspectDisk(context, name, entry, issues));
      for (const line of table(
        rows.map((row) => ({
          disk: row.name,
          driver: row.driver,
          visibility: row.visibility,
          root: row.root,
          publicBaseUrl: row.publicBaseUrl,
          status: row.status,
        })),
        ['disk', 'driver', 'visibility', 'root', 'publicBaseUrl', 'status'],
      ))
        context.print(line);
      if (issues.length > 0) {
        throw failure('STORAGE_CHECK_FAILED', `Disk configuration is invalid (${issues.join('; ')})`);
      }
      context.print(`Disk configuration is valid (${rows.length} disk(s)).`);
      return { data: { default: declaredDefault ?? null, valid: true, disks: rows } };
    },
  }),
  defineCommand({
    name: 'session:prune',
    group: 'cache',
    status: 'implemented',
    description: 'Remove expired sessions (--confirm required; --dry-run only counts them)',
    options: [
      { name: 'dry-run', type: 'boolean', description: 'Count expired sessions without deleting them' },
      { name: 'confirm', type: 'boolean', description: 'Confirm deleting the expired sessions' },
    ],
    requires: ['@framework/auth (authProvider registered)', 'PostgreSQL connection'],
    async run({ options }, context) {
      await requireProvider(
        context,
        'session:prune',
        'authProvider',
        'auth',
        'Run `make:auth` first, or register createAuthProvider(...) from @framework/auth in the providers file.',
      );
      if (!context.project.sessions) {
        throw unsupported(
          '"session:prune" needs runtime session-store access',
          'Add a `sessions(config)` hook to this project CLI adapter that opens PgSessionStore on the database connection.',
        );
      }
      const dryRun = flag(options, 'dry-run');
      requireConfirmation('session:prune', dryRun, flag(options, 'confirm'));
      const handle = await context.project.sessions(await loadConfigOrFail(context));
      try {
        if (dryRun) {
          const expired = await handle.countExpired();
          context.print(`Dry run: ${expired} expired session(s) would be removed (nothing deleted)`);
          return { data: { dryRun: true, expired, removed: 0 } };
        }
        const removed = await handle.prune();
        context.print(`Removed ${removed} expired session(s).`);
        return { data: { dryRun: false, removed } };
      } finally {
        await handle.close();
      }
    },
  }),
];

interface DiskRow {
  readonly name: string;
  readonly driver: string;
  readonly visibility: string;
  readonly root: string;
  readonly publicBaseUrl: string;
  readonly status: string;
}

/** Validates one `storage.disks` entry structurally (mirrors the provider's rules). */
function inspectDisk(context: CommandContext, name: string, entry: unknown, issues: string[]): DiskRow {
  const label = `storage.disks.${name}`;
  const invalid = (message: string): DiskRow => {
    issues.push(`${label}: ${message}`);
    return {
      name,
      driver: entry && typeof entry === 'object' ? String((entry as Record<string, unknown>).driver ?? '?') : '?',
      visibility: '?',
      root: '-',
      publicBaseUrl: '-',
      status: 'invalid',
    };
  };
  if (!entry || typeof entry !== 'object') return invalid('entry is not an object');
  const disk = entry as {
    driver?: unknown;
    root?: unknown;
    visibility?: unknown;
    publicBaseUrl?: unknown;
    options?: unknown;
  };

  const driver = typeof disk.driver === 'string' && disk.driver.length > 0 ? disk.driver : undefined;
  if (!driver) return invalid('driver must be a non-empty string');
  if (disk.visibility !== undefined && disk.visibility !== 'private' && disk.visibility !== 'public') {
    return invalid('visibility must be "private" or "public"');
  }
  const visibility = (disk.visibility as string | undefined) ?? 'private';
  const publicBaseUrl = typeof disk.publicBaseUrl === 'string' ? disk.publicBaseUrl : undefined;
  if (visibility === 'public' && !publicBaseUrl) {
    issues.push(`${label}: public disks must declare publicBaseUrl`);
  }

  if (driver === 'local') {
    if (typeof disk.root !== 'string' || disk.root.length === 0) return invalid('local disks require a root');
    const absoluteRoot = isAbsolute(disk.root) ? disk.root : resolve(context.root, disk.root);
    return {
      name,
      driver,
      visibility,
      root: absoluteRoot,
      publicBaseUrl: publicBaseUrl ?? '-',
      status: localRootStatus(absoluteRoot, (message) => issues.push(`${label}: ${message}`)),
    };
  }
  // Kit-backed drivers: options are storagekit's contract and are validated
  // when the provider creates the disk; the CLI never opens connections.
  return {
    name,
    driver,
    visibility,
    root: '-',
    publicBaseUrl: publicBaseUrl ?? '-',
    status: 'ok (kit driver; options validated by storagekit)',
  };
}

/** Read-only probe: exists and writable, or creatable from a writable ancestor. */
function localRootStatus(absoluteRoot: string, issue: (message: string) => void): string {
  if (existsSync(absoluteRoot)) {
    if (!statSync(absoluteRoot).isDirectory()) {
      issue(`root "${absoluteRoot}" exists but is not a directory`);
      return 'invalid';
    }
    try {
      accessSync(absoluteRoot, constants.W_OK);
      return 'ok';
    } catch {
      issue(`root "${absoluteRoot}" is not writable`);
      return 'unwritable';
    }
  }
  let ancestor = dirname(absoluteRoot);
  for (;;) {
    if (existsSync(ancestor)) {
      try {
        accessSync(ancestor, constants.W_OK);
        return 'ok (root is created on first use)';
      } catch {
        issue(`root "${absoluteRoot}" cannot be created (ancestor "${ancestor}" is not writable)`);
        return 'uncreatable';
      }
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      issue(`root "${absoluteRoot}" cannot be created (no writable ancestor)`);
      return 'uncreatable';
    }
    ancestor = parent;
  }
}
