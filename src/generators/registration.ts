import { failure } from '../errors';

interface ImportEntry {
  readonly start: number;
  readonly end: number;
  readonly specifier: string;
}

/** Module specifier of an import statement (`from '…'`, or a bare `import '…'`). */
function moduleSpecifier(statement: string): string {
  const from = statement.match(/\bfrom\s*['"]([^'"]+)['"]/);
  if (from?.[1] !== undefined) return from[1];
  const bare = statement.match(/^import\s*['"]([^'"]+)['"]/);
  return bare?.[1] ?? '';
}

/**
 * The first contiguous run of top-level import statements. Biome's
 * `organizeImports` sorts within such a run (a blank line starts a new group),
 * so inserting into this block keeps the file ordered.
 */
function firstImportBlock(lines: readonly string[]): ImportEntry[] {
  const entries: ImportEntry[] = [];
  let index = 0;
  while (index < lines.length && (lines[index] as string).trim() === '') index++;
  while (index < lines.length) {
    const line = lines[index] as string;
    if (line.trim() === '' || !/^import\b/.test(line)) break;
    const start = index;
    while (!/;\s*$/.test(lines[index] as string) && index + 1 < lines.length) index++;
    entries.push({ start, end: index, specifier: moduleSpecifier(lines.slice(start, index + 1).join('\n')) });
    index++;
  }
  return entries;
}

/**
 * Biome `organizeImports` grouping: built-in / protocol / non-lowercase
 * specifiers first, then bare packages, then relative paths. Mirrors the pinned
 * Biome so `addImport` output needs no post-generation formatter pass.
 */
function importGroup(specifier: string): number {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return 2;
  return /^[@a-z0-9\-_./~]+$/.test(specifier) ? 1 : 0;
}

/** Digit-aware comparison (`a1` < `a2` < `a10`), matching Biome's natural order. */
function naturalCompare(a: string, b: string): number {
  const partsA = a.match(/\d+|\D+/g) ?? [];
  const partsB = b.match(/\d+|\D+/g) ?? [];
  const shared = Math.min(partsA.length, partsB.length);
  for (let i = 0; i < shared; i++) {
    const left = partsA[i] as string;
    const right = partsB[i] as string;
    if (left === right) continue;
    if (/^\d/.test(left) && /^\d/.test(right)) {
      const diff = Number(left) - Number(right);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    }
    return left < right ? -1 : 1;
  }
  return partsA.length - partsB.length;
}

/** Orders two module specifiers exactly as Biome's `organizeImports` does. */
export function compareImportSpecifiers(a: string, b: string): number {
  const groupA = importGroup(a);
  const groupB = importGroup(b);
  if (groupA !== groupB) return groupA - groupB;
  return naturalCompare(a, b);
}

/**
 * Adds an import statement into the top-level import block, **at the position
 * Biome's `organizeImports` would place it** (syntax-aware: multi-line imports
 * are respected). Idempotent for identical statements. Inserting already-sorted
 * keeps generated files lint-clean without a formatter pass.
 */
export function addImport(source: string, statement: string): string {
  if (source.includes(statement)) return source;
  const lines = source.split('\n');
  const block = firstImportBlock(lines);
  const specifier = moduleSpecifier(statement);

  let insertAt = -1;
  for (const entry of block) {
    if (compareImportSpecifiers(specifier, entry.specifier) < 0) {
      insertAt = entry.start;
      break;
    }
  }
  if (insertAt === -1) {
    const last = block.at(-1);
    insertAt = last ? last.end + 1 : 0;
  }
  lines.splice(insertAt, 0, statement);
  return lines.join('\n');
}

/**
 * Inserts `line` directly after the explicit registration marker
 * `// <marker>`, keeping the marker's indentation. Missing markers and
 * duplicate registrations are errors, never silent text insertion.
 */
export function insertAfterMarker(source: string, marker: string, line: string, file: string): string {
  const lines = source.split('\n');
  const index = lines.findIndex((l) => l.trim() === `// ${marker}`);
  if (index === -1) {
    throw failure(
      'REGISTRATION_MARKER_MISSING',
      `Marker "// ${marker}" not found in ${file}`,
      'Restore the marker comment so generators can register modules explicitly.',
    );
  }
  if (lines.some((l) => l.trim() === line.trim())) {
    throw failure('ALREADY_REGISTERED', `${file} already contains: ${line.trim()}`);
  }
  const indentation = (lines[index] as string).match(/^\s*/)?.[0] ?? '';
  lines.splice(index + 1, 0, `${indentation}${line.trim()}`);
  return lines.join('\n');
}
