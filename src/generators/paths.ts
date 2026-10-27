import { isAbsolute, relative, resolve } from 'node:path';
import { usageError } from '../errors';

/** Resolves a project-relative path, rejecting absolute paths and traversal outside the root. */
export function resolveInsideProject(root: string, path: string): string {
  if (isAbsolute(path) || path.includes('\0')) throw usageError(`Path "${path}" must be relative to the project root`);
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw usageError(`Path "${path}" escapes the project root`);
  }
  return target;
}

/** Relative import specifier from one project file to another (no extension). */
export function importPath(fromFile: string, toFile: string): string {
  const fromDir = fromFile.split('/').slice(0, -1).join('/');
  const rel = relative(fromDir || '.', toFile)
    .replace(/\\/g, '/')
    .replace(/\.ts$/, '')
    .replace(/\/index$/, '');
  return rel.startsWith('.') ? rel : `./${rel}`;
}
