import type { ResourceDefinition } from '../crud/definition';
import type { CrudFiles } from '../crud/files';
import { importPath } from '../paths';

/**
 * Thin model: metadata and serialization derived from the Drizzle table.
 * It declares no column of its own, so the table stays the only schema source.
 */
export function renderModel(def: ResourceDefinition, files: CrudFiles): string {
  const { pascal } = def.names;
  const table = def.tableExport;
  return [
    "import type { SelectOf } from '@framework/database';",
    "import { getTableColumns, getTableName } from 'drizzle-orm';",
    `import { ${table} } from '${importPath(files.model, def.schemaFile)}';`,
    '',
    `export type ${pascal}Record = SelectOf<typeof ${table}>;`,
    '',
    `const columns = Object.keys(getTableColumns(${table})) as readonly (keyof ${pascal}Record & string)[];`,
    '',
    '/** Model metadata derived from the table; adding a column needs no change here. */',
    `export const ${pascal}Model = {`,
    `  name: '${pascal}',`,
    `  table: getTableName(${table}),`,
    "  primaryKey: 'id',",
    `  softDelete: ${def.softDelete},`,
    '  columns,',
    '  /** JSON-safe copy of a row: Date values become ISO-8601 strings, everything else is kept. */',
    `  serialize(row: ${pascal}Record): Record<string, unknown> {`,
    '    return Object.fromEntries(',
    '      columns.map((column) => {',
    '        const value: unknown = row[column];',
    '        return [column, value instanceof Date ? value.toISOString() : value];',
    '      }),',
    '    );',
    '  },',
    '} as const;',
    '',
  ].join('\n');
}
