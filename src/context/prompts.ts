import type { PromptAnswer, PromptSession } from '@framework/prompts';
import { createPromptSession, createRenderer, PromptError } from '@framework/prompts';
import { CliError, EXIT } from '../errors';

/** Inputs the CLI provides to build a `PromptSession` for one invocation. */
export interface PromptSessionConfig {
  /** True only when the CLI may read the TTY (`--no-interaction`/`--json` force false). */
  readonly interactive: boolean;
  /** Injected answers keyed by prompt message (tests, `--answers`, scripted runs). */
  readonly answers?: Readonly<Record<string, PromptAnswer>>;
}

/**
 * Adapts a CLI invocation into a `@framework/prompts` session. The dependency
 * runs one way only — `@framework/cli` depends on `@framework/prompts`, never
 * the reverse (design §8.12, assumption A6) — so this adapter is the seam.
 */
export function createCliPromptSession(config: PromptSessionConfig): PromptSession {
  const renderer = createRenderer({ interactive: config.interactive });
  return createPromptSession({ renderer, answers: config.answers });
}

/**
 * Maps a `@framework/prompts` failure onto the CLI exit-code contract, if the
 * error is one. Returns `undefined` for unrelated errors so the caller can keep
 * its existing handling. Reuses `EXIT.USAGE` (2) and `EXIT.INTERRUPTED` (130).
 */
export function mapPromptError(error: unknown): CliError | undefined {
  if (!(error instanceof PromptError)) return undefined;
  const exitCode = error.exitCode === EXIT.INTERRUPTED ? EXIT.INTERRUPTED : EXIT.USAGE;
  return new CliError(exitCode, error.code, error.message);
}
