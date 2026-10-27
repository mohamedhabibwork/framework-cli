import { pathToFileURL } from 'node:url';
import { type Column, getTableColumns, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { unsupported, usageError } from '../../errors';
import { resolveInsideProject } from '../paths';
import { type FieldDefinition, type FieldType, type PrimaryKeyType, RESERVED_FIELDS } from './definition';

const COLUMN_TYPES: Readonly<Record<string, FieldType>> = {
  PgText: 'text',
  PgVarchar: 'text',
  PgInteger: 'integer',
  PgNumeric: 'numeric',
  PgBoolean: 'boolean',
  PgUUID: 'uuid',
  PgTimestampString: 'timestamp',
};

export interface IntrospectedTable {
  readonly fields: readonly FieldDefinition[];
  readonly primaryKey: PrimaryKeyType;
  readonly timestamps: { readonly createdAt: boolean; readonly updatedAt: boolean };
  readonly hasDeletedAt: boolean;
}

function assertStringTimestamp(property: string, column: Column): void {
  if (column.columnType !== 'PgTimestampString') {
    throw unsupported(
      `Column "${property}" must be a timestamp with mode: 'string' to be exposed through JSON`,
      "Change it to timestamp(..., { withTimezone: true, mode: 'string' }) and generate a migration.",
    );
  }
}

/**
 * Loads the canonical schema module and reads the table export's column
 * metadata. Unsupported column types are rejected rather than guessed.
 */
export async function introspectTable(
  root: string,
  schemaFile: string,
  exportName: string,
): Promise<IntrospectedTable> {
  const module = (await import(pathToFileURL(resolveInsideProject(root, schemaFile)).href)) as Record<string, unknown>;
  const table = module[exportName];
  if (!is(table, PgTable)) {
    throw usageError(
      `"${exportName}" is not a Drizzle pg table exported from ${schemaFile}`,
      'Use --schema-file to point at the right module.',
    );
  }
  const columns = getTableColumns(table) as Record<string, Column>;
  const id = columns.id;
  if (!id?.primary) {
    throw unsupported(
      `Table "${exportName}" needs a single-column primary key property named "id"`,
      'Composite or renamed keys require --primary-key (planned).',
    );
  }
  const primaryKey: PrimaryKeyType | undefined =
    id.columnType === 'PgUUID'
      ? 'uuid'
      : id.columnType === 'PgInteger' || id.columnType === 'PgSerial'
        ? 'integer'
        : undefined;
  if (!primaryKey)
    throw unsupported(`Primary key type ${id.columnType} is not supported (use uuid, integer or serial)`);

  for (const property of ['createdAt', 'updatedAt', 'deletedAt'] as const) {
    const column = columns[property];
    if (column) assertStringTimestamp(property, column);
  }

  const fields = Object.entries(columns)
    .filter(([property]) => !(RESERVED_FIELDS as readonly string[]).includes(property))
    .map(([property, column]): FieldDefinition => {
      const type = COLUMN_TYPES[column.columnType];
      if (!type) {
        throw unsupported(
          `Column "${property}" has unsupported type ${column.columnType}`,
          'Use --definition or extend the generator.',
        );
      }
      const numeric = column as Column & { precision?: number; scale?: number };
      return {
        name: property,
        column: column.name,
        type,
        nullable: !column.notNull,
        hasDefault: column.hasDefault,
        ...(type === 'numeric' ? { precision: numeric.precision ?? 12, scale: numeric.scale ?? 2 } : {}),
      };
    });
  if (fields.length === 0) throw usageError(`Table "${exportName}" has no writable business columns`);

  return {
    fields,
    primaryKey,
    timestamps: { createdAt: Boolean(columns.createdAt), updatedAt: Boolean(columns.updatedAt) },
    hasDeletedAt: Boolean(columns.deletedAt),
  };
}
