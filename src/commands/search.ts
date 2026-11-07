import { createConnection, type DatabaseConnection } from '@framework/database';
import {
  createSearchManager,
  MemorySearchEngine,
  PostgresSearchEngine,
  reindexIndex,
  type SearchConfig,
  type SearchEngineFactory,
  type SearchIndexDeclaration,
  searchConfigSchema,
} from '@framework/search';
import { flag } from '../args';
import { type CommandContext, defineCommand } from '../command';
import { failure, unsupported, usageError } from '../errors';
import { table } from '../output';
import { loadConfigOrFail } from './project';

/**
 * The Scout-equivalent commands. They read the `search` configuration section
 * (the storage view `searchConfigSchema` validates) and reuse the package's
 * engine drivers and `reindexIndex` — the CLI never re-implements indexing.
 *
 * Only the `postgres` driver has persistent storage: the `memory` driver lives
 * inside one process, so `search:index`/`search:flush` refuse it instead of
 * silently doing nothing (exit 3, capability-honest).
 */

async function loadSearch(context: CommandContext): Promise<{ config: unknown; settings: SearchConfig }> {
  const config = await loadConfigOrFail(context);
  const parsed = searchConfigSchema.safeParse((config as { search?: unknown }).search ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `search.${issue.path.join('.')}: ${issue.message}`);
    throw failure('CONFIG_INVALID', `Invalid \`search\` configuration (${issues.join('; ')})`);
  }
  return { config, settings: parsed.data };
}

/** Driver registry mirroring `createSearchProvider`, keyed off `search.driver`. */
function enginesFor(
  connection: DatabaseConnection | undefined,
  settings: SearchConfig,
): Record<string, SearchEngineFactory> {
  const engines: Record<string, SearchEngineFactory> = { memory: () => new MemorySearchEngine() };
  if (settings.driver === 'postgres' && connection) {
    engines.postgres = () =>
      new PostgresSearchEngine(connection, { prefix: settings.prefix, language: settings.language });
  }
  return engines;
}

function requirePersistentDriver(command: string, settings: SearchConfig): void {
  if (settings.driver === 'postgres') return;
  throw unsupported(
    `"${command}" needs a persistent search driver (search.driver is "${settings.driver}")`,
    'The memory driver lives inside one process; set search.driver to "postgres" for CLI indexing and flushing.',
  );
}

function openConnection(context: CommandContext, config: unknown): DatabaseConnection {
  return createConnection({ url: context.project.databaseUrl(config), maxConnections: 2, connectTimeoutSeconds: 10 });
}

/** All declared indexes, or the single named one; unknown names are a usage error. */
function selectedIndexes(settings: SearchConfig, name: string | undefined): readonly SearchIndexDeclaration[] {
  if (name === undefined) return settings.indexes;
  const found = settings.indexes.find((declaration) => declaration.name === name);
  if (!found) {
    const known = settings.indexes.map((declaration) => declaration.name).join(', ');
    throw usageError(
      `Unknown search index "${name}"`,
      known.length > 0 ? `Declared indexes: ${known}` : 'No indexes are declared in search.indexes.',
    );
  }
  return [found];
}

export const searchCommands = [
  defineCommand({
    name: 'search:index',
    group: 'search',
    status: 'implemented',
    description: 'Import declared search indexes from their source tables (derived, rebuildable storage)',
    arguments: [{ name: 'index', description: 'Index to import; every declared index when omitted', required: false }],
    options: [{ name: 'dry-run', type: 'boolean', description: 'Count what would be indexed without writing' }],
    requires: ['PostgreSQL connection', 'search.driver: postgres'],
    async run({ positionals, options }, context) {
      const { config, settings } = await loadSearch(context);
      // Validate the user's input before the environment gate so the most
      // specific error wins.
      const declarations = selectedIndexes(settings, positionals[0]);
      if (declarations.length === 0) {
        throw usageError('No search indexes are declared', 'Add entries to search.indexes in the configuration.');
      }
      requirePersistentDriver('search:index', settings);
      const dryRun = flag(options, 'dry-run');
      const connection = openConnection(context, config);
      try {
        const engine = createSearchManager({
          driver: settings.driver,
          engines: enginesFor(connection, settings),
        }).engine();
        const rows: { index: string; source: string; indexed: number; skipped: number }[] = [];
        let indexed = 0;
        let skipped = 0;
        for (const declaration of declarations) {
          const result = await reindexIndex(engine, connection, declaration, { dryRun });
          indexed += result.indexed;
          skipped += result.skipped;
          rows.push({
            index: declaration.name,
            source: declaration.source,
            indexed: result.indexed,
            skipped: result.skipped,
          });
        }
        for (const line of table(rows, ['index', 'source', 'indexed', 'skipped'])) context.print(line);
        context.print(
          dryRun
            ? 'Dry run: nothing was written.'
            : `Imported ${indexed} document(s); skipped ${skipped} soft-deleted row(s).`,
        );
        return { data: { dryRun, indexed, skipped, indexes: rows } };
      } finally {
        await connection.close();
      }
    },
  }),
  defineCommand({
    name: 'search:flush',
    group: 'search',
    status: 'implemented',
    description: 'Flush (truncate) one declared search index',
    arguments: [{ name: 'index', description: 'Index to flush', required: true }],
    options: [{ name: 'dry-run', type: 'boolean', description: 'Preview the operation without truncating' }],
    requires: ['PostgreSQL connection', 'search.driver: postgres'],
    async run({ positionals, options }, context) {
      const { config, settings } = await loadSearch(context);
      const name = positionals[0];
      if (!name) {
        throw usageError(
          'Usage: search:flush <index>',
          'Name one declared index (see search.indexes in the configuration).',
        );
      }
      const [declaration] = selectedIndexes(settings, name);
      if (!declaration) throw usageError('Usage: search:flush <index>');
      requirePersistentDriver('search:flush', settings);
      const dryRun = flag(options, 'dry-run');
      const connection = openConnection(context, config);
      try {
        const engine = createSearchManager({
          driver: settings.driver,
          engines: enginesFor(connection, settings),
        }).engine();
        if (dryRun) {
          context.print(`Dry run: would flush index "${declaration.name}" (nothing truncated)`);
          return { data: { dryRun: true, flushed: false, index: declaration.name } };
        }
        await engine.flush(declaration.name);
        context.print(`Flushed index "${declaration.name}".`);
        return { data: { dryRun: false, flushed: true, index: declaration.name } };
      } finally {
        await connection.close();
      }
    },
  }),
  defineCommand({
    name: 'search:status',
    group: 'search',
    status: 'implemented',
    description: 'Show the configured search driver, its capabilities and declared indexes',
    async run(_input, context) {
      const { config, settings } = await loadSearch(context);
      // The engine is built lazily (the drivers connect on first use), so no
      // live database round-trip happens for a status report.
      const connection = settings.driver === 'postgres' ? openConnection(context, config) : undefined;
      try {
        const engine = createSearchManager({
          driver: settings.driver,
          engines: enginesFor(connection, settings),
        }).engine();
        const capabilities = Object.entries(engine.capabilities)
          .map(([name, supported]) => `${name}=${supported ? 'yes' : 'no'}`)
          .join(' ');
        context.print(`driver:      ${settings.driver} (engine "${engine.name}")`);
        context.print(`indexing:    ${settings.indexing}`);
        context.print(`capabilities: ${capabilities}`);
        for (const line of table(
          settings.indexes.map((declaration) => ({
            index: declaration.name,
            source: declaration.source,
            searchable: declaration.searchable.join(','),
            filterable: declaration.filterable.join(','),
            softDelete: declaration.softDelete ? `yes (${declaration.softDeleteField})` : 'no',
          })),
          ['index', 'source', 'searchable', 'filterable', 'softDelete'],
        ))
          context.print(line);
        return {
          data: {
            driver: settings.driver,
            engine: engine.name,
            indexing: settings.indexing,
            capabilities: engine.capabilities,
            indexes: settings.indexes,
          },
        };
      } finally {
        await connection?.close();
      }
    },
  }),
];
