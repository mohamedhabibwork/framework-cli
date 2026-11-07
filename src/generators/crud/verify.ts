import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnvFile } from '@framework/core';
import postgres from 'postgres';
import type { CommandContext } from '../../command';
import { failure } from '../../errors';
import { runProcess, tail } from '../../process';

const TYPECHECK_TIMEOUT_MS = 5 * 60_000;
const TEST_TIMEOUT_MS = 10 * 60_000;

export type TestMode = 'in-process' | 'network';

export interface TestCaseResult {
  readonly name: string;
  readonly status: 'passed' | 'failed';
}

export interface VerificationReport {
  readonly status: 'passed' | 'failed';
  readonly typecheck: 'passed' | 'failed';
  readonly mode: TestMode;
  readonly tests: readonly TestCaseResult[];
  readonly passed: number;
  readonly failed: number;
  readonly cleanup: 'clean' | 'leaked-databases';
  readonly output?: string;
}

/** TEST_DATABASE_URL from the process, else the project's test env file; missing is an actionable failure. */
async function testDatabaseUrl(context: CommandContext): Promise<string> {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const envFile = context.project.testEnvFile;
  if (envFile && (await Bun.file(envFile).exists())) {
    const value = parseEnvFile(await Bun.file(envFile).text()).TEST_DATABASE_URL;
    if (value) return value;
  }
  throw failure(
    'VERIFY_PREREQUISITE_MISSING',
    'Verification needs a real PostgreSQL test server (TEST_DATABASE_URL)',
    'Run `bun run db:up`, copy .env.test.example to .env.test, then re-run with --verify.',
  );
}

async function countTestDatabases(url: string): Promise<number> {
  const sql = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 5 });
  try {
    const rows = await sql<
      { count: string }[]
    >`select count(*)::text as count from pg_database where datname like 'fw_test_%'`;
    return Number(rows[0]?.count ?? 0);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Parses Bun's JUnit report into per-test results. */
export function parseJunit(xml: string): TestCaseResult[] {
  const results: TestCaseResult[] = [];
  const pattern = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const match of xml.matchAll(pattern)) {
    const name = /\bname="([^"]*)"/.exec(match[1] ?? '')?.[1] ?? 'unknown';
    const body = match[3] ?? '';
    results.push({
      name: name.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&'),
      status: /<(failure|error)\b/.test(body) ? 'failed' : 'passed',
    });
  }
  return results;
}

/**
 * Typecheck, then run the generated endpoint suite against an isolated real
 * PostgreSQL database, then confirm no fw_test_* databases leaked.
 */
export async function verifyCrud(
  context: CommandContext,
  testFile: string,
  mode: TestMode,
): Promise<VerificationReport> {
  const databaseUrl = await testDatabaseUrl(context);
  const typecheck = await runProcess(context.project.tools.typecheck, {
    cwd: context.root,
    timeoutMs: TYPECHECK_TIMEOUT_MS,
    signal: context.signal,
  });
  if (typecheck.exitCode !== 0) {
    return {
      status: 'failed',
      typecheck: 'failed',
      mode,
      tests: [],
      passed: 0,
      failed: 0,
      cleanup: 'clean',
      output: tail(typecheck.stdout + typecheck.stderr, 40),
    };
  }

  const before = await countTestDatabases(databaseUrl);
  const report = join(tmpdir(), `fw-verify-${randomBytes(4).toString('hex')}.xml`);
  try {
    const run = await runProcess(
      [...context.project.tools.test, `./${testFile}`, '--reporter=junit', `--reporter-outfile=${report}`],
      {
        cwd: context.root,
        env: { TEST_DATABASE_URL: databaseUrl, TEST_MODE: mode },
        timeoutMs: TEST_TIMEOUT_MS,
        signal: context.signal,
      },
    );
    const xml = (await Bun.file(report).exists()) ? await Bun.file(report).text() : '';
    const tests = parseJunit(xml);
    const failed = tests.filter((t) => t.status === 'failed').length;
    const after = await countTestDatabases(databaseUrl);
    const status = run.exitCode === 0 && failed === 0 && tests.length > 0 ? 'passed' : 'failed';
    return {
      status,
      typecheck: 'passed',
      mode,
      tests,
      passed: tests.length - failed,
      failed,
      cleanup: after > before ? 'leaked-databases' : 'clean',
      ...(status === 'failed' ? { output: tail(run.stdout + run.stderr, 60) } : {}),
    };
  } finally {
    await rm(report, { force: true });
  }
}
