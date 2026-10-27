import type { ProjectPaths } from '../../project';
import type { ResourceDefinition } from './definition';

/** Project-relative locations of every artifact generated for one resource. */
export interface CrudFiles {
  readonly moduleDir: string;
  readonly schemas: string;
  readonly dto: string;
  readonly createRequest: string;
  readonly updateRequest: string;
  readonly listRequest: string;
  readonly response: string;
  readonly repository: string;
  readonly service: string;
  readonly controller: string;
  readonly policy: string;
  readonly routes: string;
  readonly provider: string;
  readonly index: string;
  readonly openapi: string;
  readonly test: string;
  readonly factory: string;
  readonly testSupport: string;
}

export function crudFiles(def: Pick<ResourceDefinition, 'names'>, paths: ProjectPaths): CrudFiles {
  const { kebab, pluralKebab, module } = def.names;
  const dir = `${paths.modules}/${module}`;
  return {
    moduleDir: dir,
    schemas: `${dir}/schemas.ts`,
    dto: `${dir}/dto/${kebab}.dto.ts`,
    createRequest: `${dir}/requests/create-${kebab}.request.ts`,
    updateRequest: `${dir}/requests/update-${kebab}.request.ts`,
    listRequest: `${dir}/requests/list-${pluralKebab}.request.ts`,
    response: `${dir}/responses/${kebab}.response.ts`,
    repository: `${dir}/repositories/${kebab}.repository.ts`,
    service: `${dir}/services/${kebab}.service.ts`,
    controller: `${dir}/controllers/${kebab}.controller.ts`,
    policy: `${dir}/policies/${kebab}.policy.ts`,
    routes: `${dir}/routes.ts`,
    provider: `${dir}/provider.ts`,
    index: `${dir}/index.ts`,
    openapi: `${dir}/openapi.ts`,
    test: `${dir}/tests/${kebab}.crud.api.test.ts`,
    factory: `${paths.factories}/${kebab}.factory.ts`,
    testSupport: paths.testSupport,
  };
}
