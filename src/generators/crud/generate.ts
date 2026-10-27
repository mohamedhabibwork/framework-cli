import type { CommandContext } from '../../command';
import { unsupported, usageError } from '../../errors';
import type { ResourceNames } from '../naming';
import { resourceNames } from '../naming';
import { importPath, resolveInsideProject } from '../paths';
import { buildChanges, type FileChange, type FileUpdate, type NewFile } from '../plan';
import { addImport, insertAfterMarker } from '../registration';
import {
  type Access,
  type FieldDefinition,
  parseDefinitionFile,
  parseFieldSpec,
  type ResourceDefinition,
} from './definition';
import { type CrudFiles, crudFiles } from './files';
import { introspectTable } from './introspect';
import {
  renderController,
  renderPolicy,
  renderRepository,
  renderRequests,
  renderResponse,
  renderService,
} from './templates-layers';
import { renderIndex, renderOpenApi, renderProvider, renderRoutes } from './templates-module';
import { renderDto, renderSchemas, renderTable } from './templates-schema';
import { renderApiTest, renderFactory } from './templates-tests';

export interface CrudRequest {
  readonly resource: string;
  readonly module?: string;
  readonly table?: string;
  readonly schemaFile?: string;
  readonly fields?: string;
  readonly definitionFile?: string;
  readonly route?: string;
  readonly primaryKey?: string;
  readonly softDelete: boolean;
  readonly access?: string;
}

export interface CrudPlan {
  readonly definition: ResourceDefinition;
  readonly files: CrudFiles;
  readonly changes: readonly FileChange[];
  readonly migrationName?: string;
}

const USAGE_EXAMPLES = [
  "make:crud Product --module products --fields 'name:text:required,price:numeric:required' --access public",
  'make:crud Product --module products --table products --access public',
].join('\n  ');

export async function resolveAccess(
  context: CommandContext,
  flagValue: string | undefined,
  fromFile?: Access,
): Promise<Access> {
  let access = flagValue ?? fromFile;
  if (!access) {
    const answer = await context.prompt('Who may access this resource? ("public" or "authenticated"):');
    if (answer === null) {
      throw usageError(
        'Access must be declared explicitly (--access public|authenticated)',
        'Public access is never generated silently; authenticated resources require the auth module (run make:auth first).',
      );
    }
    access = answer;
  }
  if (access !== 'public' && access !== 'authenticated') {
    throw usageError(`Unknown access "${access}"; expected public or authenticated`);
  }
  if (access === 'authenticated') {
    const providers = await Bun.file(resolveInsideProject(context.root, context.project.paths.providers)).text();
    if (!providers.includes('authProvider')) {
      throw usageError(
        '--access authenticated requires the auth module (no authProvider registered)',
        'Run `make:auth` first, then regenerate this resource with --access authenticated.',
      );
    }
  }
  return access;
}

export async function resolveFields(context: CommandContext, request: CrudRequest) {
  if (request.definitionFile) {
    const file = Bun.file(resolveInsideProject(context.root, request.definitionFile));
    if (!(await file.exists())) throw usageError(`Definition file not found: ${request.definitionFile}`);
    let json: unknown;
    try {
      json = await file.json();
    } catch {
      throw usageError(`Definition file ${request.definitionFile} is not valid JSON`);
    }
    return parseDefinitionFile(json);
  }
  let spec = request.fields;
  if (!spec) {
    const answer = await context.prompt('Fields (<name>:<type>:required|nullable|default=<literal>, comma separated):');
    if (!answer) {
      throw usageError(
        'Provide --fields, --definition or --table (no business columns are ever invented)',
        `Examples:\n  ${USAGE_EXAMPLES}`,
      );
    }
    spec = answer;
  }
  return { fields: parseFieldSpec(spec), softDelete: request.softDelete, access: undefined };
}

function resolveMount(context: CommandContext, request: CrudRequest, module: string): string {
  const prefix = context.project.apiPrefix;
  const mount = request.route ?? `${prefix}/${module}`;
  const segment = mount.slice(prefix.length + 1);
  if (!mount.startsWith(`${prefix}/`) || !/^[a-z][a-z0-9-]*$/.test(segment)) {
    throw usageError(`--route must be ${prefix}/<kebab-segment>`);
  }
  return mount;
}

/** Assembles the resource definition for an existing Drizzle table export. */
export async function assembleTableDefinition(
  context: CommandContext,
  names: ResourceNames,
  args: {
    readonly table: string;
    readonly schemaFile: string;
    readonly softDelete: boolean;
    readonly access: Access;
    readonly route?: string;
  },
): Promise<ResourceDefinition> {
  const table = await introspectTable(context.root, args.schemaFile, args.table);
  if (args.softDelete && !table.hasDeletedAt) {
    throw usageError(`--soft-delete requires a string-mode "deletedAt" column on ${args.table}`);
  }
  return {
    names,
    fields: table.fields,
    primaryKey: table.primaryKey,
    timestamps: table.timestamps,
    softDelete: args.softDelete,
    access: args.access,
    source: 'existing',
    mount: resolveMount(context, { route: args.route } as CrudRequest, names.module),
    tableExport: args.table,
    schemaFile: args.schemaFile,
  };
}

/** Assembles the resource definition for a new table authored from fields. */
export function assembleNewTableDefinition(
  context: CommandContext,
  names: ResourceNames,
  args: {
    readonly fields: readonly FieldDefinition[];
    readonly softDelete: boolean;
    readonly access: Access;
    readonly route?: string;
  },
): ResourceDefinition {
  return {
    names,
    fields: args.fields,
    primaryKey: 'uuid',
    timestamps: { createdAt: true, updatedAt: true },
    softDelete: args.softDelete,
    access: args.access,
    source: 'new',
    mount: resolveMount(context, { route: args.route } as CrudRequest, names.module),
    tableExport: names.pluralCamel,
    schemaFile: `${context.project.paths.schemaDir}/${names.pluralKebab}.ts`,
  };
}

/** Builds the resource definition from --table (introspection), --definition or --fields. */
export async function resolveDefinition(context: CommandContext, request: CrudRequest): Promise<ResourceDefinition> {
  if (request.table && (request.fields || request.definitionFile)) {
    throw usageError('--table cannot be combined with --fields or --definition');
  }
  if (request.fields && request.definitionFile) throw usageError('Use either --fields or --definition, not both');
  if (request.primaryKey && request.primaryKey !== 'id') {
    throw unsupported('Only a primary key named "id" is supported', 'Custom/composite key mapping is planned.');
  }
  const paths = context.project.paths;

  if (request.table) {
    const names = resourceNames(request.resource, { module: request.module });
    const schemaFile = request.schemaFile ?? paths.schemaIndex;
    return assembleTableDefinition(context, names, {
      table: request.table,
      schemaFile,
      softDelete: request.softDelete,
      access: await resolveAccess(context, request.access),
      route: request.route,
    });
  }

  const names = resourceNames(request.resource, { module: request.module });
  const parsed = await resolveFields(context, request);
  return assembleNewTableDefinition(context, names, {
    fields: parsed.fields,
    softDelete: parsed.softDelete || request.softDelete,
    access: await resolveAccess(context, request.access, parsed.access),
    route: request.route,
  });
}

function renderFiles(context: CommandContext, def: ResourceDefinition, files: CrudFiles): NewFile[] {
  const requests = renderRequests(def, files);
  return [
    ...(def.source === 'new' ? [{ path: def.schemaFile, content: renderTable(def) }] : []),
    { path: files.schemas, content: renderSchemas(def, files) },
    { path: files.dto, content: renderDto(def, files) },
    { path: files.createRequest, content: requests.create },
    { path: files.updateRequest, content: requests.update },
    { path: files.listRequest, content: requests.list },
    { path: files.response, content: renderResponse(def, files) },
    { path: files.repository, content: renderRepository(def, files) },
    { path: files.service, content: renderService(def, files) },
    { path: files.controller, content: renderController(def, files) },
    { path: files.policy, content: renderPolicy(def) },
    { path: files.routes, content: renderRoutes(def, files) },
    { path: files.provider, content: renderProvider(def, files, context.project.paths.config) },
    { path: files.index, content: renderIndex(def, files) },
    { path: files.openapi, content: renderOpenApi(def, files) },
    { path: files.test, content: renderApiTest(def, files) },
    { path: files.factory, content: renderFactory(def, files) },
  ];
}

function registrations(context: CommandContext, def: ResourceDefinition, files: CrudFiles): FileUpdate[] {
  const paths = context.project.paths;
  const { camel, pluralCamel, pluralKebab } = def.names;
  const segment = def.mount.split('/').at(-1) as string;
  const updates: FileUpdate[] = [
    {
      path: paths.providers,
      transform: (source) =>
        insertAfterMarker(
          addImport(source, `import { ${pluralCamel}Provider } from '${importPath(paths.providers, files.index)}';`),
          '@framework:providers',
          `${pluralCamel}Provider,`,
          paths.providers,
        ),
    },
    {
      path: paths.apiRoutes,
      transform: (source) => {
        if (source.includes(`.route('/${segment}'`)) {
          throw usageError(`Route collision: ${def.mount} is already mounted in ${paths.apiRoutes}`);
        }
        return insertAfterMarker(
          addImport(source, `import { ${camel}Routes } from '${importPath(paths.apiRoutes, files.index)}';`),
          '@framework:routes',
          `.route('/${segment}', ${camel}Routes)`,
          paths.apiRoutes,
        );
      },
    },
    {
      path: paths.openapi,
      transform: (source) =>
        insertAfterMarker(
          addImport(source, `import { ${camel}Operations } from '${importPath(paths.openapi, files.openapi)}';`),
          '@framework:openapi-operations',
          `...${camel}Operations,`,
          paths.openapi,
        ),
    },
  ];
  if (def.source === 'new') {
    updates.unshift({
      path: paths.schemaIndex,
      transform: (source) =>
        insertAfterMarker(source, '@framework:schema-exports', `export * from './${pluralKebab}';`, paths.schemaIndex),
    });
  }
  return updates;
}

/** Computes the full reviewed change set without writing anything. */
export async function planCrud(context: CommandContext, def: ResourceDefinition, force: boolean): Promise<CrudPlan> {
  const files = crudFiles(def, context.project.paths);
  if (!force && (await Bun.file(resolveInsideProject(context.root, files.index)).exists())) {
    throw usageError(
      `Module ${files.moduleDir} already exists`,
      'Choose another --module, or --force to regenerate its generator-owned files.',
    );
  }
  const changes = await buildChanges(
    context.root,
    renderFiles(context, def, files),
    registrations(context, def, files),
    force,
  );
  return {
    definition: def,
    files,
    changes,
    ...(def.source === 'new' ? { migrationName: `create-${def.names.pluralKebab}` } : {}),
  };
}

export const ENDPOINTS = (def: ResourceDefinition) =>
  [
    ['POST', def.mount, 201],
    ['GET', def.mount, 200],
    ...(def.softDelete
      ? [
          ['GET', `${def.mount}/deleted`, 200],
          ['GET', `${def.mount}/deleted/:id`, 200],
        ]
      : []),
    ['GET', `${def.mount}/:id`, 200],
    ['PATCH', `${def.mount}/:id`, 200],
    ['DELETE', `${def.mount}/:id`, 204],
    ...(def.softDelete ? [['POST', `${def.mount}/:id/restore`, 200]] : []),
  ].map(([method, route, status]) => ({ method: String(method), route: String(route), status: Number(status) }));
