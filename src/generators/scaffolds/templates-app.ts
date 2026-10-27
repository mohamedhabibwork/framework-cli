import { toCamel } from '../naming';

interface Identifiers {
  readonly pascal: string;
  readonly kebab: string;
}

const camel = (kebab: string): string => toCamel(kebab.split('-'));

/** Registry seeded by the first `make:command`; `bin/cli.ts` appends it to the framework catalog. */
export const COMMANDS_REGISTRY = `import type { Command } from '@framework/cli';

/**
 * Application CLI commands, listed next to the framework catalog by
 * bin/cli.ts. \`make:command\` registers new entries below the marker.
 */
export const commands: readonly Command[] = [
  // @framework:commands
];
`;

/** Registry seeded by the first `make:schedule` when the app has none yet. */
export const SCHEDULES_REGISTRY = `/**
 * Application schedules. The scheduler process syncs these timetables onto
 * the queue; \`make:schedule\` registers new entries below the marker.
 */
export const schedules = [
  // @framework:schedules
] as const;
`;

export function renderMail(id: Identifiers): string {
  const fn = camel(id.kebab);
  return `import type { Mailer, SentMessage } from '@framework/mail';

/** Data the ${id.pascal} message is rendered from. */
export interface ${id.pascal}MailData {
  readonly name: string;
}

const escapeHtml = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/**
 * ${id.pascal} mailable: renders subject, text and HTML from typed data.
 * Interpolated values are HTML-escaped; keep the text part in sync.
 */
export function ${fn}Mail(data: ${id.pascal}MailData): {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
} {
  return {
    subject: '${id.pascal}',
    text: \`Hello \${data.name},\\n\\nTODO: write the message.\\n\`,
    html: \`<p>Hello \${escapeHtml(data.name)},</p><p>TODO: write the message.</p>\`,
  };
}

/** Sends the ${id.pascal} message through the bound mailer (default From applies). */
export function send${id.pascal}Mail(
  mailer: Mailer,
  to: string | readonly string[],
  data: ${id.pascal}MailData,
): Promise<readonly SentMessage[]> {
  const message = ${fn}Mail(data);
  return mailer.to(to).subject(message.subject).text(message.text).html(message.html).send();
}
`;
}

const CHANNEL_BUILDERS: Readonly<Record<string, string>> = {
  email: `  toEmail: (payload) => ({ subject: '__TITLE__', text: payload.message }),`,
  database: `  toDatabase: (payload) => ({ title: '__TITLE__', body: payload.message }),`,
  push: `  toPush: (payload) => ({ title: '__TITLE__', body: payload.message }),`,
  messaging: `  toMessaging: (payload) => ({ title: '__TITLE__', body: payload.message }),`,
};

export const NOTIFICATION_CHANNELS: readonly string[] = Object.keys(CHANNEL_BUILDERS);

export function renderNotification(id: Identifiers, channels: readonly string[]): string {
  const builders = channels.map((channel) => (CHANNEL_BUILDERS[channel] as string).replaceAll('__TITLE__', id.pascal));
  return `import { defineNotification } from '@framework/notifications';
import { z } from 'zod/v4';

/**
 * ${id.pascal} notification. Every declared channel has a builder (checked
 * at definition time); the sender picks channels per envelope. Send inline
 * with \`NotificationsService.send\` or queued with \`sendQueued\`.
 */
export const ${camel(id.kebab)}Notification = defineNotification({
  name: '${id.kebab}',
  channels: [${channels.map((channel) => `'${channel}'`).join(', ')}],
  payload: z.object({ message: z.string().min(1).max(2000) }).strict(),
${builders.join('\n')}
});
`;
}

export function renderCommand(id: Identifiers, signature: string): string {
  return `import { defineCommand } from '@framework/cli';

/**
 * \`${signature}\` application command. Runs in-process with the project
 * adapter; return structured \`data\` so \`--json\` callers get an envelope.
 */
export const ${camel(id.kebab)}Command = defineCommand({
  name: '${signature}',
  group: 'app',
  status: 'implemented',
  description: '${id.pascal} command',
  options: [{ name: 'dry-run', type: 'boolean', description: 'Report without changing anything' }],
  async run({ options }, context) {
    const dryRun = options['dry-run'] === true;
    context.print(\`${signature}: \${dryRun ? 'dry run' : 'running'}\`);
    // TODO: implement the command (load config via context.project.loadConfig).
    return { data: { dryRun } };
  },
});
`;
}

export type ScheduleTarget =
  | { readonly kind: 'job'; readonly jobVar: string; readonly jobFile: string }
  | { readonly kind: 'workflow'; readonly workflow: string };

export function renderSchedule(id: Identifiers, cron: string, target: ScheduleTarget): string {
  const imports =
    target.kind === 'job'
      ? `import { defineSchedule } from '@framework/scheduler';\nimport { ${target.jobVar} } from '../jobs/${target.jobFile}';`
      : `import { defineSchedule } from '@framework/scheduler';`;
  const dispatch =
    target.kind === 'job'
      ? `{ kind: 'job', job: ${target.jobVar}, payload: () => ({}) }`
      : `{ kind: 'workflow', workflow: '${target.workflow}', input: () => ({ firedAt: new Date().toISOString() }) }`;
  return `${imports}

/**
 * ${id.pascal} schedule (\`${cron}\`, UTC unless a timezone is set). Overlap
 * \`skip\` holds a Redis lock until the next due run; fires are idempotent
 * per fire id, so a redelivered fire never dispatches twice.
 */
export const ${camel(id.kebab)}Schedule = defineSchedule({
  name: '${id.kebab}',
  cron: '${cron}',
  overlap: 'skip',
  dispatch: ${dispatch},
});
`;
}

export function renderGuard(id: Identifiers, header: string): string {
  return `import { ANONYMOUS_ACTOR, type Actor } from '@framework/core';
import type { ActorResolver } from '@framework/http';

/**
 * ${id.pascal} guard: resolves the request actor before its scope is
 * created. Compose it in the kernel's \`resolveActor\` (first non-anonymous
 * guard wins); return ANONYMOUS_ACTOR when the credential is absent or
 * invalid — never throw for a bad credential.
 */
export const ${camel(id.kebab)}Guard: ActorResolver = async (c): Promise<Actor> => {
  const credential = c.req.header('${header}');
  if (!credential) return ANONYMOUS_ACTOR;
  // TODO: verify the credential (constant-time compare, hashed at rest) and
  // map it to the owning principal.
  return ANONYMOUS_ACTOR;
};
`;
}

export function renderUserProvider(id: Identifiers): string {
  return `import { DatabaseUserProvider, type UserProvider, type UserRecord } from '@framework/auth';
import type { DatabaseConnection } from '@framework/database';

/**
 * ${id.pascal} user provider: a decorator over the framework's database
 * provider. Override the lookups that come from elsewhere (LDAP, a legacy
 * table, a remote directory); bind it as USER_PROVIDER to activate it.
 */
export class ${id.pascal}UserProvider implements UserProvider {
  readonly #inner: UserProvider;

  constructor(connection: DatabaseConnection) {
    this.#inner = new DatabaseUserProvider(connection);
  }

  findById(id: string): Promise<UserRecord | null> {
    return this.#inner.findById(id);
  }

  findByEmail(email: string): Promise<UserRecord | null> {
    // TODO: normalize or redirect the lookup.
    return this.#inner.findByEmail(email.trim().toLowerCase());
  }

  create(input: { readonly name: string; readonly email: string; readonly passwordHash: string }): Promise<UserRecord> {
    return this.#inner.create(input);
  }

  updatePasswordHash(id: string, passwordHash: string): Promise<void> {
    return this.#inner.updatePasswordHash(id, passwordHash);
  }

  markEmailVerified(id: string): Promise<void> {
    return this.#inner.markEmailVerified(id);
  }

  setTotpSecret(id: string, secret: string | null): Promise<void> {
    return this.#inner.setTotpSecret(id, secret);
  }
}
`;
}
