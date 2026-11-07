/** Exit codes from the CLI execution contract. */
export const EXIT = {
  OK: 0,
  FAILURE: 1,
  USAGE: 2,
  UNSUPPORTED: 3,
  INTERRUPTED: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** Failure with a safe code/message; `hint` is extra guidance for humans. */
export class CliError extends Error {
  constructor(
    readonly exitCode: ExitCode,
    readonly code: string,
    message: string,
    readonly hint?: string,
    options?: { cause?: unknown; data?: unknown },
  ) {
    super(message, options);
    this.name = 'CliError';
    this.data = options?.data;
  }

  /** Partial results still reported on failure (e.g. generation succeeded, verification failed). */
  readonly data: unknown;
}

export const usageError = (message: string, hint?: string) => new CliError(EXIT.USAGE, 'INVALID_USAGE', message, hint);

export const unsupported = (message: string, hint?: string) =>
  new CliError(EXIT.UNSUPPORTED, 'UNSUPPORTED_CAPABILITY', message, hint);

export const failure = (code: string, message: string, hint?: string, cause?: unknown) =>
  new CliError(EXIT.FAILURE, code, message, hint, { cause });

export const interrupted = () => new CliError(EXIT.INTERRUPTED, 'INTERRUPTED', 'Interrupted');
