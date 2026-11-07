import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../../..');

/** The generated-app template pins this so `cli --version` reports truthfully. */
const TEMPLATE_PATH = join(ROOT, 'packages/cli/src/generators/app/templates.ts');
const BIN_PATH = join(ROOT, 'packages/cli/src/bin.ts');

describe('version sync', () => {
  test('generated-app template frameworkVersion matches the root package version', () => {
    const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
    const pins = [...readFileSync(TEMPLATE_PATH, 'utf8').matchAll(/frameworkVersion:\s*'([^']+)'/g)].map(
      (match) => match[1],
    );
    expect(pins.length).toBeGreaterThan(0);
    for (const pin of pins) {
      expect(pin).toBe(version);
    }
  });

  test('@framework/cli exposes standalone bin entrypoints and keeps version pins aligned', () => {
    const cliManifest = JSON.parse(readFileSync(join(ROOT, 'packages/cli/package.json'), 'utf8')) as {
      bin?: Record<string, string>;
    };
    expect(cliManifest.bin).toMatchObject({
      framework: './src/bin.ts',
      'framework-cli': './src/bin.ts',
      'hono-framework': './src/bin.ts',
      cli: './src/bin.ts',
    });
  });

  test('every CLI version pin and workspace package matches the root package version', () => {
    const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
    const pinFiles = [
      TEMPLATE_PATH,
      BIN_PATH,
      ...readdirSync(join(ROOT, 'apps'))
        .map((name) => join(ROOT, 'apps', name, 'bin', 'cli.ts'))
        .filter((path) => Bun.file(path).size > 0),
    ];
    for (const path of pinFiles) {
      for (const match of readFileSync(path, 'utf8').matchAll(/(frameworkVersion|cliVersion):\s*'([^']+)'/g)) {
        expect(`${path} ${match[1]}=${match[2]}`).toBe(`${path} ${match[1]}=${version}`);
      }
    }
    for (const name of readdirSync(join(ROOT, 'packages'))) {
      const manifest = JSON.parse(readFileSync(join(ROOT, 'packages', name, 'package.json'), 'utf8')) as {
        version?: string;
      };
      expect(`${name}@${manifest.version}`).toBe(`${name}@${version}`);
    }
  });
});
