import { z } from 'zod/v4';
import { usageError } from '../../errors';
import { columnName, type ResourceNames } from '../naming';

export const FIELD_TYPES = ['text', 'integer', 'numeric', 'boolean', 'uuid', 'timestamp'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Fields the generator manages itself; never accepted as business fields. */
export const RESERVED_FIELDS = ['id', 'createdAt', 'updatedAt', 'deletedAt'] as const;

export const DEFAULT_NUMERIC = { precision: 12, scale: 2 } as const;
const MAX_FIELDS = 50;
const PROPERTY = /^[a-z][a-zA-Z0-9]{0,62}$/;
const INTEGER_LITERAL = /^-?\d{1,9}$/;

export interface FieldDefinition {
  /** camelCase property name. */
  readonly name: string;
  /** snake_case column name. */
  readonly column: string;
  readonly type: FieldType;
  readonly nullable: boolean;
  readonly hasDefault: boolean;
  /** Literal default for generated tables. */
  readonly defaultLiteral?: string | number | boolean;
  readonly precision?: number;
  readonly scale?: number;
}

export type PrimaryKeyType = 'uuid' | 'integer';
export type Access = 'public' | 'authenticated';

export interface ResourceDefinition {
  readonly names: ResourceNames;
  readonly fields: readonly FieldDefinition[];
  readonly primaryKey: PrimaryKeyType;
  /** createdAt/updatedAt string-mode columns are present and public. */
  readonly timestamps: { readonly createdAt: boolean; readonly updatedAt: boolean };
  readonly softDelete: boolean;
  readonly access: Access;
  readonly source: 'new' | 'existing';
  /** Full mount path, e.g. /api/v1/products. */
  readonly mount: string;
  readonly tableExport: string;
  /** Project-relative schema file. */
  readonly schemaFile: string;
}

export const isRequired = (field: FieldDefinition) => !field.nullable && !field.hasDefault;

function decimalPattern(field: FieldDefinition): RegExp {
  const precision = field.precision ?? DEFAULT_NUMERIC.precision;
  const scale = field.scale ?? DEFAULT_NUMERIC.scale;
  const integerDigits = Math.max(1, precision - scale);
  return new RegExp(scale > 0 ? `^-?\\d{1,${integerDigits}}(\\.\\d{1,${scale}})?$` : `^-?\\d{1,${integerDigits}}$`);
}

export function numericRegexSource(field: FieldDefinition): string {
  return decimalPattern(field).source;
}

function parseDefault(field: Omit<FieldDefinition, 'hasDefault' | 'defaultLiteral'>, literal: string) {
  switch (field.type) {
    case 'text':
      if (literal.length === 0 || literal.length > 255)
        throw usageError(`Default for "${field.name}" must be 1-255 chars`);
      return literal;
    case 'integer':
      if (!INTEGER_LITERAL.test(literal)) throw usageError(`Default for "${field.name}" must be an integer`);
      return Number(literal);
    case 'numeric':
      if (!decimalPattern({ ...field, hasDefault: false }).test(literal)) {
        throw usageError(
          `Default for "${field.name}" must be a decimal matching numeric(${DEFAULT_NUMERIC.precision},${DEFAULT_NUMERIC.scale})`,
        );
      }
      return literal;
    case 'boolean':
      if (literal !== 'true' && literal !== 'false')
        throw usageError(`Default for "${field.name}" must be true or false`);
      return literal === 'true';
    default:
      throw usageError(`Literal defaults are not supported for ${field.type} fields ("${field.name}")`);
  }
}

function validateName(name: string): void {
  if (!PROPERTY.test(name)) throw usageError(`Field "${name}" must be a camelCase identifier`);
  if ((RESERVED_FIELDS as readonly string[]).includes(name)) {
    throw usageError(`Field "${name}" is generated automatically and cannot be declared`);
  }
}

function makeField(
  name: string,
  type: string,
  modifier: { nullable: boolean; defaultLiteral?: string },
): FieldDefinition {
  validateName(name);
  if (!(FIELD_TYPES as readonly string[]).includes(type)) {
    throw usageError(`Unsupported type "${type}" for "${name}"`, `Supported types: ${FIELD_TYPES.join(', ')}`);
  }
  const base = {
    name,
    column: columnName(name),
    type: type as FieldType,
    nullable: modifier.nullable,
    ...(type === 'numeric' ? DEFAULT_NUMERIC : {}),
  };
  return modifier.defaultLiteral === undefined
    ? { ...base, hasDefault: false }
    : { ...base, hasDefault: true, defaultLiteral: parseDefault(base, modifier.defaultLiteral) };
}

function assertUnique(fields: readonly FieldDefinition[]): readonly FieldDefinition[] {
  if (fields.length === 0) throw usageError('At least one field is required');
  if (fields.length > MAX_FIELDS) throw usageError(`At most ${MAX_FIELDS} fields are supported`);
  const seen = new Set<string>();
  for (const field of fields) {
    if (seen.has(field.column)) throw usageError(`Field "${field.name}" is declared twice`);
    seen.add(field.column);
  }
  return fields;
}

/** Compact syntax: `<name>:<type>:required|nullable|default=<literal>`, comma separated. */
export function parseFieldSpec(spec: string): readonly FieldDefinition[] {
  const fields = spec
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [name = '', type = '', modifier, ...extra] = part.split(':');
      if (!modifier || extra.length > 0) {
        throw usageError(
          `Invalid field "${part}"`,
          'Use <name>:<type>:required|nullable|default=<literal>, e.g. name:text:required',
        );
      }
      if (modifier === 'required') return makeField(name, type, { nullable: false });
      if (modifier === 'nullable') return makeField(name, type, { nullable: true });
      if (modifier.startsWith('default=')) {
        return makeField(name, type, { nullable: false, defaultLiteral: modifier.slice('default='.length) });
      }
      throw usageError(`Unknown modifier "${modifier}" in "${part}"`);
    });
  return assertUnique(fields);
}

const definitionFileSchema = z
  .object({
    access: z.enum(['public', 'authenticated']),
    softDelete: z.boolean().default(false),
    fields: z
      .array(
        z
          .object({
            name: z.string(),
            type: z.enum(FIELD_TYPES),
            nullable: z.boolean().default(false),
            default: z.union([z.string(), z.number(), z.boolean()]).optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export interface ParsedDefinitionFile {
  readonly access: Access;
  readonly softDelete: boolean;
  readonly fields: readonly FieldDefinition[];
}

/** Typed JSON resource definition. Unknown keys (unsupported features) are rejected, not ignored. */
export function parseDefinitionFile(json: unknown): ParsedDefinitionFile {
  const result = definitionFileSchema.safeParse(json);
  if (!result.success) {
    throw usageError(
      `Invalid resource definition: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  const fields = result.data.fields.map((field) =>
    makeField(field.name, field.type, {
      nullable: field.nullable,
      defaultLiteral: field.default === undefined ? undefined : String(field.default),
    }),
  );
  return { access: result.data.access, softDelete: result.data.softDelete, fields: assertUnique(fields) };
}
