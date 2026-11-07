import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { checkOperations } from '@framework/openapi';
import { stringOption } from '../args';
import { defineCommand } from '../command';
import { failure } from '../errors';
import { resolveInsideProject } from '../generators/paths';

export const openapiCommands = [
  defineCommand({
    name: 'openapi:generate',
    group: 'openapi',
    status: 'implemented',
    description: "Emit the documented routes' OpenAPI 3.1 specification",
    options: [
      { name: 'output', type: 'string', placeholder: '<path>', description: 'Write to a project-relative file' },
      { name: 'api-version', type: 'string', placeholder: '<version>', description: 'info.version (default 1.0.0)' },
    ],
    async run({ options }, context) {
      const document = context.project.openapi().build(stringOption(options, 'api-version'));
      const output = stringOption(options, 'output');
      if (!output) {
        context.print(JSON.stringify(document, null, 2));
        return { data: document };
      }
      const target = resolveInsideProject(context.root, output);
      await mkdir(dirname(target), { recursive: true });
      await Bun.write(target, `${JSON.stringify(document, null, 2)}\n`);
      context.print(`Wrote ${output}`);
      return { data: { output } };
    },
  }),
  defineCommand({
    name: 'openapi:check',
    group: 'openapi',
    status: 'implemented',
    description: 'Validate that documented operations and registered routes match',
    options: [
      { name: 'spec', type: 'string', placeholder: '<path>', description: 'Also compare with a committed spec file' },
    ],
    async run({ options }, context) {
      const config = await context.project.loadConfig(context.envFile);
      const openapi = context.project.openapi();
      const routes = (await context.project.routes(config)).filter((r) => r.path.startsWith(context.project.apiPrefix));
      const problems = checkOperations(routes, openapi.operations);

      const spec = stringOption(options, 'spec');
      if (spec) {
        const file = Bun.file(resolveInsideProject(context.root, spec));
        if (!(await file.exists())) {
          problems.push(`Spec file not found: ${spec}`);
        } else {
          const committed = (await file.json()) as { info?: { version?: string } };
          if (JSON.stringify(committed) !== JSON.stringify(openapi.build(committed.info?.version))) {
            problems.push(`Committed spec ${spec} is out of date; run openapi:generate --output ${spec}`);
          }
        }
      }
      if (problems.length > 0) {
        for (const problem of problems) context.log(problem);
        throw failure('OPENAPI_DRIFT', `${problems.length} OpenAPI problem(s) found`);
      }
      context.print(`OpenAPI is consistent with ${routes.length} routes.`);
      return { data: { routes: routes.length, operations: openapi.operations.length } };
    },
  }),
];
