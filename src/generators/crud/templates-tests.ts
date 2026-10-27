import { importPath } from '../paths';
import { DEFAULT_NUMERIC, type FieldDefinition, isRequired, type ResourceDefinition } from './definition';
import type { CrudFiles } from './files';

const UNKNOWN_UUID = '00000000-0000-4000-8000-000000000000';
const UNKNOWN_INTEGER = 2147483647;

function validExpression(field: FieldDefinition): string {
  switch (field.type) {
    case 'text':
      return `\`${field.name} \${sequence}\``;
    case 'integer':
      return 'sequence';
    case 'numeric': {
      const scale = field.scale ?? DEFAULT_NUMERIC.scale;
      // oxlint-disable-next-line eslint/no-template-curly-in-string -- emits a template literal into generated source
      return scale > 0 ? `\`\${sequence}.${'5'.repeat(scale)}\`` : '`${sequence}`';
    }
    case 'boolean':
      return 'sequence % 2 === 0';
    case 'uuid':
      return 'crypto.randomUUID()';
    case 'timestamp':
      return 'new Date(Date.UTC(2026, 0, 1) + sequence * 1000).toISOString()';
  }
}

const WRONG_TYPE: Readonly<Record<FieldDefinition['type'], string>> = {
  text: '42',
  integer: "'not-a-number'",
  numeric: '10.5',
  boolean: "'yes'",
  uuid: '42',
  timestamp: '42',
};

function refinementViolation(field: FieldDefinition): string | undefined {
  switch (field.type) {
    case 'text':
      return "'   '";
    case 'integer':
      return '1.5';
    case 'numeric':
      return `'1.${'9'.repeat((field.scale ?? DEFAULT_NUMERIC.scale) + 1)}'`;
    case 'uuid':
      return "'not-a-uuid'";
    case 'timestamp':
      return "'yesterday'";
    default:
      return undefined;
  }
}

/** Schema-aware fixtures: one valid builder plus named invalid payload builders. */
export function renderFactory(def: ResourceDefinition, files: CrudFiles): string {
  const { pascal, camel } = def.names;
  const required = def.fields.filter(isRequired);
  const violations = def.fields.flatMap((f) => {
    const value = refinementViolation(f);
    return value === undefined ? [] : [`${f.name}: ${value}`];
  });
  const unknownId = def.primaryKey === 'uuid' ? `'${UNKNOWN_UUID}'` : String(UNKNOWN_INTEGER);
  const invalid = [
    ...(required.length > 0
      ? [
          '  missingRequired: () => {',
          `    const { ${required.map((f) => `${f.name}: _${f.name}`).join(', ')}, ...rest } = valid();`,
          '    return rest;',
          '  },',
        ]
      : []),
    `  wrongTypes: () => ({ ...valid(), ${def.fields.map((f) => `${f.name}: ${WRONG_TYPE[f.type]}`).join(', ')} }),`,
    ...(violations.length > 0 ? [`  refinementViolations: () => ({ ...valid(), ${violations.join(', ')} }),`] : []),
    `  forbiddenFields: () => ({ ...valid(), id: ${unknownId} }),`,
  ];
  return [
    `import type { Create${pascal}Input } from '${importPath(files.factory, files.index)}';`,
    '',
    'let sequence = 0;',
    '',
    `function valid(overrides: Partial<Create${pascal}Input> = {}): Create${pascal}Input {`,
    '  sequence += 1;',
    '  return {',
    ...def.fields.map((f) => `    ${f.name}: ${validExpression(f)},`),
    '    ...overrides,',
    '  };',
    '}',
    '',
    `/** Fixtures derived from the ${def.names.table} schema (types, nullability, refinements). */`,
    `export const ${camel}Factory = {`,
    '  valid,',
    '  invalid: {',
    ...invalid.map((line) => `  ${line}`),
    '  },',
    '} as const;',
    '',
  ].join('\n');
}

/** Endpoint suite: real HTTP calls against the complete app and a real PostgreSQL database. */
export function renderApiTest(def: ResourceDefinition, files: CrudFiles): string {
  const { pascal, camel } = def.names;
  const publicFields = [
    'id',
    ...def.fields.map((f) => f.name),
    ...(def.timestamps.createdAt ? ['createdAt'] : []),
    ...(def.timestamps.updatedAt ? ['updatedAt'] : []),
  ].sort();
  const unknownId = def.primaryKey === 'uuid' ? `'${UNKNOWN_UUID}'` : `'${UNKNOWN_INTEGER}'`;
  const malformedId = def.primaryKey === 'uuid' ? "'not-a-uuid'" : "'not-a-number'";
  const updateField = (def.fields[0] as FieldDefinition).name;
  const factory = `${camel}Factory`;
  const from = (to: string) => importPath(files.test, to);
  const immutable = def.timestamps.createdAt
    ? // oxlint-disable-next-line eslint/no-template-curly-in-string -- emits a template literal into generated source
      "\n    expect((await call(`${BASE}/${record.id}`, 'PATCH', { createdAt: '2000-01-01T00:00:00Z' })).status).toBe(422);"
    : '';
  const softDeleteLifecycle = def.softDelete
    ? `

    const deletedList = await call(\`\${BASE}/deleted\`);
    expect(deletedList.status).toBe(200);
    const deletedPage = (await deletedList.json()) as { items: { id: string | number }[] };
    expect(deletedPage.items.map((item) => item.id)).toContain(record.id);

    const deletedRead = await call(\`\${BASE}/deleted/\${record.id}\`);
    expect(deletedRead.status).toBe(200);
    expect(${camel}ResponseSchema.parse(await deletedRead.json())).toMatchObject({ id: record.id });

    const restored = await call(\`\${BASE}/\${record.id}/restore\`, 'POST');
    expect(restored.status).toBe(200);

    const restoredRead = await call(\`\${BASE}/\${record.id}\`);
    expect(restoredRead.status).toBe(200);`
    : '';
  const authenticated = def.access === 'authenticated';
  const authImports = authenticated ? "import { AUTH_SERVICE } from '@framework/auth';\n" : '';
  const authSetup = authenticated
    ? `
// Unique per run; only ever used against the isolated test database.
const PASSWORD = \`ep-tests-\${Date.now()}-passphrase\`;

let authorization: Record<string, string> = {};
let tester: { id: string };

beforeAll(async () => {
  ctx = await createTestContext();
  // Authenticated resources require the auth module; the app binds AUTH_SERVICE.
  const service = ctx.application.container.resolve(AUTH_SERVICE);
  tester = await service.register({
    name: 'Endpoint Tests',
    email: \`endpoint-tests+\${Date.now()}@example.test\`,
    password: PASSWORD,
  });
  const issued = await service.issueToken(tester, { name: 'crud-tests', abilities: ['*'] });
  authorization = { authorization: \`Bearer \${issued.plaintext}\` };
});`
    : `
beforeAll(async () => {
  ctx = await createTestContext();
});`;
  const authTests = authenticated
    ? `
  test('rejects anonymous requests with 401', async () => {
    expect((await ctx.client.request(BASE, jsonInit('POST', ${factory}.valid()))).status).toBe(401);
    expect((await ctx.client.request(\`\${BASE}?page=1&limit=1\`)).status).toBe(401);
    expect((await ctx.client.request(\`\${BASE}/\${UNKNOWN_ID}\`)).status).toBe(401);
  });

  test('tokens without the resource ability are forbidden (403)', async () => {
    const service = ctx.application.container.resolve(AUTH_SERVICE);
    const limited = await service.issueToken(tester, { name: 'unrelated', abilities: ['orders.view'] });
    const response = await ctx.client.request(\`\${BASE}?page=1&limit=1\`, {
      headers: { authorization: \`Bearer \${limited.plaintext}\` },
    });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe('FORBIDDEN');
  });
`
    : '';
  const call = authenticated
    ? `
const call = (path: string, method = 'GET', body?: JsonValue) => {
  const init = jsonInit(method, body);
  return ctx.client.request(path, { ...init, headers: { ...init.headers, ...authorization } });
};`
    : `
const call = (path: string, method = 'GET', body?: JsonValue) => ctx.client.request(path, jsonInit(method, body));`;

  return `import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { JsonValue } from '@framework/core';
import { jsonInit } from '@framework/testing';
${authImports}import { ${factory} } from '${from(files.factory)}';
import { createTestContext, type TestContext } from '${from(files.testSupport)}';
import { ${camel}ResponseSchema } from '${from(files.schemas)}';

const BASE = '${def.mount}';
const UNKNOWN_ID = ${unknownId};
const MALFORMED_ID = ${malformedId};
const PUBLIC_FIELDS = ${JSON.stringify(publicFields).replace(/"/g, "'").replace(/,/g, ', ')};
const UPDATE_FIELD = '${updateField}';

let ctx: TestContext;
${authSetup}

afterAll(async () => {
  await ctx?.close();
});
${call}
async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

async function create(): Promise<Record<string, JsonValue> & { id: string | number }> {
  const response = await call(BASE, 'POST', ${factory}.valid());
  expect(response.status).toBe(201);
  return ${camel}ResponseSchema.parse(await response.json()) as Record<string, JsonValue> & { id: string | number };
}

function updateValue(): JsonValue {
  return (${factory}.valid() as Record<string, JsonValue>)[UPDATE_FIELD] as JsonValue;
}

describe('${pascal} API (real PostgreSQL)', () => {
  test('create -> list -> read -> update -> read -> delete -> missing-read', async () => {
    const input = ${factory}.valid();

    const created = await call(BASE, 'POST', input);
    expect(created.status).toBe(201);
    const record = ${camel}ResponseSchema.parse(await created.json()) as Record<string, JsonValue> & { id: string | number };
    expect(record).toMatchObject(input);

    const list = await call(\`\${BASE}?page=1&limit=100\`);
    expect(list.status).toBe(200);
    const page = (await list.json()) as { items: { id: string | number }[] };
    expect(page.items.map((item) => item.id)).toContain(record.id);

    const read = await call(\`\${BASE}/\${record.id}\`);
    expect(read.status).toBe(200);
    expect(${camel}ResponseSchema.parse(await read.json())).toEqual(record as never);

    const changes = { [UPDATE_FIELD]: updateValue() };
    const updated = await call(\`\${BASE}/\${record.id}\`, 'PATCH', changes);
    expect(updated.status).toBe(200);
    const updatedRecord = ${camel}ResponseSchema.parse(await updated.json()) as Record<string, JsonValue>;
    expect(updatedRecord[UPDATE_FIELD]).toEqual(changes[UPDATE_FIELD]);
    for (const field of PUBLIC_FIELDS) {
      if (field !== UPDATE_FIELD && field !== 'updatedAt') expect(updatedRecord[field]).toEqual(record[field]);
    }

    const reread = ${camel}ResponseSchema.parse(await (await call(\`\${BASE}/\${record.id}\`)).json()) as Record<string, JsonValue>;
    expect(reread[UPDATE_FIELD]).toEqual(changes[UPDATE_FIELD]);

    const deleted = await call(\`\${BASE}/\${record.id}\`, 'DELETE');
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe('');

    const missing = await call(\`\${BASE}/\${record.id}\`);
    expect(missing.status).toBe(404);
    expect(await errorCode(missing)).toBe('NOT_FOUND');${softDeleteLifecycle}
  });
${authTests}
  test('responses expose only the public allowlist', async () => {
    const record = await create();
    expect(Object.keys(record).sort()).toEqual(PUBLIC_FIELDS);
  });

  test('listing is ordered deterministically and bounded', async () => {
    for (let i = 0; i < 3; i++) await create();
    const first = (await (await call(\`\${BASE}?page=1&limit=2\`)).json()) as { items: JsonValue[]; meta: { limit: number } };
    const again = (await (await call(\`\${BASE}?page=1&limit=2\`)).json()) as { items: JsonValue[] };
    expect(first.items).toHaveLength(2);
    expect(first.meta.limit).toBe(2);
    expect(again.items).toEqual(first.items);

    expect((await call(\`\${BASE}?limit=0\`)).status).toBe(422);
    expect((await call(\`\${BASE}?limit=101\`)).status).toBe(422);
    expect((await call(\`\${BASE}?page=0\`)).status).toBe(422);
    expect((await call(\`\${BASE}?unknown=1\`)).status).toBe(422);
  });

  test('rejects malformed JSON and malformed ids', async () => {
    expect((await call(BASE, 'POST', '{"broken":')).status).toBe(400);
    expect((await call(\`\${BASE}/\${MALFORMED_ID}\`)).status).toBe(422);
    expect((await call(\`\${BASE}/\${UNKNOWN_ID}\`)).status).toBe(404);
  });

  test('rejects invalid payloads (missing, mistyped, refinement, forbidden fields)', async () => {
    for (const [name, build] of Object.entries(${factory}.invalid)) {
      const response = await call(BASE, 'POST', build());
      expect({ name, status: response.status }).toEqual({ name, status: 422 });
      expect(await errorCode(response)).toBe('VALIDATION_FAILED');
    }
  });

  test('rejects empty and immutable-field updates; unknown ids are 404', async () => {
    const record = await create();
    expect((await call(\`\${BASE}/\${record.id}\`, 'PATCH', {})).status).toBe(422);
    expect((await call(\`\${BASE}/\${record.id}\`, 'PATCH', { id: UNKNOWN_ID })).status).toBe(422);${immutable}
    expect((await call(\`\${BASE}/\${UNKNOWN_ID}\`, 'PATCH', changesFor())).status).toBe(404);
    expect((await call(\`\${BASE}/\${UNKNOWN_ID}\`, 'DELETE')).status).toBe(404);
  });
});

function changesFor(): Record<string, JsonValue> {
  return { [UPDATE_FIELD]: updateValue() };
}
`;
}
