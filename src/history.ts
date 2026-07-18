const DB_NAME = 'gemtavern-rp-engine';
const DB_VERSION = 2;
const HISTORY_STORE = 'history';
const REGISTRY_STORE = 'models';

export function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (db.objectStoreNames.contains(HISTORY_STORE)) db.deleteObjectStore(HISTORY_STORE);
      if (!db.objectStoreNames.contains(REGISTRY_STORE)) db.createObjectStore(REGISTRY_STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open IndexedDB.'));
  });
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB operation failed.'));
  });
}

export async function getRegistryRecord<T>(id: string) {
  const db = await openDatabase();
  return requestResult(db.transaction(REGISTRY_STORE).objectStore(REGISTRY_STORE).get(id)) as Promise<T | undefined>;
}

export async function putRegistryRecord<T>(value: T) {
  const db = await openDatabase();
  const store = db.transaction(REGISTRY_STORE, 'readwrite').objectStore(REGISTRY_STORE);
  await requestResult(store.put(value));
}

export async function deleteRegistryRecord(id: string) {
  const db = await openDatabase();
  const store = db.transaction(REGISTRY_STORE, 'readwrite').objectStore(REGISTRY_STORE);
  await requestResult(store.delete(id));
}
