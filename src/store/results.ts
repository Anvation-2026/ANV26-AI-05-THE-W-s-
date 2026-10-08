/**
 * Large analysis results do not fit in localStorage (about 5 MB), so they are kept in IndexedDB.
 * Every function is safe to call when IndexedDB is blocked or full: it reports failure instead of throwing.
 */
const DB = 'signaltwin-results-v1';
const STORE = 'results';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB is not available'));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB error'));
    req.onblocked = () => reject(new Error('IndexedDB is blocked'));
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB error'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB write was refused'));
    });
  } finally {
    db.close();
  }
}

export async function putResult(key: string, value: unknown): Promise<boolean> {
  try {
    await run('readwrite', (s) => s.put(value, key));
    return true;
  } catch {
    return false;
  }
}

export async function getResult<T>(key: string): Promise<T | null> {
  try {
    const v = await run<T | undefined>('readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
    return v ?? null;
  } catch {
    return null;
  }
}

export async function deleteResult(key: string): Promise<void> {
  try {
    await run('readwrite', (s) => s.delete(key));
  } catch {
    /* nothing to delete */
  }
}

export async function clearResults(): Promise<void> {
  try {
    await run('readwrite', (s) => s.clear());
  } catch {
    /* nothing to clear */
  }
}
