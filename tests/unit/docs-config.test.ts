import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function read(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}

/**
 * Guards the public claims that drifted before: docs that described bundled
 * sample data, an unshipped command palette and a smaller route set than the
 * app actually serves. These are plain text checks on the shipped artifacts,
 * not a second copy of the documentation.
 */
describe('documentation and configuration claims', () => {
  it('describes an empty library instead of bundled sample data', () => {
    const llms = read('public/llms.txt').toLowerCase();
    expect(llms).toContain('ships no bundled or sample market data');
    expect(llms).not.toContain('bundled sample data is deterministic');
    expect(llms).not.toContain('bundled samples');
  });

  it('lists the field guide among the agent routes', () => {
    expect(read('public/llms.txt')).toContain('/learn');
  });

  it('keeps bundled-sample wording out of the agent catalog queries', () => {
    const catalog = JSON.parse(read('public/ai-catalog.json')) as {
      entries: { representativeQueries: string[] }[];
    };
    const queries = catalog.entries
      .flatMap((entry) => entry.representativeQueries)
      .join(' ')
      .toLowerCase();
    expect(queries).not.toContain('bundled');
    expect(queries).not.toContain('sample data real');
  });

  it('documents the shipped command palette and field guide', () => {
    const readme = read('README.md');
    expect(readme).toContain('Command palette');
    expect(readme).toContain('/learn');
    expect(readme).not.toContain('A global command palette (Ctrl/Cmd-K) for datasets');
  });

  it('builds before E2E and pins the ports the service allow-list expects', () => {
    const pkg = JSON.parse(read('package.json')) as {
      engines: { node: string };
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['test:e2e']).toContain('npm run build');
    expect(pkg.engines.node).toBe('^20.19.0 || >=22.12.0');

    const vite = read('vite.config.ts');
    expect(vite.match(/strictPort: true/g)).toHaveLength(2);
  });
});
