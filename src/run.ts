import { createInterface } from 'node:readline/promises';
import { redact } from '@framework/core';
import type { PromptAnswer } from '@framework/prompts';
import { flag, GLOBAL_OPTIONS, parseArgs, splitCommand, stringOption } from './args';
import type { Command, CommandContext } from './command';
import { createCliPromptSession, mapPromptError } from './context/prompts';
import { CliError, EXIT, type ExitCode, interrupted, usageError } from './errors';
import { envelope } from './output';
import type { ProjectAdapter } from './project';
import { CommandRegistry } from './registry';

export interface RunOptions {
  readonly argv: readonly string[];
  readonly project: ProjectAdapter;
  readonly commands: readonly Command[];
  readonly cliVersion: string;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly isTTY?: boolean;
  /**
   * Injected prompt answers keyed by prompt message. Enables scripted,
   * non-interactive runs (`--answers`); never read when absent.
   */
  readonly answers?: Readonly<Record<string, PromptAnswer>>;
}

export function helpText(command: Command): string[] {
  const args = (command.arguments ?? []).map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(' ');
  const lines = [`Usage: ${command.name}${args ? ` ${args}` : ''} [options]`, '', command.description, ''];
  lines.push(`Status: ${command.status}`);
  if (command.requires?.length) lines.push(`Requires: ${command.requires.join(', ')}`);
  for (const arg of command.arguments ?? []) lines.push(`  ${arg.name.padEnd(28)}${arg.description}`);
  const options = [...(command.options ?? []), ...GLOBAL_OPTIONS];
  lines.push('', 'Options:');
  for (const option of options) {
    const name = `--${option.name}${option.type === 'string' ? ` ${option.placeholder ?? '<value>'}` : ''}`;
    const values = option.values ? ` (${option.values.join('|')})` : '';
    lines.push(`  ${name.padEnd(28)}${option.description}${values}`);
  }
  if (command.examples?.length) lines.push('', 'Examples:', ...command.examples.map((e) => `  ${e}`));
  return lines;
}

/** Executes one CLI invocation and returns the process exit code. */
export async function runCli(options: RunOptions): Promise<ExitCode> {
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(`${text}\n`));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(`${text}\n`));
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once('SIGINT', onSignal);

  const { command: name, rest } = splitCommand(options.argv);
  const preliminary = (() => {
    try {
      return parseArgs(rest, GLOBAL_OPTIONS.concat(options.commands.find((c) => c.name === name)?.options ?? []));
    } catch {
      return undefined;
    }
  })();
  const json = preliminary ? flag(preliminary.options, 'json') : rest.includes('--json');
  const commandName = name ?? 'help';

  const fail = (error: CliError): ExitCode => {
    if (json)
      stdout(envelope(commandName, 'error', error.data ?? null, [], { code: error.code, message: error.message }));
    else stderr(`Error [${error.code}]: ${error.message}${error.hint ? `\nHint: ${error.hint}` : ''}`);
    return error.exitCode;
  };

  try {
    const registry = new CommandRegistry(options.commands);
    const command = registry.get(commandName);
    if (!command) throw usageError(`Unknown command "${commandName}"`, 'Run `list` to see available commands');
    const parsed = parseArgs(rest, [...GLOBAL_OPTIONS, ...(command.options ?? [])]);

    if (flag(parsed.options, 'version')) {
      const data = { cli: options.cliVersion, framework: options.project.frameworkVersion };
      json ? stdout(envelope(command.name, 'ok', data)) : stdout(`cli ${data.cli}, framework ${data.framework}`);
      return EXIT.OK;
    }
    if (flag(parsed.options, 'help')) {
      json ? stdout(envelope(command.name, 'ok', { usage: helpText(command) })) : stdout(helpText(command).join('\n'));
      return EXIT.OK;
    }

    const interactive = (options.isTTY ?? Boolean(process.stdin.isTTY)) && !flag(parsed.options, 'no-interaction');
    // `--json` and `--no-interaction` force the non-interactive paths (injected
    // answers / defaults) and must never read the TTY (frozen contract, C3).
    const promptInteractive = interactive && !json;
    const verbose = flag(parsed.options, 'verbose');
    const context: CommandContext = {
      root: stringOption(parsed.options, 'cwd') ?? options.project.root,
      json,
      interactive,
      verbose,
      envFile: stringOption(parsed.options, 'env-file'),
      project: options.project,
      registry,
      signal: controller.signal,
      prompts: createCliPromptSession({ interactive: promptInteractive, answers: options.answers }),
      print: (line) => {
        if (!json) stdout(line);
      },
      log: (line) => stderr(verbose ? line : String(redact(line))),
      prompt: async (question) => {
        if (!interactive) return null;
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        try {
          return (await rl.question(`${question} `)).trim();
        } finally {
          rl.close();
        }
      },
    };

    const result = await command.run({ positionals: parsed.positionals, options: parsed.options }, context);
    if (controller.signal.aborted) throw interrupted();
    if (json) stdout(envelope(command.name, 'ok', result.data, result.warnings));
    else for (const warning of result.warnings ?? []) stderr(`Warning: ${warning}`);
    return EXIT.OK;
  } catch (error) {
    if (controller.signal.aborted) return fail(interrupted());
    const promptError = mapPromptError(error);
    if (promptError) return fail(promptError);
    if (error instanceof CliError) return fail(error);
    const message = error instanceof Error ? error.message : String(error);
    if (!json) stderr(String(redact(error instanceof Error && error.stack ? error.stack : message)));
    return fail(new CliError(EXIT.FAILURE, 'EXECUTION_FAILED', String(redact(message))));
  } finally {
    process.off('SIGINT', onSignal);
  }
}
