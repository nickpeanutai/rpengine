const DB_NAME = 'gemtavern-rp-engine';
const DB_VERSION = 3;
const HISTORY_STORE = 'history';
const REGISTRY_STORE = 'models';
const HANDLE_STORE = 'transport-handles';

export function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (db.objectStoreNames.contains(HISTORY_STORE)) db.deleteObjectStore(HISTORY_STORE);
      if (!db.objectStoreNames.contains(REGISTRY_STORE)) db.createObjectStore(REGISTRY_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(HANDLE_STORE)) db.createObjectStore(HANDLE_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open IndexedDB.'));
  });
}

export async function getTransportHandle(id: string) {
  const db = await openDatabase();
  return requestResult(db.transaction(HANDLE_STORE).objectStore(HANDLE_STORE).get(id)) as Promise<FileSystemDirectoryHandle | undefined>;
}

export async function putTransportHandle(id: string, handle: FileSystemDirectoryHandle) {
  const db = await openDatabase();
  await requestResult(db.transaction(HANDLE_STORE, 'readwrite').objectStore(HANDLE_STORE).put(handle, id));
}

export async function deleteTransportHandle(id: string) {
  const db = await openDatabase();
  await requestResult(db.transaction(HANDLE_STORE, 'readwrite').objectStore(HANDLE_STORE).delete(id));
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
