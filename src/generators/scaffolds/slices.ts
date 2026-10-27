import type { CommandContext } from '../../command';
import { usageError } from '../../errors';
import type { ResourceDefinition } from '../crud/definition';
import { type CrudFiles, crudFiles } from '../crud/files';
import { assembleNewTableDefinition, assembleTableDefinition, resolveAccess, resolveFields } from '../crud/generate';
import {
  renderController,
  renderPolicy,
  renderRepository,
  renderRequests,
  renderResponse,
  renderService,
} from '../crud/templates-layers';
import { renderDto, renderTable } from '../crud/templates-schema';
import { type ResourceNames, resourceNames } from '../naming';
import { assertPrerequisites, type FileUpdate, type NewFile } from '../plan';
import { insertAfterMarker } from '../registration';

export type SliceKind = 'controller' | 'dto' | 'policy' | 'request' | 'repository' | 'response' | 'schema' | 'service';

export interface SliceRequest {
  readonly resource: string;
  readonly module?: string;
  readonly table?: string;
  readonly schemaFile?: string;
  readonly softDelete: boolean;
  readonly access?: string;
  readonly fields?: string;
  readonly definitionFile?: string;
}

export interface SlicePlan {
  readonly files: readonly NewFile[];
  readonly updates: readonly FileUpdate[];
  /** Printed after a successful write: how to wire the artifact. */
  readonly hint?: string;
}

const REQUEST_KINDS = ['create', 'update', 'list'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

/** The command that creates each sibling artifact, shown when it is missing. */
const CRUD_HINT = 'make:crud <Resource>';
const need = (path: string, command: string) => ({ path, command });

/**
 * Single slices render one artifact of the make:crud pipeline through the
 * same renderers and definition builders, so output stays byte-identical to
 * a whole-module generation. Table-coupled slices introspect an existing
 * Drizzle export; access only matters to policies, so it defaults to public.
 */
async function tableSlice(
  context: CommandContext,
  names: ResourceNames,
  request: SliceRequest,
): Promise<ResourceDefinition> {
  return assembleTableDefinition(context, names, {
    table: request.table ?? names.pluralCamel,
    schemaFile: request.schemaFile ?? context.project.paths.schemaIndex,
    softDelete: request.softDelete,
    access: 'public',
  });
}

/** Computes the single-artifact change set for one slice of the CRUD pipeline. */
export async function planSlice(
  context: CommandContext,
  kind: SliceKind,
  request: SliceRequest,
  options: { readonly requestKind?: string },
): Promise<SlicePlan> {
  const paths = context.project.paths;
  const names = resourceNames(request.resource, { module: request.module });
  const files: CrudFiles = crudFiles({ names }, paths);

  if (kind === 'schema') {
    if (request.table) throw usageError('make:schema authors a new table; use the default (no --table)');
    const parsed = await resolveFields(context, {
      resource: request.resource,
      module: request.module,
      fields: request.fields,
      definitionFile: request.definitionFile,
      softDelete: request.softDelete,
      access: undefined,
    });
    const def = assembleNewTableDefinition(context, names, {
      fields: parsed.fields,
      softDelete: parsed.softDelete || request.softDelete,
      access: 'public',
    });
    return {
      files: [{ path: def.schemaFile, content: renderTable(def) }],
      updates: [
        {
          path: paths.schemaIndex,
          transform: (source) =>
            insertAfterMarker(
              source,
              '@framework:schema-exports',
              `export * from './${names.pluralKebab}';`,
              paths.schemaIndex,
            ),
        },
      ],
      hint: `Generate its migration with \`db:generate --name create-${names.pluralKebab}\`.`,
    };
  }

  if (kind === 'policy') {
    // Policies stand alone: the table may not exist yet when access is authored first.
    const def: ResourceDefinition = {
      names,
      fields: [],
      primaryKey: 'uuid',
      timestamps: { createdAt: false, updatedAt: false },
      softDelete: false,
      access: await resolveAccess(context, request.access),
      source: 'existing',
      mount: `${context.project.apiPrefix}/${names.module}`,
      tableExport: names.pluralCamel,
      schemaFile: paths.schemaIndex,
    };
    return { files: [{ path: files.policy, content: renderPolicy(def) }], updates: [] };
  }

  const def = await tableSlice(context, names, request);

  switch (kind) {
    case 'repository':
      return {
        files: [{ path: files.repository, content: renderRepository(def, files) }],
        updates: [],
        hint: `Bind ${names.pascal}Repository in the module provider (make:crud wires it for whole modules).`,
      };
    case 'dto':
      await assertPrerequisites(context.root, [need(files.schemas, CRUD_HINT)]);
      return { files: [{ path: files.dto, content: renderDto(def, files) }], updates: [] };
    case 'request': {
      const kindIndex = REQUEST_KINDS.indexOf((options.requestKind ?? 'create') as RequestKind);
      if (kindIndex === -1) {
        throw usageError(`Unknown request kind "${options.requestKind}"`, `Expected --kind ${REQUEST_KINDS.join('|')}`);
      }
      await assertPrerequisites(context.root, [
        need(files.schemas, CRUD_HINT),
        need(files.policy, 'make:policy <Resource>'),
      ]);
      const target = [files.createRequest, files.updateRequest, files.listRequest][kindIndex] as string;
      const rendered = renderRequests(def, files);
      const content = [rendered.create, rendered.update, rendered.list][kindIndex] as string;
      return { files: [{ path: target, content }], updates: [] };
    }
    case 'response':
      await assertPrerequisites(context.root, [need(files.dto, 'make:dto <Resource>')]);
      return { files: [{ path: files.response, content: renderResponse(def, files) }], updates: [] };
    case 'service':
      await assertPrerequisites(context.root, [
        need(files.repository, 'make:repository <Resource>'),
        need(files.dto, 'make:dto <Resource>'),
      ]);
      return { files: [{ path: files.service, content: renderService(def, files) }], updates: [] };
    case 'controller':
      await assertPrerequisites(context.root, [
        need(files.service, 'make:service <Resource>'),
        need(files.response, 'make:response <Resource>'),
        need(files.dto, 'make:dto <Resource>'),
      ]);
      return { files: [{ path: files.controller, content: renderController(def, files) }], updates: [] };
  }
}
