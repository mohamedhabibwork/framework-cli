import { importPath } from '../paths';
import type { ResourceDefinition } from './definition';
import type { CrudFiles } from './files';

export function renderRoutes(def: ResourceDefinition, files: CrudFiles): string {
  const { pascal, camel, pluralPascal, constant } = def.names;
  const from = (to: string) => importPath(files.routes, to);
  const authenticated = def.access === 'authenticated';
  const imports = [
    authenticated
      ? "import { authorize, type FrameworkEnv, requireAuth, resolve } from '@framework/http';"
      : "import { authorize, type FrameworkEnv, resolve } from '@framework/http';",
    "import { authorizeRequest, validate } from '@framework/validation';",
    "import { type Context, Hono } from 'hono';",
  ];
  // Authentication runs before authorization on every route of the resource.
  const guard = authenticated ? 'requireAuth(), ' : '';
  return [
    ...imports,
    `import { ${camel}Policy } from '${from(files.policy)}';`,
    `import { ${constant}_CONTROLLER } from '${from(files.provider)}';`,
    `import { create${pascal}Request } from '${from(files.createRequest)}';`,
    `import { list${pluralPascal}Request } from '${from(files.listRequest)}';`,
    `import { update${pascal}Request } from '${from(files.updateRequest)}';`,
    `import { ${camel}IdParamSchema } from '${from(files.schemas)}';`,
    '',
    `const controller = (c: Context<FrameworkEnv>) => resolve(c, ${constant}_CONTROLLER);`,
    '',
    '/**',
    ' * Concrete native routes (kept explicit so Hono RPC inference is preserved).',
    authenticated
      ? ' * Per-route order: validation/parameter binding -> authentication -> authorization -> handler.'
      : ' * Per-route order: validation/parameter binding -> authorization -> handler.',
    ' */',
    `export const ${camel}Routes = new Hono<FrameworkEnv>()`,
    `  .get('/', validate('query', list${pluralPascal}Request.schema), ${guard}authorizeRequest(list${pluralPascal}Request), async (c) =>`,
    "    c.json(await controller(c).list(c.req.valid('query')), 200),",
    '  )',
    `  .post('/', validate('json', create${pascal}Request.schema), ${guard}authorizeRequest(create${pascal}Request), async (c) =>`,
    "    c.json(await controller(c).store(c.req.valid('json')), 201),",
    '  )',
    ...(def.softDelete
      ? [
          `  .get('/deleted', validate('query', list${pluralPascal}Request.schema), ${guard}authorizeRequest(list${pluralPascal}Request), async (c) => c.json(await controller(c).deleted(c.req.valid('query')), 200),)`,
          `  .get('/deleted/:id', validate('param', ${camel}IdParamSchema), ${guard}authorize(${camel}Policy, 'view'), async (c) => c.json(await controller(c).showDeleted(c.req.valid('param').id), 200),)`,
        ]
      : []),
    `  .get('/:id', validate('param', ${camel}IdParamSchema), ${guard}authorize(${camel}Policy, 'view'), async (c) =>`,
    "    c.json(await controller(c).show(c.req.valid('param').id), 200),",
    '  )',
    '  .patch(',
    "    '/:id',",
    `    validate('param', ${camel}IdParamSchema),`,
    `    validate('json', update${pascal}Request.schema),`,
    `    ${guard}authorizeRequest(update${pascal}Request),`,
    "    async (c) => c.json(await controller(c).update(c.req.valid('param').id, c.req.valid('json')), 200),",
    '  )',
    `  .delete('/:id', validate('param', ${camel}IdParamSchema), ${guard}authorize(${camel}Policy, 'delete'), async (c) => {`,
    "    await controller(c).destroy(c.req.valid('param').id);",
    '    return c.body(null, 204);',
    def.softDelete ? '  })' : '  });',
    ...(def.softDelete
      ? [
          `  .post('/:id/restore', validate('param', ${camel}IdParamSchema), ${guard}authorize(${camel}Policy, 'restore'), async (c) => c.json(await controller(c).restore(c.req.valid('param').id), 200),);`,
        ]
      : []),
    '',
  ].join('\n');
}

export function renderProvider(def: ResourceDefinition, files: CrudFiles, configFile: string): string {
  const { pascal, pluralCamel, constant, module } = def.names;
  const from = (to: string) => importPath(files.provider, to);
  const options = def.softDelete ? `, { softDeleteColumn: ${def.tableExport}.deletedAt }` : '';
  return [
    "import { defineProvider, token } from '@framework/core';",
    "import { DATA_CONTEXT } from '@framework/database';",
    "import { EVENT_BUS } from '@framework/events';",
    `import type { AppConfig } from '${from(configFile)}';`,
    `import { ${def.tableExport} } from '${from(def.schemaFile)}';`,
    `import { ${pascal}Controller } from '${from(files.controller)}';`,
    `import { ${pascal}Repository } from '${from(files.repository)}';`,
    `import { ${pascal}Service } from '${from(files.service)}';`,
    `import { to${pascal}Response } from '${from(files.response)}';`,
    '',
    `export const ${constant}_REPOSITORY = token<${pascal}Repository>('${module}.repository');`,
    `export const ${constant}_SERVICE = token<${pascal}Service>('${module}.service');`,
    `export const ${constant}_CONTROLLER = token<${pascal}Controller>('${module}.controller');`,
    '',
    '/**',
    ' * Request-scoped: every request shares one data context (transaction +',
    ' * execution) across its repository, service and controller. Entity events',
    ' * publish on the event bus when one is bound (the generated app binds one).',
    ' */',
    `export const ${pluralCamel}Provider = defineProvider<AppConfig>({`,
    `  name: '${module}',`,
    "  dependsOn: ['database', 'events'],",
    '  register({ container }) {',
    `    container.scoped(${constant}_REPOSITORY, (r) => new ${pascal}Repository(${def.tableExport}, r.resolve(DATA_CONTEXT)${options}));`,
    `    container.scoped(${constant}_SERVICE, (r) =>`,
    `      new ${pascal}Service(r.resolve(${constant}_REPOSITORY), r.resolve(DATA_CONTEXT), {`,
    `        channel: '${pluralCamel}',`,
    '        ...(r.has(EVENT_BUS)',
    `          ? { bus: r.resolve(EVENT_BUS), serialize: (entity) => to${pascal}Response(entity) }`,
    '          : {}),',
    '      }),',
    '    );',
    `    container.scoped(${constant}_CONTROLLER, (r) => new ${pascal}Controller(r.resolve(${constant}_SERVICE)));`,
    '  },',
    '});',
    '',
  ].join('\n');
}

export function renderIndex(def: ResourceDefinition, files: CrudFiles): string {
  const { pascal, camel, pluralPascal, pluralCamel, constant } = def.names;
  const from = (to: string) => importPath(files.index, to);
  return [
    `export type * from '${from(files.dto)}';`,
    `export { ${constant}_CONTROLLER, ${constant}_REPOSITORY, ${constant}_SERVICE, ${pluralCamel}Provider } from '${from(files.provider)}';`,
    `export { ${camel}Routes } from '${from(files.routes)}';`,
    'export {',
    `  create${pascal}Schema,`,
    `  ${camel}IdParamSchema,`,
    `  ${camel}ResponseSchema,`,
    `  list${pluralPascal}QuerySchema,`,
    `  update${pascal}Schema,`,
    `} from '${from(files.schemas)}';`,
    '',
  ].join('\n');
}

export function renderOpenApi(def: ResourceDefinition, files: CrudFiles): string {
  const { pascal, camel } = def.names;
  const security = def.access === 'public' ? "'public'" : "['bearerAuth']";
  return [
    "import { resourceOperations } from '@framework/crud';",
    'import {',
    `  create${pascal}Schema,`,
    `  ${camel}IdParamSchema,`,
    `  ${camel}ResponseSchema,`,
    `  list${def.names.pluralPascal}QuerySchema,`,
    `  update${pascal}Schema,`,
    `} from '${importPath(files.openapi, files.schemas)}';`,
    '',
    '/**',
    ' * CRUD operations derived from the controller contract: the schemas the',
    ' * routes validate and the responses serialize document the five endpoints.',
    ' */',
    `export const ${camel}Operations = resourceOperations({`,
    `  mount: '${def.mount}',`,
    `  resource: '${pascal}',`,
    `  security: ${security},`,
    ...(def.softDelete ? ['  softDelete: true,'] : []),
    '  schemas: {',
    `    create: create${pascal}Schema,`,
    `    update: update${pascal}Schema,`,
    `    response: ${camel}ResponseSchema,`,
    `    query: list${def.names.pluralPascal}QuerySchema,`,
    `    param: ${camel}IdParamSchema,`,
    '  },',
    '});',
    '',
  ].join('\n');
}
