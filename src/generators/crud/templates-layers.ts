import { importPath } from '../paths';
import type { ResourceDefinition } from './definition';
import type { CrudFiles } from './files';

function formRequest(
  def: ResourceDefinition,
  files: CrudFiles,
  file: string,
  name: string,
  schema: string,
  ability: string,
) {
  return [
    "import { defineFormRequest } from '@framework/validation';",
    `import { ${def.names.camel}Policy } from '${importPath(file, files.policy)}';`,
    `import { ${schema} } from '${importPath(file, files.schemas)}';`,
    '',
    `export const ${name} = defineFormRequest({`,
    `  schema: ${schema},`,
    `  authorize: (c) => ${def.names.camel}Policy.${ability}(c),`,
    '});',
    '',
  ].join('\n');
}

export function renderRequests(def: ResourceDefinition, files: CrudFiles) {
  const { pascal, pluralPascal } = def.names;
  return {
    create: formRequest(def, files, files.createRequest, `create${pascal}Request`, `create${pascal}Schema`, 'create'),
    update: formRequest(def, files, files.updateRequest, `update${pascal}Request`, `update${pascal}Schema`, 'update'),
    list: formRequest(
      def,
      files,
      files.listRequest,
      `list${pluralPascal}Request`,
      `list${pluralPascal}QuerySchema`,
      'viewAny',
    ),
  };
}

export function renderResponse(def: ResourceDefinition, files: CrudFiles): string {
  const { pascal } = def.names;
  const timestampFields = def.fields.filter((f) => f.type === 'timestamp');
  const helpers = new Set(['mapPage', 'type Page', 'type SelectOf']);
  if (def.timestamps.createdAt || def.timestamps.updatedAt || timestampFields.some((f) => !f.nullable))
    helpers.add('toIsoTimestamp');
  if (timestampFields.some((f) => f.nullable)) helpers.add('toIsoTimestampOrNull');
  const project = (name: string, type?: string, nullable?: boolean) => {
    if (type !== 'timestamp') return `    ${name}: row.${name},`;
    return `    ${name}: ${nullable ? 'toIsoTimestampOrNull' : 'toIsoTimestamp'}(row.${name}),`;
  };
  const order = (h: string) => h.replace('type ', '');
  return [
    `import { ${[...helpers].sort((a, b) => order(a).localeCompare(order(b))).join(', ')} } from '@framework/database';`,
    `import type { ${def.tableExport} } from '${importPath(files.response, def.schemaFile)}';`,
    `import type { ${pascal}PageDto, ${pascal}ResponseDto } from '${importPath(files.response, files.dto)}';`,
    '',
    `type ${pascal}Row = SelectOf<typeof ${def.tableExport}>;`,
    '',
    '/** Explicit public projection; adding a column never exposes it automatically. Timestamps are ISO-8601. */',
    `export function to${pascal}Response(row: ${pascal}Row): ${pascal}ResponseDto {`,
    '  return {',
    '    id: row.id,',
    ...def.fields.map((f) => project(f.name, f.type, f.nullable)),
    ...(def.timestamps.createdAt ? [project('createdAt', 'timestamp', false)] : []),
    ...(def.timestamps.updatedAt ? [project('updatedAt', 'timestamp', false)] : []),
    '  };',
    '}',
    '',
    `export function to${pascal}Page(page: Page<${pascal}Row>): ${pascal}PageDto {`,
    `  return mapPage(page, to${pascal}Response);`,
    '}',
    '',
  ].join('\n');
}

export function renderRepository(def: ResourceDefinition, files: CrudFiles): string {
  const remover = def.softDelete ? 'SoftDeletable' : 'Deletable';
  return [
    `import { Creatable, ${remover}, Readable, RepositoryCore, Updatable } from '@framework/database';`,
    `import type { ${def.tableExport} } from '${importPath(files.repository, def.schemaFile)}';`,
    '',
    '/** Typed Drizzle repository composed from CRUD mixins. */',
    `export class ${def.names.pascal}Repository extends ${remover}(`,
    `  Updatable(Creatable(Readable(RepositoryCore<typeof ${def.tableExport}>))),`,
    ') {}',
    '',
  ].join('\n');
}

export function renderService(def: ResourceDefinition, files: CrudFiles): string {
  const { pascal } = def.names;
  return [
    "import { ResourceService } from '@framework/crud';",
    "import type { SelectOf } from '@framework/database';",
    `import type { ${def.tableExport} } from '${importPath(files.service, def.schemaFile)}';`,
    `import type { Create${pascal}Dto, Update${pascal}Dto } from '${importPath(files.service, files.dto)}';`,
    `import type { ${pascal}Repository } from '${importPath(files.service, files.repository)}';`,
    '',
    `type ${pascal} = SelectOf<typeof ${def.tableExport}>;`,
    '',
    '/**',
    ' * Business operations. Everything works with the defaults; the module',
    ' * provider injects the repository, the shared request context (actor +',
    ' * transaction scope) and the event wiring. Add rules by overriding hooks',
    ' * or methods — nothing else needs to change.',
    ' */',
    `export class ${pascal}Service extends ResourceService<${pascal}, Create${pascal}Dto, Update${pascal}Dto> {`,
    '  // Example hook override:',
    `  // protected override beforeCreate(input: Create${pascal}Dto): Create${pascal}Dto {`,
    '  //   return { ...input /* adjust validated input */ };',
    '  // }',
    '}',
    '',
  ].join('\n');
}

export function renderController(def: ResourceDefinition, files: CrudFiles): string {
  const { pascal } = def.names;
  return [
    "import { ResourceController } from '@framework/crud';",
    "import type { SelectOf } from '@framework/database';",
    `import type { Create${pascal}Dto, ${pascal}ResponseDto, Update${pascal}Dto } from '${importPath(files.controller, files.dto)}';`,
    `import { to${pascal}Response } from '${importPath(files.controller, files.response)}';`,
    `import type { ${pascal}Service } from '${importPath(files.controller, files.service)}';`,
    `import type { ${def.tableExport} } from '${importPath(files.controller, def.schemaFile)}';`,
    '',
    `type ${pascal} = SelectOf<typeof ${def.tableExport}>;`,
    '',
    '/**',
    ' * Maps validated HTTP input to service calls and serializes public output.',
    ' * The base provides list/show/store/update/destroy (+restore); override any',
    ' * method for custom behavior while keeping the route contract.',
    ' */',
    `export class ${pascal}Controller extends ResourceController<`,
    `  ${pascal},`,
    `  Create${pascal}Dto,`,
    `  Update${pascal}Dto,`,
    `  ${pascal}ResponseDto`,
    '> {',
    `  constructor(service: ${pascal}Service) {`,
    `    super(service, to${pascal}Response);`,
    '  }',
    '}',
    '',
  ].join('\n');
}

export function renderPolicy(def: ResourceDefinition): string {
  const { camel } = def.names;
  if (def.access === 'authenticated') {
    const ability = (name: string) => `'${def.names.pluralCamel}.${name}'`;
    return [
      "import { type Context } from 'hono';",
      "import { currentPrincipal, denyAll, type FrameworkEnv, hasAbility, type ResourcePolicy } from '@framework/http';",
      '',
      '/**',
      ` * Resource definition declares \`access: authenticated\` for the five CRUD`,
      ' * abilities. Session principals hold `*`; API tokens must carry the',
      ` * \`${def.names.pluralCamel}.<ability>\` ability. Everything else stays deny-all.`,
      ' */',
      `const granted = (c: Context<FrameworkEnv>, ability: string) => {`,
      '  const principal = currentPrincipal(c);',
      '  return principal !== null && hasAbility(principal, ability);',
      '};',
      '',
      `export const ${camel}Policy: ResourcePolicy = {`,
      '  ...denyAll,',
      `  viewAny: (c) => granted(c, ${ability('viewAny')}),`,
      `  view: (c) => granted(c, ${ability('view')}),`,
      `  create: (c) => granted(c, ${ability('create')}),`,
      `  update: (c) => granted(c, ${ability('update')}),`,
      `  delete: (c) => granted(c, ${ability('delete')}),`,
      ...(def.softDelete ? [`  restore: (c) => granted(c, ${ability('restore')}),`] : []),
      '};',
      '',
    ].join('\n');
  }
  return [
    "import { denyAll, type ResourcePolicy } from '@framework/http';",
    '',
    '/**',
    ` * Resource definition declares \`access: public\` for the five CRUD abilities;`,
    ' * every other ability keeps the deny-all default.',
    ' */',
    `export const ${camel}Policy: ResourcePolicy = {`,
    '  ...denyAll,',
    '  viewAny: () => true,',
    '  view: () => true,',
    '  create: () => true,',
    '  update: () => true,',
    '  delete: () => true,',
    ...(def.softDelete ? ['  restore: () => true,'] : []),
    '};',
    '',
  ].join('\n');
}
