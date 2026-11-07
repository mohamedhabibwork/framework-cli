import { describe, expect, test } from 'bun:test';
import { appTemplateFiles } from '../src/generators/app/templates';

const files = appTemplateFiles({ name: 'sample-app', className: 'SampleApp', apiTitle: 'Sample App API' });

describe('generated test environments', () => {
  // These suites build config from an explicit env object, so `.env.test` never
  // reaches them; the default redis driver would dial the default Redis URL.
  test.each(['tests/support.ts', 'tests/health.api.test.ts'])('%s runs the cache on the memory driver', (path) => {
    const file = files.find((candidate) => candidate.path === path);

    expect(file?.content).toContain("CACHE_DRIVER: 'memory'");
  });

  test('tests/support.ts forwards REDIS_URL so queues reach the named Redis', () => {
    const file = files.find((candidate) => candidate.path === 'tests/support.ts');

    expect(file?.content).toContain('REDIS_URL: process.env.REDIS_URL');
  });
});
