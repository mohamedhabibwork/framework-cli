import { redact } from '@framework/core';

export type ResultStatus = 'ok' | 'error';

export interface JsonEnvelope {
  readonly command: string;
  readonly status: ResultStatus;
  readonly data: unknown;
  readonly warnings: readonly string[];
  readonly error?: { readonly code: string; readonly message: string };
}

/** Stable machine-readable result; always redacted. */
export function envelope(
  command: string,
  status: ResultStatus,
  data: unknown,
  warnings: readonly string[] = [],
  error?: { code: string; message: string },
): string {
  const body: JsonEnvelope = { command, status, data: redact(data ?? null), warnings, ...(error ? { error } : {}) };
  return JSON.stringify(body, null, 2);
}

/** Left-aligned text table for human output. */
export function table(rows: readonly Record<string, string | number>[], columns: readonly string[]): string[] {
  if (rows.length === 0) return ['(none)'];
  const widths = columns.map((column) =>
    Math.max(column.length, ...rows.map((row) => String(row[column] ?? '').length)),
  );
  const line = (values: readonly string[]) =>
    values
      .map((value, i) => value.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [
    line(columns.map((c) => c.toUpperCase())),
    ...rows.map((row) => line(columns.map((column) => String(row[column] ?? '')))),
  ];
}
