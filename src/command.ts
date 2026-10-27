import type { PromptSession } from '@framework/prompts';
import type { OptionSpec, OptionValues } from './args';
import type { ProjectAdapter } from './project';
import type { CommandRegistry } from './registry';

export type CommandGroup =
  | 'project'
  | 'generators'
  | 'database'
  | 'queue'
  | 'workflow'
  | 'scheduler'
  | 'cache'
  | 'storage'
  | 'openapi'
  | 'tooling'
  // Application-defined commands (make:command).
  | 'app'
  // First-party package equivalents (E-series): Passport, Scout, Telescope, Socialite.
  | 'oauth'
  | 'search'
  | 'observatory'
  | 'socialite';

/** Release classification required by the specification. */
export type CommandStatus = 'planned' | 'implemented' | 'validated';

export interface ArgumentSpec {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
}

export interface CommandContext {
  readonly root: string;
  readonly json: boolean;
  readonly interactive: boolean;
  readonly verbose: boolean;
  readonly envFile?: string;
  readonly project: ProjectAdapter;
  readonly registry: CommandRegistry;
  readonly signal: AbortSignal;
  /** Human-readable output (suppressed in --json mode). */
  print(line: string): void;
  /** Diagnostics; always stderr. */
  log(line: string): void;
  /** Returns null when prompting is not possible (non-interactive). */
  prompt(question: string): Promise<string | null>;
  /**
   * Structured prompt session (`@framework/prompts`). Present whenever the CLI
   * can resolve answers (interactive TTY, or an injected `--answers` map);
   * `undefined` in the most minimal non-interactive contexts, where commands
   * must fall back to `prompt`/defaults.
   */
  readonly prompts?: PromptSession;
}

export interface CommandInput {
  readonly positionals: readonly string[];
  readonly options: OptionValues;
}

export interface CommandResult {
  readonly data?: unknown;
  readonly warnings?: readonly string[];
}

export interface Command {
  readonly name: string;
  readonly description: string;
  readonly group: CommandGroup;
  readonly status: CommandStatus;
  readonly arguments?: readonly ArgumentSpec[];
  readonly options?: readonly OptionSpec[];
  readonly examples?: readonly string[];
  /** Human-readable capability requirements shown in help (e.g. "PostgreSQL connection"). */
  readonly requires?: readonly string[];
  run(input: CommandInput, context: CommandContext): Promise<CommandResult>;
}

export const defineCommand = (command: Command): Command => command;
