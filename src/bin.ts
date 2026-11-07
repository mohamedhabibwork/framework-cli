#!/usr/bin/env bun
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GLOBAL_OPTIONS, parseArgs, splitCommand, stringOption } from './args';
import { frameworkCommands } from './commands';
import { createStandaloneProject, type ProjectAdapter } from './project';
import { runCli } from './run';

const VERSION = {
  frameworkVersion: '0.2.0',
  cliVersion: '0.2.0',
} as const;

function resolveWorkingDirectory(argv: readonly string[]): { readonly cwd: string; readonly command: string } {
  const { command, rest } = splitCommand(argv);
  const commandName = command ?? 'help';
  try {
    const cmdSpec = frameworkCommands.find((c) => c.name === commandName);
    const parsed = parseArgs(rest, [...GLOBAL_OPTIONS, ...(cmdSpec?.options ?? [])]);
    const explicitCwd = stringOption(parsed.options, 'cwd');
    return {
      cwd: explicitCwd ? resolve(process.cwd(), explicitCwd) : process.cwd(),
      command: commandName,
    };
  } catch {
    return { cwd: process.cwd(), command: commandName };
  }
}

async function resolveProject(cwd: string, command: string): Promise<ProjectAdapter> {
  if (command !== 'create') {
    const localCli = join(cwd, 'bin/cli.ts');
    const localBootstrap = join(cwd, 'bootstrap/app.ts');
    if ((await Bun.file(localCli).exists()) && (await Bun.file(localBootstrap).exists())) {
      try {
        const mod = (await import(pathToFileURL(localCli).href)) as { project?: ProjectAdapter };
        if (mod.project) return mod.project;
      } catch {
        // Fall back to standalone adapter if the local app cannot be imported yet.
      }
    }
  }
  return createStandaloneProject(cwd, VERSION.frameworkVersion);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const { cwd, command } = resolveWorkingDirectory(argv);
  const project = await resolveProject(cwd, command);
  process.exitCode = await runCli({
    argv,
    project,
    commands: frameworkCommands,
    cliVersion: VERSION.cliVersion,
  });
}
