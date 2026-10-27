import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { flag, stringOption } from '../args';
import { type CommandContext, defineCommand } from '../command';
import { failure } from '../errors';
import { runProcess, tail } from '../process';

const TOOL_TIMEOUT_MS = 10 * 60_000;
/** Optional peer SDKs the kits load dynamically; excluded from compiled binaries. */
const OPTIONAL_PEER_SDKS = [
  '@aws-sdk/*',
  '@azure/storage-blob',
  '@fastify/multipart',
  '@google-cloud/storage',
  '@parse/node-apn',
  'amqplib',
  'firebase-admin',
  'firebase-admin/*',
  'formidable',
  'kafkajs',
  'minio',
  'multer',
  'nats',
  'nodemailer',
  'oci-common',
  'oci-objectstorage',
  'redis',
  'web-push',
] as const;

async function delegate(context: CommandContext, command: readonly string[], code: string) {
  const result = await runProcess(command, {
    cwd: context.root,
    timeoutMs: TOOL_TIMEOUT_MS,
    signal: context.signal,
    stream: !context.json,
  });
  if (result.timedOut) throw failure(`${code}_TIMEOUT`, `${command[0]} timed out`);
  if (result.exitCode !== 0)
    throw failure(
      `${code}_FAILED`,
      `${command.join(' ')} exited with ${result.exitCode}`,
      context.json ? tail(result.stdout + result.stderr) : undefined,
    );
  return { data: { command: [...command], exitCode: 0 } };
}

export const toolingCommands = [
  defineCommand({
    name: 'typecheck',
    group: 'tooling',
    status: 'implemented',
    description: 'TypeScript checking without emitting files',
    run: (_input, context) => delegate(context, context.project.tools.typecheck, 'TYPECHECK'),
  }),
  defineCommand({
    name: 'test',
    group: 'tooling',
    status: 'implemented',
    description: 'Run the configured test suites (bun test)',
    options: [
      { name: 'filter', type: 'string', placeholder: '<pattern>', description: 'Only test names matching pattern' },
      {
        name: 'type',
        type: 'string',
        values: ['unit', 'feature', 'integration'],
        description: 'Restrict to a suite directory',
      },
      { name: 'coverage', type: 'boolean', description: 'Collect coverage' },
      { name: 'watch', type: 'boolean', description: 'Re-run on change' },
    ],
    run: ({ options }, context) => {
      const type = stringOption(options, 'type');
      const filter = stringOption(options, 'filter');
      return delegate(
        context,
        [
          ...context.project.tools.test,
          ...(type ? [`tests/${type}`] : []),
          ...(filter ? ['--test-name-pattern', filter] : []),
          ...(flag(options, 'coverage') ? ['--coverage'] : []),
          ...(flag(options, 'watch') ? ['--watch'] : []),
        ],
        'TEST',
      );
    },
  }),
  defineCommand({
    name: 'lint',
    group: 'tooling',
    status: 'implemented',
    description: 'Run configured lint tools; --fix applies safe fixes explicitly',
    options: [{ name: 'fix', type: 'boolean', description: 'Apply safe fixes' }],
    run: ({ options }, context) =>
      delegate(context, [...context.project.tools.lint, ...(flag(options, 'fix') ? ['--fix'] : [])], 'LINT'),
  }),
  defineCommand({
    name: 'format',
    group: 'tooling',
    status: 'implemented',
    description: 'Format sources; --check performs no writes',
    options: [{ name: 'check', type: 'boolean', description: 'Report only' }],
    run: ({ options }, context) =>
      delegate(context, [...context.project.tools.format, ...(flag(options, 'check') ? ['--check'] : [])], 'FORMAT'),
  }),
  defineCommand({
    name: 'build',
    group: 'project',
    status: 'implemented',
    description: 'Compile production binaries with `bun build --compile` into dist/',
    options: [
      {
        name: 'target',
        type: 'string',
        values: ['server', 'worker', 'scheduler'],
        description: 'One entry point; default builds every present one',
      },
    ],
    async run({ options }, context) {
      const wanted = stringOption(options, 'target');
      const available = ['server', 'worker', 'scheduler'].filter((target) =>
        existsSync(join(context.root, 'bin', `${target}.ts`)),
      );
      if (wanted && !available.includes(wanted)) {
        throw failure('BUILD_TARGET_UNKNOWN', `No bin/${wanted}.ts entry point`, `Available: ${available.join(', ')}`);
      }
      const targets = wanted ? [wanted] : available;
      if (targets.length === 0) {
        throw failure('BUILD_NO_TARGETS', 'No bin/{server,worker,scheduler}.ts entry points found');
      }
      const built: string[] = [];
      for (const target of targets) {
        // Optional storage/notifications peer SDKs are never bundled: the
        // kits load them dynamically and fail at boot with catalogued errors
        // when a driver is configured but its SDK is not installed.
        const result = await runProcess(
          [
            'bun',
            'build',
            '--compile',
            '--minify',
            '--sourcemap',
            ...OPTIONAL_PEER_SDKS.flatMap((id) => ['--external', id]),
            '--outfile',
            join('dist', target),
            join('bin', `${target}.ts`),
          ],
          { cwd: context.root, timeoutMs: TOOL_TIMEOUT_MS, signal: context.signal, stream: context.verbose },
        );
        if (result.exitCode !== 0) {
          throw failure(
            'BUILD_FAILED',
            `bun build (${target}) exited with ${result.exitCode}`,
            tail(result.stdout + result.stderr),
          );
        }
        built.push(join('dist', target));
        context.print(`Built dist/${target}`);
      }
      return { data: { built } };
    },
  }),
];
