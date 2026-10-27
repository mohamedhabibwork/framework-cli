import { failure } from './errors';

const KILL_GRACE_MS = 5_000;

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface ProcessOptions {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Bounded operational timeout. */
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Forward output live to stderr (stdout stays clean for --json). */
  readonly stream?: boolean;
}

async function collect(stream: ReadableStream<Uint8Array>, forward: boolean): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let text = '';
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    const part = decoder.decode(chunk.value, { stream: true });
    text += part;
    if (forward) process.stderr.write(part);
  }
  return text + decoder.decode();
}

/** Runs a delegated executable with a timeout; never uses a shell. */
export async function runProcess(command: readonly string[], options: ProcessOptions): Promise<ProcessResult> {
  if (command.length === 0) throw failure('EMPTY_COMMAND', 'No executable configured');
  if (options.signal?.aborted) throw failure('INTERRUPTED', 'Interrupted before start');
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([...command], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env } as Record<string, string>,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    });
  } catch (error) {
    throw failure('SPAWN_FAILED', `Could not start "${command[0]}"`, 'Is the tool installed?', error);
  }
  let timedOut = false;
  let killer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    killer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
  }, options.timeoutMs);
  // Grandchildren may keep the pipes open after the child exits; never wait on them past the deadline.
  const pipeDeadline = new Promise<string>((resolve) =>
    setTimeout(() => resolve(''), options.timeoutMs + 2 * KILL_GRACE_MS).unref?.(),
  );
  const abort = () => child.kill('SIGINT');
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      Promise.race([collect(child.stdout as ReadableStream<Uint8Array>, options.stream ?? false), pipeDeadline]),
      Promise.race([collect(child.stderr as ReadableStream<Uint8Array>, options.stream ?? false), pipeDeadline]),
      child.exited,
    ]);
    return { exitCode, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
    clearTimeout(killer);
    options.signal?.removeEventListener('abort', abort);
  }
}

/** Last lines of output for failure summaries. */
export function tail(text: string, lines = 20): string {
  return text.trimEnd().split('\n').slice(-lines).join('\n');
}
