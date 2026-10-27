import { toCamel, toSnake } from '../naming';

interface Identifiers {
  readonly pascal: string;
  readonly kebab: string;
}

const camel = (kebab: string): string => toCamel(kebab.split('-'));
const constant = (kebab: string): string => `${toSnake(kebab.split('-')).toUpperCase()}`;

/** Derives the `<channel>` / `<verb>` pair from a kebab event name (order-paid -> order + paid). */
export function splitEventName(kebab: string): { readonly channel: string; readonly verb: string } {
  const parts = kebab.split('-');
  if (parts.length < 2) throw new Error('single-word event names need an explicit channel');
  return { channel: parts.slice(0, -1).join('-'), verb: parts.at(-1) as string };
}

export function renderMiddleware(id: Identifiers): string {
  return `import type { FrameworkEnv } from '@framework/http';
import type { MiddlewareHandler } from 'hono';

/**
 * ${id.pascal} middleware: native typed Hono middleware. The generator
 * registered it as the \`${id.kebab}\` alias in bootstrap/middleware.ts;
 * attach the alias to a group or route to activate it.
 */
export const ${camel(id.kebab)}Middleware: MiddlewareHandler<FrameworkEnv> = async (c, next) => {
  // TODO: inspect or short-circuit the request (return a Response to stop the chain).
  await next();
};
`;
}

export function renderProvider(id: Identifiers): string {
  return `import { defineProvider, token } from '@framework/core';
import type { AppConfig } from '../../config';

/** The service contract this provider binds. Replace with the real surface. */
export interface ${id.pascal}Service {
  ping(): string;
}

export const ${constant(id.kebab)}_SERVICE = token<${id.pascal}Service>('${id.kebab}.service');

/**
 * ${id.pascal} provider lifecycle: register bindings here; add boot/shutdown
 * hooks when resources need starting or draining. Registered in
 * bootstrap/providers.ts and visible in \`module:list\`.
 */
export const ${camel(id.kebab)}Provider = defineProvider<AppConfig>({
  name: '${id.kebab}',
  register({ container }) {
    container.singleton(${constant(id.kebab)}_SERVICE, () => ({
      // TODO: construct the service (resolve dependencies from the container).
      ping: () => 'pong',
    }));
  },
});
`;
}

export function renderEvent(id: Identifiers, channel: string, verb: string): string {
  const schemaVar = `${camel(id.kebab)}PayloadSchema`;
  return `import type { ExecutionContext } from '@framework/core';
import { createDomainEvent, type DomainEvent } from '@framework/events';
import { z } from 'zod/v4';

/** Payload contract for ${channel}.${verb}; validated before publishing. */
export const ${schemaVar} = z.object({
  // TODO: describe the payload
}).strict();

export type ${id.pascal}Event = DomainEvent<z.output<typeof ${schemaVar}>>;

/** Builds a validated ${channel}.${verb} event bound to the current execution. */
export function create${id.pascal}Event(
  payload: z.output<typeof ${schemaVar}>,
  context: ExecutionContext,
): ${id.pascal}Event {
  return createDomainEvent('${channel}', '${verb}', ${schemaVar}.parse(payload), context);
}
`;
}

export function renderListener(id: Identifiers, channel: string): string {
  return `import type { Listener } from './index';

/**
 * ${id.pascal} listener: subscribed to \`${channel}\` by the listeners
 * provider (app/listeners). Delivery is at-least-once; keep handling
 * idempotent. React via \`event.payload\` — publishing is a post-commit fact.
 */
export const ${camel(id.kebab)}Listener: Listener = {
  name: '${id.kebab}',
  channel: '${channel}',
  async handle(event) {
    // TODO: handle the event (event.correlationId links it to the cause).
  },
};
`;
}

export function renderUnitTest(id: Identifiers): string {
  return `import { describe, test } from 'bun:test';

// TODO: import the unit under test and replace the placeholder below.
describe('${id.kebab}', () => {
  test.todo('${id.kebab} works', () => {});
});
`;
}

export function renderApiTest(id: Identifiers): string {
  return `import { afterAll, beforeAll, test } from 'bun:test';
import { createTestContext, type TestContext } from './support';

let context: TestContext;

beforeAll(async () => {
  context = await createTestContext();
});

afterAll(async () => {
  await context.close();
});

// TODO: replace with the behavior under test, e.g.
// const response = await context.client.request('/api/v1/…');
test.todo('${id.kebab} endpoint works', () => {});
`;
}
