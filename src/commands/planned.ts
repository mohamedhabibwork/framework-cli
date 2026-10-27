import { type Command, type CommandGroup, defineCommand } from '../command';
import { unsupported } from '../errors';

/**
 * Commands from the specification that are not implemented yet. They are
 * listed (status "planned") so the catalog is honest, and fail with exit 3.
 */
const PLANNED: readonly [string, CommandGroup, string][] = [
  ['integration:list', 'project', 'Show configured adapters, versions and capabilities'],
  ['integration:check', 'project', 'Validate adapter compatibility and optional connectivity'],
  ['make:model', 'generators', 'Thin model metadata/serialization'],
  ['make:integration', 'generators', 'Optional lifecycle adapter'],
  // Migrations are forward-only by decision (ADR): roll back by authoring a
  // new forward migration, or reset a non-production target with `db:fresh`.
  ['db:rollback', 'database', 'Reverse the last migration (see db:fresh; forward-only by design)'],
  ['cache:prune', 'cache', 'Adapter-supported expiry cleanup'],
  ['storage:link', 'storage', 'Link a configured local public disk'],
  ['storage:prune', 'storage', 'Remove framework-owned temporary uploads'],
  // First-party package equivalents (E-series). Listed as planned so the
  // catalog is honest until the subsystem tasks land (E05/E09/E11/E12).
  ['oauth:client:create', 'oauth', 'Register an OAuth2 client (confidential or public)'],
  ['oauth:client:list', 'oauth', 'List registered OAuth2 clients'],
  ['oauth:key:generate', 'oauth', 'Generate the OAuth server signing key pair (JWKS)'],
  ['observatory:list', 'observatory', 'List recent observatory entries'],
  ['observatory:prune', 'observatory', 'Prune observatory entries older than a date'],
  ['observatory:clear', 'observatory', 'Clear all observatory entries'],
  ['socialite:providers', 'socialite', 'List configured social login providers'],
];

export const plannedCommands: Command[] = PLANNED.map(([name, group, description]) =>
  defineCommand({
    name,
    group,
    status: 'planned',
    description,
    async run() {
      throw unsupported(
        `"${name}" is planned but not implemented in this release`,
        'See docs/status.md for the delivery phase that introduces it.',
      );
    },
  }),
);
