/**
 * Local persistence.
 *
 * The primary backend is IndexedDB. When IndexedDB is unavailable (for example in
 * a plain Node test process, or a browser with storage disabled) an in-memory
 * adapter is used instead so the application still runs. The in-memory adapter
 * never pretends to be durable; callers can read `adapter.kind` and tell the user
 * that their work will not survive a reload.
 */

import { createCrossTabChannel } from './cross-tab';

export type StoreName =
  | 'instruments'
  | 'datasets'
  | 'bars'
  | 'workspaces'
  | 'watchlists'
  | 'screeners'
  | 'backtests'
  | 'chartTemplates'
  | 'researchRuns'
  | 'preferences'
  | 'settings';

export const STORE_NAMES: StoreName[] = [
  'instruments',
  'datasets',
  'bars',
  'workspaces',
  'watchlists',
  'screeners',
  'backtests',
  'chartTemplates',
  'researchRuns',
  'preferences',
  'settings',
];

export interface Identified {
  id: string;
}

/**
 * The operations available inside one adapter transaction. Reads see writes
 * made earlier in the same transaction; nothing is durable until the callback
 * passed to `transaction` resolves.
 */
export interface PersistenceTransaction {
  list<T>(store: StoreName): Promise<T[]>;
  get<T>(store: StoreName, id: string): Promise<T | undefined>;
  put<T extends Identified>(store: StoreName, value: T): Promise<void>;
  putMany<T extends Identified>(store: StoreName, values: readonly T[]): Promise<void>;
  remove(store: StoreName, id: string): Promise<void>;
  clear(store: StoreName): Promise<void>;
}

export interface TransactionOptions {
  /** Read-only transactions cannot write and are not broadcast to other tabs. */
  mode?: 'readonly' | 'readwrite';
  /** Set false for internal re-reads so they do not echo around other tabs. */
  notify?: boolean;
}

export interface PersistenceAdapter {
  readonly kind: 'indexeddb' | 'memory';
  list<T>(store: StoreName): Promise<T[]>;
  get<T>(store: StoreName, id: string): Promise<T | undefined>;
  put<T extends Identified>(store: StoreName, value: T): Promise<void>;
  putMany<T extends Identified>(store: StoreName, values: readonly T[]): Promise<void>;
  remove(store: StoreName, id: string): Promise<void>;
  clear(store: StoreName): Promise<void>;
  /**
   * Runs `operation` atomically over `stores`. A throw rolls every write back.
   * IndexedDB uses one native transaction; the memory adapter stages copies.
   */
  transaction<T>(
    stores: readonly StoreName[],
    operation: (tx: PersistenceTransaction) => Promise<T> | T,
    options?: TransactionOptions,
  ): Promise<T>;
  /** Fires after a committed write from another tab. Absent on the memory adapter. */
  subscribe?(listener: () => void): () => void;
}

const DB_NAME = 'marketlab';
// v2 adds durable stores for chart templates. v3 adds saved research runs. The
// upgrades only create stores; existing records are not rewritten.
const DB_VERSION = 3;

export function createMemoryAdapter(): PersistenceAdapter {
  const tables = new Map<StoreName, Map<string, unknown>>();
  const table = (store: StoreName) => {
    let existing = tables.get(store);
    if (!existing) {
      existing = new Map<string, unknown>();
      tables.set(store, existing);
    }
    return existing;
  };
  const clone = <T,>(value: T): T => (typeof structuredClone === 'function' ? structuredClone(value) : (JSON.parse(JSON.stringify(value)) as T));
  return {
    kind: 'memory',
    async list<T>(store: StoreName): Promise<T[]> {
      return [...table(store).values()].map((value) => clone(value as T));
    },
    async get<T>(store: StoreName, id: string): Promise<T | undefined> {
      const value = table(store).get(id);
      return value === undefined ? undefined : clone(value as T);
    },
    async put<T extends Identified>(store: StoreName, value: T): Promise<void> {
      table(store).set(value.id, clone(value));
    },
    async putMany<T extends Identified>(store: StoreName, values: readonly T[]): Promise<void> {
      for (const value of values) table(store).set(value.id, clone(value));
    },
    async remove(store: StoreName, id: string): Promise<void> {
      table(store).delete(id);
    },
    async clear(store: StoreName): Promise<void> {
      table(store).clear();
    },
    async transaction<T>(
      stores: readonly StoreName[],
      operation: (tx: PersistenceTransaction) => Promise<T> | T,
    ): Promise<T> {
      // Stage complete copies of the touched tables. A thrown operation simply
      // drops the staged maps, so earlier writes are never visible.
      const staged = new Map<StoreName, Map<string, unknown>>();
      for (const store of new Set(stores)) staged.set(store, new Map(table(store)));
      const stagedTable = (store: StoreName) => {
        const found = staged.get(store);
        if (!found) throw new Error(`Store "${store}" is not part of this transaction.`);
        return found;
      };
      const tx: PersistenceTransaction = {
        async list<U>(store: StoreName): Promise<U[]> {
          return [...stagedTable(store).values()].map((value) => clone(value as U));
        },
        async get<U>(store: StoreName, id: string): Promise<U | undefined> {
          const value = stagedTable(store).get(id);
          return value === undefined ? undefined : clone(value as U);
        },
        async put<U extends Identified>(store: StoreName, value: U): Promise<void> {
          stagedTable(store).set(value.id, clone(value));
        },
        async putMany<U extends Identified>(store: StoreName, values: readonly U[]): Promise<void> {
          for (const value of values) stagedTable(store).set(value.id, clone(value));
        },
        async remove(store: StoreName, id: string): Promise<void> {
          stagedTable(store).delete(id);
        },
        async clear(store: StoreName): Promise<void> {
          stagedTable(store).clear();
        },
      };
      const result = await operation(tx);
      for (const [store, records] of staged) tables.set(store, records);
      return result;
    },
  };
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    // A blocked open may still complete after the caller has fallen back to
    // memory. A late success must close its connection: this tab will not use
    // it, and leaving it open would block the next schema upgrade elsewhere.
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    open.onupgradeneeded = () => {
      const db = open.result;
      for (const store of STORE_NAMES) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: 'id' });
      }
    };
    open.onsuccess = () => {
      const db = open.result;
      if (settled) {
        db.close();
        return;
      }
      settled = true;
      // Another tab is upgrading the schema. Keeping this connection open would
      // block it; close and reload so this tab reads the new version instead of
      // continuing on a stale snapshot.
      db.onversionchange = () => {
        db.close();
        if (typeof window !== 'undefined') window.location.reload();
      };
      resolve(db);
    };
    open.onerror = () => fail(open.error ?? new Error('Could not open IndexedDB'));
    // A pending schema upgrade held by another tab can otherwise leave this
    // promise unsettled forever, freezing the loading gate with no message.
    // Rejecting falls back to the in-memory adapter, whose banner says that
    // changes will not persist instead of hanging silently.
    open.onblocked = () =>
      fail(new Error('The local database upgrade is blocked by another tab. Close it and reload.'));
  });
}

function indexedTransaction(tx: IDBTransaction): PersistenceTransaction {
  return {
    async list<T>(store: StoreName): Promise<T[]> {
      return request<T[]>(tx.objectStore(store).getAll());
    },
    async get<T>(store: StoreName, id: string): Promise<T | undefined> {
      return (await request<T | undefined>(tx.objectStore(store).get(id))) ?? undefined;
    },
    async put<T extends Identified>(store: StoreName, value: T): Promise<void> {
      await request(tx.objectStore(store).put(value));
    },
    async putMany<T extends Identified>(store: StoreName, values: readonly T[]): Promise<void> {
      const objectStore = tx.objectStore(store);
      for (const value of values) await request(objectStore.put(value));
    },
    async remove(store: StoreName, id: string): Promise<void> {
      await request(tx.objectStore(store).delete(id));
    },
    async clear(store: StoreName): Promise<void> {
      await request(tx.objectStore(store).clear());
    },
  };
}

export function createIndexedDbAdapter(db: IDBDatabase): PersistenceAdapter {
  const channel = createCrossTabChannel('marketlab');
  const publish = () => channel.publish();
  return {
    kind: 'indexeddb',
    async list<T>(store: StoreName): Promise<T[]> {
      const tx = db.transaction(store, 'readonly');
      const result = await request<T[]>(tx.objectStore(store).getAll());
      return result;
    },
    async get<T>(store: StoreName, id: string): Promise<T | undefined> {
      const tx = db.transaction(store, 'readonly');
      return (await request<T | undefined>(tx.objectStore(store).get(id))) ?? undefined;
    },
    async put<T extends Identified>(store: StoreName, value: T): Promise<void> {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value);
      await transactionDone(tx);
      publish();
    },
    async putMany<T extends Identified>(store: StoreName, values: readonly T[]): Promise<void> {
      if (values.length === 0) return;
      const tx = db.transaction(store, 'readwrite');
      const objectStore = tx.objectStore(store);
      for (const value of values) objectStore.put(value);
      await transactionDone(tx);
      publish();
    },
    async remove(store: StoreName, id: string): Promise<void> {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(id);
      await transactionDone(tx);
      publish();
    },
    async clear(store: StoreName): Promise<void> {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).clear();
      await transactionDone(tx);
      publish();
    },
    async transaction<T>(
      stores: readonly StoreName[],
      operation: (tx: PersistenceTransaction) => Promise<T> | T,
      options?: TransactionOptions,
    ): Promise<T> {
      const unique = [...new Set(stores)];
      if (unique.length === 0) throw new Error('A persistence transaction needs at least one store.');
      const mode = options?.mode ?? 'readwrite';
      const tx = db.transaction(unique, mode);
      const done = transactionDone(tx);
      // Attach a handler now so an abort triggered by the operation is not an
      // unhandled rejection before the `await done` below.
      void done.catch(() => undefined);
      try {
        const result = await operation(indexedTransaction(tx));
        await done;
        if (mode === 'readwrite' && options?.notify !== false) publish();
        return result;
      } catch (error) {
        try {
          tx.abort();
        } catch {
          // The transaction already aborted or completed; the original error wins.
        }
        throw error;
      }
    },
    subscribe(listener: () => void): () => void {
      return channel.subscribe(listener);
    },
  };
}

export async function createPersistence(): Promise<PersistenceAdapter> {
  try {
    if (typeof indexedDB === 'undefined') return createMemoryAdapter();
    const db = await openDatabase();
    return createIndexedDbAdapter(db);
  } catch {
    return createMemoryAdapter();
  }
}
