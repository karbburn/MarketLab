import { describe, expect, it } from 'vitest';
import { buildSampleBundles } from '../../src/data/sample';

describe('sample dataset validation summaries', () => {
  const bundles = buildSampleBundles();

  it('reports the real missing-volume row count for the volume-less index', () => {
    const index = bundles.find((bundle) => !bundle.dataset.hasVolume);
    expect(index).toBeDefined();
    if (!index) return;
    expect(index.bars.every((bar) => bar.volume === null)).toBe(true);
    expect(index.dataset.validation.missingVolumeRows).toBe(index.bars.length);
    expect(index.dataset.validation.missingVolumeRows).toBe(index.dataset.rowCount);
  });

  it('reports zero missing-volume rows for datasets that do have volume', () => {
    for (const bundle of bundles.filter((entry) => entry.dataset.hasVolume)) {
      expect(bundle.dataset.validation.missingVolumeRows).toBe(0);
    }
  });
});
