import { describe, expect, test } from 'bun:test';
import { PromptInterruptedError, PromptValidationError } from '@framework/prompts';
import { defineCommand } from '../src/command';
import { frameworkCommands } from '../src/commands';
import { createCliPromptSession, mapPromptError } from '../src/context/prompts';
import { CliError, EXIT } from '../src/errors';
import type { ProjectAdapter } from '../src/project';
import { runCli } from '../src/run';

/** A minimal adapter: these commands never touch the project. */
const project: ProjectAdapter = {
  name: 'test-app',
  root: process.cwd(),
  frameworkVersion: '0.0.0',
  apiPrefix: '/api',
  paths: {
    modules: 'app/modules',
    schemaDir: 'database/schema',
    schemaIndex: 'database/schema/index.ts',
    factories: 'database/factories',
    migrations: 'database/migrations',
    apiRoutes: 'routes/api.ts',
    providers: 'providers.ts',
    middleware: 'middleware.ts',
    openapi: 'bootstrap/openapi.ts',
    config: 'config/index.ts',
    testSupport: 'tests/support.ts',
  },
  tools: { typecheck: [], test: [], lint: [], format: [], drizzleKit: [], dev: [], serve: [] },
  loadConfig: async () => ({}),
  databaseUrl: () => 'postgres://localhost/test',
  routes: async () => [],
  providers: () => [],
  middleware: () => [],
  openapi: () => ({ operations: [], build: () => ({}) }),
};

const requiredPrompt = defineCommand({
  name: 'prompt:required',
  description: 'Asks for a required text answer',
  group: 'tooling',
  status: 'implemented',
  async run(_input, context) {
    if (!context.prompts) throw new Error('prompt session unavailable');
    const answer = await context.prompts.text({ message: 'Name' });
    return { data: { answer } };
  },
});

const interruptPrompt = defineCommand({
  name: 'prompt:interrupt',
  description: 'Simulates an interrupted prompt',
  group: 'tooling',
  status: 'implemented',
  async run() {
    throw new PromptInterruptedError();
  },
});

const commands = [...frameworkCommands, requiredPrompt, interruptPrompt];

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly envelope: { readonly error?: { readonly code: string }; readonly data?: unknown };
}

async function run(args: readonly string[], options: { isTTY?: boolean; answers?: Record<string, string> } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli({
    argv: args,
    project,
    commands,
    cliVersion: '0.0.0',
    isTTY: options.isTTY ?? false,
    answers: options.answers,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  });
  const stdout = out.join('\n');
  let envelope: RunResult['envelope'] = {};
  try {
    envelope = JSON.parse(stdout) as RunResult['envelope'];
  } catch {
    envelope = {};
  }
  return { code, stdout, stderr: err.join('\n'), envelope } satisfies RunResult;
}

describe('prompt error mapping', () => {
  test('maps validation failures to exit 2 and interrupts to exit 130', () => {
    const validation = mapPromptError(new PromptValidationError('Name', 'Required'));
    expect(validation).toBeInstanceOf(CliError);
    expect(validation?.exitCode).toBe(EXIT.USAGE);
    const interrupt = mapPromptError(new PromptInterruptedError());
    expect(interrupt?.exitCode).toBe(EXIT.INTERRUPTED);
    expect(mapPromptError(new Error('unrelated'))).toBeUndefined();
  });

  test('createCliPromptSession refuses to prompt without a TTY', async () => {
    const session = createCliPromptSession({ interactive: false });
    await expect(session.text({ message: 'Name' })).rejects.toBeInstanceOf(PromptValidationError);
  });
});

describe('non-interactive CLI contract', () => {
  test('a required prompt with no default and no answer exits 2 under --no-interaction', async () => {
    const result = await run(['prompt:required', '--no-interaction']);
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.stderr).toMatch(/PROMPT_VALIDATION_FAILED/);
  });

  test('--json forces the non-interactive path even on a TTY (never reads the TTY)', async () => {
    const result = await run(['prompt:required', '--json'], { isTTY: true });
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.envelope.error?.code).toBe('PROMPT_VALIDATION_FAILED');
  });

  test('an injected answer resolves the prompt without a TTY', async () => {
    const result = await run(['prompt:required', '--json', '--no-interaction'], { answers: { Name: 'Ada' } });
    expect(result.code).toBe(EXIT.OK);
    expect(result.envelope.data).toEqual({ answer: 'Ada' });
  });

  test('an interrupt maps to exit 130', async () => {
    const result = await run(['prompt:interrupt']);
    expect(result.code).toBe(EXIT.INTERRUPTED);
    expect(result.stderr).toMatch(/PROMPT_INTERRUPTED/);
  });
});
