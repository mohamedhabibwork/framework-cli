import { importPath } from '../paths';
import { DEFAULT_NUMERIC, type FieldDefinition, numericRegexSource, type ResourceDefinition } from './definition';
import type { CrudFiles } from './files';

const BUILDER: Readonly<Record<FieldDefinition['type'], string>> = {
  text: 'text',
  integer: 'integer',
  numeric: 'numeric',
  boolean: 'boolean',
  uuid: 'uuid',
  timestamp: 'timestamp',
};

/** JSON string literals are valid TS and escape newlines, U+2028 and quotes. */
const quote = (value: string) => JSON.stringify(value);

function literal(field: FieldDefinition): string {
  const value = field.defaultLiteral;
  if (typeof value === 'string') return quote(value);
  return String(value);
}

function columnBuilder(field: FieldDefinition): string {
  const name = quote(field.column);
  let builder: string;
  switch (field.type) {
    case 'numeric':
      builder = `numeric(${name}, { precision: ${field.precision ?? DEFAULT_NUMERIC.precision}, scale: ${field.scale ?? DEFAULT_NUMERIC.scale} })`;
      break;
    case 'timestamp':
      builder = `timestamp(${name}, { withTimezone: true, mode: 'string' })`;
      break;
    default:
      builder = `${BUILDER[field.type]}(${name})`;
  }
  if (!field.nullable) builder += '.notNull()';
  if (field.defaultLiteral !== undefined) builder += `.default(${literal(field)})`;
  return builder;
}

/** Canonical Drizzle table for a new resource (string-mode timestamps, uuid key). */
export function renderTable(def: ResourceDefinition): string {
  const builders = new Set(['pgTable', 'timestamp', 'uuid', ...def.fields.map((f) => BUILDER[f.type])]);
  const columns = [
    `  id: uuid('id').primaryKey().defaultRandom(),`,
    ...def.fields.map((field) => `  ${field.name}: ${columnBuilder(field)},`),
    `  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),`,
    `  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })`,
    '    .notNull()',
    '    .defaultNow()',
    '    .$onUpdate(() => new Date().toISOString()),',
    ...(def.softDelete ? [`  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),`] : []),
  ];
  return [
    `import { ${[...builders].sort().join(', ')} } from 'drizzle-orm/pg-core';`,
    '',
    `/** Canonical persistence shape for ${def.names.pluralCamel}. Validators and DTOs derive from this table. */`,
    `export const ${def.tableExport} = pgTable('${def.names.table}', {`,
    ...columns,
    '});',
    '',
  ].join('\n');
}

const decimalConstant = (field: FieldDefinition) => `${field.column.toUpperCase()}_DECIMAL`;

function refinementLines(def: ResourceDefinition): string[] {
  return def.fields.flatMap((field) => {
    switch (field.type) {
      case 'text':
        return [`  ${field.name}: (field) => field.trim().min(1).max(255),`];
      case 'numeric':
        return [
          `  ${field.name}: (field) => field.regex(${decimalConstant(field)}, 'Must be a decimal within numeric(${field.precision},${field.scale})'),`,
        ];
      case 'timestamp':
        return [`  ${field.name}: () => z.iso.datetime({ offset: true }),`];
      default:
        return [];
    }
  });
}

function schemaCall(factory: string, def: ResourceDefinition, refinements: readonly string[]): string {
  return refinements.length === 0
    ? `${factory}(${def.tableExport})`
    : [`${factory}(${def.tableExport}, {`, ...refinements, '})'].join('\n');
}

/** Drizzle-derived form/response schemas with explicit writable and public allowlists. */
export function renderSchemas(def: ResourceDefinition, files: CrudFiles): string {
  const { names } = def;
  const refinements = refinementLines(def);
  const writable = def.fields.map((f) => `${f.name}: true`).join(', ');
  const publicFields = [
    'id: true',
    ...def.fields.map((f) => `${f.name}: true`),
    ...(def.timestamps.createdAt ? ['createdAt: true'] : []),
    ...(def.timestamps.updatedAt ? ['updatedAt: true'] : []),
  ].join(', ');
  const select = `${names.camel}SelectSchema`;
  const idParam =
    def.primaryKey === 'uuid'
      ? `z.object({ id: ${select}.shape.id })`
      : `z.object({ id: z.coerce.number().pipe(${select}.shape.id) })`;

  return [
    "import { createInsertSchema, createSelectSchema, createUpdateSchema, paginationQuerySchema } from '@framework/database';",
    "import { z } from 'zod/v4';",
    `import { ${def.tableExport} } from '${importPath(files.schemas, def.schemaFile)}';`,
    '',
    ...def.fields
      .filter((f) => f.type === 'numeric')
      .map((f) => `const ${decimalConstant(f)} = /${numericRegexSource(f)}/;`),
    `const ${select} = createSelectSchema(${def.tableExport});`,
    '',
    `/** Writable allowlist. id, timestamps and other generated columns are never client-writable. */`,
    `export const create${names.pascal}Schema = ${schemaCall('createInsertSchema', def, refinements)}`,
    `  .pick({ ${writable} })`,
    '  .strict();',
    '',
    `export const update${names.pascal}Schema = ${schemaCall('createUpdateSchema', def, refinements)}`,
    `  .pick({ ${writable} })`,
    '  .strict()',
    "  .refine((value) => Object.keys(value).length > 0, { message: 'At least one writable field is required' });",
    '',
    '/** Public allowlist for responses. */',
    `export const ${names.camel}ResponseSchema = ${select}.pick({ ${publicFields} });`,
    '',
    '/** Primary-key parameter derived from the select schema with explicit string-to-key parsing. */',
    `export const ${names.camel}IdParamSchema = ${idParam};`,
    '',
    '/** Listing accepts only pagination; unknown query keys are rejected. */',
    `export const list${names.pluralPascal}QuerySchema = paginationQuerySchema().strict();`,
    '',
  ].join('\n');
}

export function renderDto(def: ResourceDefinition, files: CrudFiles): string {
  const { pascal, camel, pluralPascal } = def.names;
  return [
    "import type { Page } from '@framework/database';",
    "import type { z } from 'zod/v4';",
    'import type {',
    `  create${pascal}Schema,`,
    `  list${pluralPascal}QuerySchema,`,
    `  ${camel}ResponseSchema,`,
    `  update${pascal}Schema,`,
    `} from '${importPath(files.dto, files.schemas)}';`,
    '',
    `export type Create${pascal}Input = z.input<typeof create${pascal}Schema>;`,
    `export type Create${pascal}Dto = z.output<typeof create${pascal}Schema>;`,
    `export type Update${pascal}Input = z.input<typeof update${pascal}Schema>;`,
    `export type Update${pascal}Dto = z.output<typeof update${pascal}Schema>;`,
    `export type List${pluralPascal}Dto = z.output<typeof list${pluralPascal}QuerySchema>;`,
    `export type ${pascal}ResponseDto = z.output<typeof ${camel}ResponseSchema>;`,
    `export type ${pascal}PageDto = Page<${pascal}ResponseDto>;`,
    '',
  ].join('\n');
}
