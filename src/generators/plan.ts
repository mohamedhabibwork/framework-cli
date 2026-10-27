import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { failure, usageError } from '../errors';
import { resolveInsideProject } from './paths';

export interface Prerequisite {
  /** Project-relative file that must exist. */
  readonly path: string;
  /** The command that creates it, shown in the error. */
  readonly command: string;
}

/** Fails with one actionable list when referenced artifacts are missing. */
export async function assertPrerequisites(root: string, required: readonly Prerequisite[]): Promise<void> {
  const missing: string[] = [];
  for (const entry of required) {
    if (!(await Bun.file(resolveInsideProject(root, entry.path)).exists())) {
      missing.push(`${entry.path} (run ${entry.command})`);
    }
  }
  if (missing.length > 0) {
    throw usageError(`Missing referenced files: ${missing.join(', ')}`);
  }
}

export type ChangeAction = 'create' | 'update' | 'overwrite';

export interface FileChange {
  /** Project-relative path. */
  readonly path: string;
  readonly action: ChangeAction;
  readonly content: string;
  readonly previous?: string;
}

export interface NewFile {
  readonly path: string;
  readonly content: string;
}

export interface FileUpdate {
  readonly path: string;
  readonly transform: (previous: string) => string;
}

export interface AppliedPlan {
  /** Restores updated files and removes created ones. */
  rollback(): Promise<void>;
}

/**
 * Computes every change up front. Existing files are conflicts unless
 * `force` is set, in which case only these generator-owned paths are
 * overwritten (and listed as such). Nothing is written here.
 */
export async function buildChanges(
  root: string,
  files: readonly NewFile[],
  updates: readonly FileUpdate[],
  force: boolean,
): Promise<FileChange[]> {
  const changes: FileChange[] = [];
  const conflicts: string[] = [];
  for (const file of files) {
    const handle = Bun.file(resolveInsideProject(root, file.path));
    if (await handle.exists()) {
      if (!force) conflicts.push(file.path);
      else changes.push({ path: file.path, action: 'overwrite', content: file.content, previous: await handle.text() });
    } else {
      changes.push({ path: file.path, action: 'create', content: file.content });
    }
  }
  if (conflicts.length > 0) {
    throw usageError(
      `Refusing to overwrite existing files: ${conflicts.join(', ')}`,
      'Review them, then re-run with --force to replace generator-owned files only.',
    );
  }
  for (const update of updates) {
    const handle = Bun.file(resolveInsideProject(root, update.path));
    if (!(await handle.exists()))
      throw failure('REGISTRATION_TARGET_MISSING', `Expected file ${update.path} does not exist`);
    const previous = await handle.text();
    const content = update.transform(previous);
    if (content !== previous) changes.push({ path: update.path, action: 'update', content, previous });
  }
  return changes;
}

export function describeChanges(changes: readonly FileChange[]): string[] {
  return changes.map((change) => `  ${change.action.padEnd(9)} ${change.path}`);
}

/**
 * Staged application: every file is first written to a temporary sibling,
 * then all are renamed into place. Any failure restores the previous state.
 */
export async function applyChanges(root: string, changes: readonly FileChange[]): Promise<AppliedPlan> {
  const suffix = `.fw-${randomBytes(4).toString('hex')}.tmp`;
  const staged: string[] = [];
  const applied: FileChange[] = [];

  const createdDirs: string[] = [];

  /** Best-effort per file; reports exactly what could not be restored. */
  const rollback = async () => {
    const unrestored: string[] = [];
    for (const change of [...applied].reverse()) {
      const target = resolveInsideProject(root, change.path);
      try {
        if (change.previous === undefined) await rm(target, { force: true });
        else await Bun.write(target, change.previous);
      } catch {
        unrestored.push(change.path);
      }
    }
    applied.length = 0;
    for (const dir of createdDirs.reverse()) await rm(dir, { recursive: false }).catch(() => undefined);
    if (unrestored.length > 0) {
      throw failure('PLAN_ROLLBACK_INCOMPLETE', `Could not restore: ${unrestored.join(', ')}`);
    }
  };

  try {
    for (const change of changes) {
      const target = resolveInsideProject(root, change.path);
      const created = await mkdir(dirname(target), { recursive: true });
      if (created) createdDirs.push(created);
      await Bun.write(target + suffix, change.content);
      staged.push(target + suffix);
    }
    for (const change of changes) {
      const target = resolveInsideProject(root, change.path);
      await rename(target + suffix, target);
      applied.push(change);
    }
  } catch (error) {
    await Promise.all(staged.map((file) => rm(file, { force: true })));
    try {
      await rollback();
    } catch (rollbackError) {
      throw failure('PLAN_ROLLBACK_INCOMPLETE', (rollbackError as Error).message, undefined, error);
    }
    throw failure(
      'PLAN_APPLY_FAILED',
      'Could not write generated files; all changes were rolled back',
      undefined,
      error,
    );
  }
  return { rollback };
}
