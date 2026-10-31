import { describe, expect, test } from 'bun:test';
import { frameworkCommands } from '../src/commands';
import type { ResourceDefinition } from '../src/generators/crud/definition';
import { crudFiles } from '../src/generators/crud/files';
import { resourceNames } from '../src/generators/naming';
import { renderModel } from '../src/generators/scaffolds/templates-model';
import type { ProjectPaths } from '../src/project';

const PATHS: ProjectPaths = {
  modules: 'app/modules',
  schemaDir: 'database/schema',
  schemaIndex: 'database/schema/index.ts',
  factories: 'database/factories',
  migrations: 'database/migrations',
  apiRoutes: 'routes/api.ts',
  providers: 'bootstrap/providers.ts',
  middleware: 'bootstrap/middleware.ts',
  openapi: 'bootstrap/openapi.ts',
  config: 'config/index.ts',
  testSupport: 'tests/support.ts',
};

function definition(overrides: Partial<ResourceDefinition> = {}): ResourceDefinition {
  return {
    names: resourceNames('Product', {}),
    fields: [
      { name: 'name', column: 'name', type: 'text', nullable: false, hasDefault: false },
      { name: 'price', column: 'price', type: 'numeric', nullable: false, hasDefault: false },
    ],
    primaryKey: 'uuid',
    timestamps: { createdAt: true, updatedAt: true },
    softDelete: false,
    access: 'public',
    source: 'existing',
    mount: '/api/v1/products',
    tableExport: 'products',
    schemaFile: 'database/schema/index.ts',
    ...overrides,
  };
}

describe('make:model template', () => {
  test('derives metadata from the Drizzle table instead of redeclaring columns', () => {
    const def = definition();
    const source = renderModel(def, crudFiles(def, PATHS));

    expect(source).toContain("import { getTableColumns, getTableName } from 'drizzle-orm';");
    expect(source).toMatch(/import \{ products \} from '.*database\/schema/);
    expect(source).toContain('export const ProductModel');
    expect(source).toContain('getTableName(products)');
    expect(source).toContain('getTableColumns(products)');
    expect(source).toContain("primaryKey: 'id'");
    expect(source).toContain('export type ProductRecord = SelectOf<typeof products>;');
    // Nothing may restate a column: the table is the only schema source.
    expect(source).not.toContain("'price'");
    expect(source).not.toContain("'name'");
  });

  test('serializes Date values to ISO-8601 and reports soft-delete support', () => {
    const plain = definition();
    const plainSource = renderModel(plain, crudFiles(plain, PATHS));
    expect(plainSource).toContain('softDelete: false');
    expect(plainSource).toContain('toISOString()');

    const soft = definition({ softDelete: true });
    expect(renderModel(soft, crudFiles(soft, PATHS))).toContain('softDelete: true');
  });

  test('places the model beside the module artifacts', () => {
    const def = definition();
    expect(crudFiles(def, PATHS).model).toBe('app/modules/products/models/product.model.ts');
  });

  test('is a shipped generator, not a planned stub', () => {
    const command = frameworkCommands.find((candidate) => candidate.name === 'make:model');
    expect(command?.status).toBe('implemented');
    expect(command?.group).toBe('generators');
  });
});
