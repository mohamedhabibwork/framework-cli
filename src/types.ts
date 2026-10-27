/** Every interface and type alias of `@framework/cli` in one import point. */
export type {
  ArgumentSpec,
  Command,
  CommandContext,
  CommandGroup,
  CommandInput,
  CommandResult,
  CommandStatus,
} from './command';
export type { AppTemplateInput } from './generators/app/templates';
export type { CrudPlan, CrudRequest } from './generators/crud/generate';
export type { ProjectAdapter, ProjectPaths, ProjectTools, QueueTarget } from './project';
