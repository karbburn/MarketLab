/**
 * Local persistence.
 *
 * The primary backend is IndexedDB. When IndexedDB is unavailable (for example in
 * a plain Node test process, or a browser with storage disabled) an in-memory
 * adapter is used instead so the application still runs. The in-memory adapter
 * never pretends to be durable; callers can read `adapter.kind` and tell the user
 * that their work will not survive a reload.
 */

export type StoreName =
  | 'instruments'
  | 'datasets'
  | 'bars'
  | 'workspaces'
  | 'watchlists'
  | 'screeners'
  | 'backtests'
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
  'preferences',
  'settings',
];

export interface Identified {
  id: string;
}

export interface PersistenceAdapter {
  readonly kind: 'indexeddb' | 'memory';
  list<T>(store: StoreName): Promise<T[]>;
  get<T>(store: StoreName, id: string): Promise<T | undefined>;
  put<T extends Identified>(store: StoreName, value: T): Promise<void>;
  putMany<T extends Identified>(store: StoreName, values: readonly T[]): Promise<void>;
  remove(store: StoreName, id: string): Promise<void>;
  clear(store: StoreName): Promise<void>;
}

const DB_NAME = 'marketlab';
const DB_VERSION = 1;

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
    open.onupgradeneeded = () => {
      const db = open.result;
      for (const store of STORE_NAMES) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: 'id' });
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error('Could not open IndexedDB'));
  });
}

export function createIndexedDbAdapter(db: IDBDatabase): PersistenceAdapter {
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
    },
    async putMany<T extends Identified>(store: StoreName, values: readonly T[]): Promise<void> {
      if (values.length === 0) return;
      const tx = db.transaction(store, 'readwrite');
      const objectStore = tx.objectStore(store);
      for (const value of values) objectStore.put(value);
      await transactionDone(tx);
    },
    async remove(store: StoreName, id: string): Promise<void> {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(id);
      await transactionDone(tx);
    },
    async clear(store: StoreName): Promise<void> {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).clear();
      await transactionDone(tx);
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
