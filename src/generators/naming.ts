import { usageError } from '../errors';

const PASCAL = /^[A-Z][A-Za-z0-9]{0,62}$/;
const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const SNAKE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

export interface ResourceNames {
  /** Product */
  readonly pascal: string;
  /** product */
  readonly camel: string;
  /** product (file names) */
  readonly kebab: string;
  /** PRODUCT (token constants) */
  readonly constant: string;
  /** Products */
  readonly pluralPascal: string;
  /** products */
  readonly pluralCamel: string;
  /** products */
  readonly pluralKebab: string;
  /** products (SQL table, snake_case plural) */
  readonly table: string;
  /** products (module directory, kebab-case) */
  readonly module: string;
}

export function splitWords(pascal: string): string[] {
  return pascal.match(/[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[0-9]+/g) ?? [pascal];
}

/** English pluralization for identifiers; irregular nouns need an explicit --module/--table. */
export function pluralize(word: string): string {
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  return `${word}s`;
}

export const toCamel = (words: readonly string[]) =>
  words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0]?.toUpperCase() + w.slice(1).toLowerCase())).join('');
export const toKebab = (words: readonly string[]) => words.map((w) => w.toLowerCase()).join('-');
export const toSnake = (words: readonly string[]) => words.map((w) => w.toLowerCase()).join('_');
export const toPascal = (words: readonly string[]) =>
  words.map((w) => w[0]?.toUpperCase() + w.slice(1).toLowerCase()).join('');

/** camelCase property -> snake_case column. */
export function columnName(property: string): string {
  return property.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

export function resourceNames(resource: string, options: { module?: string; table?: string } = {}): ResourceNames {
  if (!PASCAL.test(resource)) {
    throw usageError(`Resource name "${resource}" must be PascalCase (e.g. Product, OrderItem)`);
  }
  const words = splitWords(resource);
  const pluralWords = [...words.slice(0, -1), pluralize(words.at(-1) as string)];
  const module = options.module ?? toKebab(pluralWords);
  if (!KEBAB.test(module)) throw usageError(`Module name "${module}" must be kebab-case (e.g. order-items)`);
  const table = options.table ?? toSnake(pluralWords);
  if (!SNAKE.test(table)) throw usageError(`Table name "${table}" must be snake_case`);
  return {
    pascal: toPascal(words),
    camel: toCamel(words),
    kebab: toKebab(words),
    constant: toSnake(words).toUpperCase(),
    pluralPascal: toPascal(pluralWords),
    pluralCamel: toCamel(pluralWords),
    pluralKebab: toKebab(pluralWords),
    table,
    module,
  };
}
