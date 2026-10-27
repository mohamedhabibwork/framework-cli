import { flag, type OptionSpec, type OptionValues } from '../args';
import type { CommandContext, CommandResult } from '../command';
import { usageError } from '../errors';
import { toCamel, toKebab, toPascal } from '../generators/naming';
import { applyChanges, buildChanges, describeChanges, type FileUpdate, type NewFile } from '../generators/plan';

/** Name must be a valid identifier in any of the generated casings. */
export function names(raw: string | undefined, what: string): { readonly pascal: string; readonly kebab: string } {
  if (!raw || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(raw)) {
    throw usageError(`${what} name must be a valid identifier (e.g. OrderPaid, welcome-email)`);
  }
  const words = raw
    .replaceAll('_', '-')
    .split('-')
    .flatMap((part) => part.split(/(?=[A-Z])/));
  return { pascal: toPascal(words), kebab: toKebab(words) };
}

/** camelCase variable from a kebab/pascal name (orderPaid, welcomeEmailJob). */
export const camelVar = (kebab: string, suffix = ''): string => toCamel(kebab.split('-')) + suffix;

/** Shared pipeline: plan → review changes → write (or print with --dry-run). */
export async function generate(
  context: CommandContext,
  options: OptionValues,
  files: readonly NewFile[],
  updates: readonly FileUpdate[] = [],
): Promise<CommandResult> {
  const changes = await buildChanges(context.root, files, updates, flag(options, 'force'));
  const described = describeChanges(changes);
  if (flag(options, 'dry-run')) {
    for (const line of described) context.print(line);
    return { data: { changes: described, dryRun: true } };
  }
  await applyChanges(context.root, changes);
  for (const line of described) context.print(line);
  return { data: { changes: described } };
}

export const COMMON_OPTIONS: readonly OptionSpec[] = [
  { name: 'force', type: 'boolean', description: 'Overwrite generator-owned files' },
  { name: 'dry-run', type: 'boolean', description: 'Print the planned changes without writing' },
];
