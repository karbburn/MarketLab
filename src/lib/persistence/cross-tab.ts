/**
 * Cross-tab write notification.
 *
 * Tabs share one IndexedDB database but keep independent in-memory snapshots.
 * Broadcasting only after a write commits lets every other tab re-read instead
 * of drifting until the next reload. `BroadcastChannel` is preferred; the
 * `storage` event is the fallback where it is unavailable.
 */

export interface CrossTabChannel {
  publish(): void;
  subscribe(listener: () => void): () => void;
  close(): void;
}

export function createCrossTabChannel(name = 'marketlab'): CrossTabChannel {
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };

  let channel: BroadcastChannel | null = null;
  if (typeof BroadcastChannel === 'function') {
    channel = new BroadcastChannel(name);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data && typeof event.data === 'object' && (event.data as { type?: unknown }).type === 'changed') {
        notify();
      }
    };
  }

  let storageKey: string | null = null;
  let storageListener: ((event: StorageEvent) => void) | null = null;
  if (!channel && typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
    storageKey = `${name}:revision`;
    storageListener = (event) => {
      if (event.key === storageKey) notify();
    };
    window.addEventListener('storage', storageListener);
  }

  return {
    publish() {
      if (channel) {
        channel.postMessage({ type: 'changed' });
        return;
      }
      if (storageKey) {
        try {
          localStorage.setItem(storageKey, `${Date.now()}:${Math.random()}`);
        } catch {
          // Storage may be full or blocked; the write already succeeded, and the
          // next reload still reflects it.
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      listeners.clear();
      channel?.close();
      if (storageListener && typeof window !== 'undefined') window.removeEventListener('storage', storageListener);
    },
  };
}
