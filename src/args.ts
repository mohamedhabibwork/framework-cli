import { usageError } from './errors';

export interface OptionSpec {
  readonly name: string;
  readonly type: 'string' | 'boolean';
  readonly description: string;
  readonly short?: string;
  /** Allowed values for string options. */
  readonly values?: readonly string[];
  readonly placeholder?: string;
}

export type OptionValues = Readonly<Record<string, string | boolean | undefined>>;

export interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly options: OptionValues;
}

export const GLOBAL_OPTIONS: readonly OptionSpec[] = [
  { name: 'help', short: 'h', type: 'boolean', description: 'Show usage, arguments, options and examples' },
  { name: 'version', short: 'V', type: 'boolean', description: 'Show CLI and framework versions' },
  { name: 'cwd', type: 'string', placeholder: '<path>', description: 'Explicit project root' },
  { name: 'env-file', type: 'string', placeholder: '<path>', description: 'Explicit environment file' },
  { name: 'json', type: 'boolean', description: 'Machine-readable output on stdout; diagnostics on stderr' },
  { name: 'no-interaction', type: 'boolean', description: 'Disable prompts; fail when input is missing' },
  { name: 'verbose', type: 'boolean', description: 'Additional diagnostics (secrets redacted)' },
];

function findSpec(specs: readonly OptionSpec[], token: string): OptionSpec | undefined {
  if (token.startsWith('--')) return specs.find((spec) => spec.name === token.slice(2));
  return specs.find((spec) => spec.short !== undefined && `-${spec.short}` === token);
}

/**
 * Parses argv against option specs. Supports `--name value`, `--name=value`,
 * short boolean flags and `--` to end option parsing. Unknown options,
 * missing values and values outside `values` are usage errors (exit 2).
 */
export function parseArgs(argv: readonly string[], specs: readonly OptionSpec[]): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index] as string;
    if (token === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith('-') || token === '-') {
      positionals.push(token);
      continue;
    }
    const [flag, inline] = token.includes('=')
      ? [token.slice(0, token.indexOf('=')), token.slice(token.indexOf('=') + 1)]
      : [token, undefined];
    const spec = findSpec(specs, flag as string);
    if (!spec) throw usageError(`Unknown option "${flag}"`, 'Run with --help to see supported options');
    if (spec.name in options) throw usageError(`Option "--${spec.name}" was given more than once`);

    if (spec.type === 'boolean') {
      if (inline !== undefined) throw usageError(`Option "--${spec.name}" does not take a value`);
      options[spec.name] = true;
      continue;
    }
    const value = inline ?? argv[++index];
    if (value === undefined || (inline === undefined && value.startsWith('--'))) {
      throw usageError(`Option "--${spec.name}" requires a value`);
    }
    if (spec.values && !spec.values.includes(value)) {
      throw usageError(`Option "--${spec.name}" must be one of: ${spec.values.join(', ')}`);
    }
    options[spec.name] = value;
  }
  return { positionals, options };
}

/** Locates the command name: the first positional not consumed by a global string option. */
export function splitCommand(argv: readonly string[]): { command: string | undefined; rest: string[] } {
  const tokens = argv[0] === '--' ? argv.slice(1) : [...argv];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] as string;
    if (token.startsWith('-')) {
      const spec = findSpec(GLOBAL_OPTIONS, token);
      if (spec?.type === 'string' && !token.includes('=')) index++;
      continue;
    }
    return { command: token, rest: [...tokens.slice(0, index), ...tokens.slice(index + 1)] };
  }
  return { command: undefined, rest: tokens };
}

export function stringOption(options: OptionValues, name: string): string | undefined {
  const value = options[name];
  return typeof value === 'string' ? value : undefined;
}

export function flag(options: OptionValues, name: string): boolean {
  return options[name] === true;
}
