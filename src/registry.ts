import type { Command } from './command';
import { CliError, EXIT } from './errors';

/** Command catalog; duplicate names fail at bootstrap. */
export class CommandRegistry {
  readonly #commands = new Map<string, Command>();

  constructor(commands: readonly Command[] = []) {
    for (const command of commands) this.add(command);
  }

  add(command: Command): this {
    if (this.#commands.has(command.name)) {
      throw new CliError(EXIT.FAILURE, 'DUPLICATE_COMMAND', `Command "${command.name}" is registered twice`);
    }
    this.#commands.set(command.name, command);
    return this;
  }

  get(name: string): Command | undefined {
    return this.#commands.get(name);
  }

  all(): Command[] {
    return [...this.#commands.values()].sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
  }
}
