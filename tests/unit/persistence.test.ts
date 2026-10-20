import { describe, expect, it } from 'vitest';
import { createMemoryAdapter } from '../../src/lib/persistence/db';

interface Record {
  id: string;
  value?: number;
}

describe('memory persistence transactions', () => {
  it('commits every store only after the operation resolves', async () => {
    const adapter = createMemoryAdapter();
    await adapter.put('instruments', { id: 'i1', value: 1 });

    const result = await adapter.transaction(['instruments', 'datasets'], async (tx) => {
      await tx.put('instruments', { id: 'i2', value: 2 });
      await tx.put('datasets', { id: 'd1', value: 3 });
      // Reads inside the transaction see the staged writes.
      expect(await tx.get<Record>('instruments', 'i2')).toEqual({ id: 'i2', value: 2 });
      expect(await tx.list<Record>('datasets')).toEqual([{ id: 'd1', value: 3 }]);
      return 'ok';
    });

    expect(result).toBe('ok');
    expect((await adapter.list<Record>('instruments')).map((entry) => entry.id).sort()).toEqual(['i1', 'i2']);
    expect(await adapter.list<Record>('datasets')).toEqual([{ id: 'd1', value: 3 }]);
  });

  it('rolls back writes and removals when the operation throws', async () => {
    const adapter = createMemoryAdapter();
    await adapter.put('instruments', { id: 'i1', value: 1 });
    await adapter.put('datasets', { id: 'd1', value: 1 });

    await expect(
      adapter.transaction(['instruments', 'datasets'], async (tx) => {
        await tx.remove('instruments', 'i1');
        await tx.put('instruments', { id: 'i2', value: 2 });
        await tx.clear('datasets');
        throw new Error('quota exceeded');
      }),
    ).rejects.toThrow('quota exceeded');

    expect(await adapter.list<Record>('instruments')).toEqual([{ id: 'i1', value: 1 }]);
    expect(await adapter.list<Record>('datasets')).toEqual([{ id: 'd1', value: 1 }]);
  });

  it('does not expose stores that were not included in the transaction', async () => {
    const adapter = createMemoryAdapter();
    await expect(
      adapter.transaction(['instruments'], (tx) => tx.list('datasets')),
    ).rejects.toThrow('not part of this transaction');
  });

  it('keeps the previous snapshot when a replace-style transaction fails midway', async () => {
    const adapter = createMemoryAdapter();
    await adapter.put('datasets', { id: 'old-a', value: 1 });
    await adapter.put('datasets', { id: 'old-b', value: 2 });
    await adapter.put('bars', { id: 'old-a', value: 10 });

    await expect(
      adapter.transaction(['datasets', 'bars'], async (tx) => {
        await tx.clear('datasets');
        await tx.put('datasets', { id: 'new-a', value: 3 });
        await tx.clear('bars');
        await tx.put('bars', { id: 'new-a', value: 30 });
        throw new Error('write failed');
      }),
    ).rejects.toThrow('write failed');

    expect((await adapter.list<Record>('datasets')).map((entry) => entry.id).sort()).toEqual(['old-a', 'old-b']);
    expect(await adapter.list<Record>('bars')).toEqual([{ id: 'old-a', value: 10 }]);
  });
});
