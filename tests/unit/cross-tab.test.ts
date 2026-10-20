import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCrossTabChannel } from '../../src/lib/persistence/cross-tab';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cross-tab write notification', () => {
  it('notifies another channel with the same name', async () => {
    const name = `marketlab-test-${Date.now()}-${Math.random()}`;
    const writer = createCrossTabChannel(name);
    const reader = createCrossTabChannel(name);
    const received = new Promise<void>((resolve) => reader.subscribe(resolve));

    writer.publish();
    await received;

    writer.close();
    reader.close();
  });

  it('falls back to a storage write and storage events when BroadcastChannel is absent', () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const writes = new Map<string, string>();
    let storageListener: ((event: StorageEvent) => void) | null = null;
    vi.stubGlobal('window', {
      addEventListener: (type: string, listener: (event: StorageEvent) => void) => {
        if (type === 'storage') storageListener = listener;
      },
      removeEventListener: () => undefined,
    });
    vi.stubGlobal('localStorage', {
      setItem: (key: string, value: string) => writes.set(key, value),
    });

    const channel = createCrossTabChannel('marketlab-fallback');
    let notifications = 0;
    channel.subscribe(() => {
      notifications += 1;
    });

    channel.publish();
    expect(writes.has('marketlab-fallback:revision')).toBe(true);
    expect(notifications).toBe(0);

    (storageListener as ((event: StorageEvent) => void) | null)?.({ key: 'marketlab-fallback:revision' } as StorageEvent);
    expect(notifications).toBe(1);
    channel.close();
  });
});
