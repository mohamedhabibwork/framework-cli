export { flag, type OptionSpec, type OptionValues, parseArgs, splitCommand, stringOption } from './args';
export { defineCommand } from './command';
export { frameworkCommands } from './commands';
export { EXIT, GLOBAL_OPTIONS } from './constants';
export { CliError, type ExitCode, failure, unsupported, usageError } from './errors';
export { envelope, type JsonEnvelope, table } from './output';
export { type ProcessResult, runProcess } from './process';
export { defineProject } from './project';
export { CommandRegistry } from './registry';
export { type RunOptions, runCli } from './run';
// Grouped conventions: every type in ./types, every constant in ./constants.
export type {
  AppTemplateInput,
  ArgumentSpec,
  Command,
  CommandContext,
  CommandGroup,
  CommandInput,
  CommandResult,
  CommandStatus,
  CrudPlan,
  CrudRequest,
  ProjectAdapter,
  ProjectPaths,
  ProjectTools,
  QueueTarget,
} from './types';
