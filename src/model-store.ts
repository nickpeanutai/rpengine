import { createSHA256 } from 'hash-wasm';
import { deleteRegistryRecord, getRegistryRecord, putRegistryRecord } from './history';
import { bundledModelCatalog } from './model-catalog';
import type { InstalledModel, ModelFile, ModelManifest } from './types';

interface StorageManagerWithDirectory extends StorageManager {
  getDirectory(): Promise<FileSystemDirectoryHandle>;
}

export interface ModelDownloadProgress {
  downloadedBytes: number;
  totalBytes: number;
  currentFile: string;
  isResuming: boolean;
  bytesPerSecond: number;
  etaSeconds?: number;
}

function safeParts(path: string) {
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0 || parts.some(part => part === '.' || part === '..')) throw new Error(`Unsafe model path: ${path}`);
  return parts;
}

async function directoryFor(root: FileSystemDirectoryHandle, parts: string[], create: boolean) {
  let directory = root;
  for (const part of parts) directory = await directory.getDirectoryHandle(part, { create });
  return directory;
}

async function modelRoot() {
  const storage = navigator.storage as StorageManagerWithDirectory;
  const root = await storage.getDirectory();
  return root.getDirectoryHandle('models', { create: true });
}

async function versionDirectory(modelId: string, version: string, create: boolean) {
  const root = await modelRoot();
  const model = await root.getDirectoryHandle(modelId, { create });
  return model.getDirectoryHandle(version, { create });
}

async function fileHandle(modelId: string, version: string, path: string, create: boolean) {
  const parts = safeParts(path);
  const root = await versionDirectory(modelId, version, create);
  const directory = await directoryFor(root, parts.slice(0, -1), create);
  return directory.getFileHandle(parts.at(-1)!, { create });
}

async function digestBlob(file: Blob) {
  const hasher = await createSHA256();
  const reader = file.stream().getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    hasher.update(value);
  }
  return hasher.digest('hex');
}

export class ModelIntegrityError extends Error {}

export async function assertDownloadedFileIntegrity(handle: FileSystemFileHandle, file: ModelFile) {
  const installed = await handle.getFile();
  if (installed.size !== file.size_bytes) throw new ModelIntegrityError(`Installed size mismatch for ${file.path}.`);
  if (file.sha256 && (await digestBlob(installed)).toLowerCase() !== file.sha256.toLowerCase()) {
    throw new ModelIntegrityError(`Checksum mismatch for ${file.path}; the upstream artifact no longer matches the bundled catalog.`);
  }
}

export function assertStorageCapacity(estimate: StorageEstimate, remainingBytes: number) {
  const available = (estimate.quota ?? 0) - (estimate.usage ?? 0);
  if (estimate.quota && available < remainingBytes * 1.1) {
    throw new Error('Not enough persistent browser storage to finish this model download.');
  }
}

async function truncate(handle: FileSystemFileHandle, size: number) {
  const writable = await handle.createWritable({ keepExistingData: true });
  try { await writable.truncate(size); }
  finally { await writable.close(); }
}

export async function fetchModelManifest() {
  return bundledModelCatalog();
}

async function downloadFile(
  modelId: string,
  version: string,
  file: ModelFile,
  signal: AbortSignal,
  initialBytes: number,
  onBytes: (bytes: number) => void,
) {
  const handle = await fileHandle(modelId, version, file.path, true);
  let partialSize = Math.min(initialBytes, file.size_bytes);
  onBytes(partialSize);
  if (partialSize < file.size_bytes) partialSize = await downloadSegment(handle, file, partialSize, signal, onBytes);
  if (partialSize !== file.size_bytes) throw new Error(`Incomplete local download for ${file.path}.`);
  try {
    await assertDownloadedFileIntegrity(handle, file);
  } catch (error) {
    if (!(error instanceof ModelIntegrityError)) throw error;
    const root = await versionDirectory(modelId, version, false);
    const parts = safeParts(file.path);
    const parent = await directoryFor(root, parts.slice(0, -1), false);
    await parent.removeEntry(parts.at(-1)!);
    throw error;
  }
}

export async function downloadSegment(
  handle: FileSystemFileHandle,
  file: ModelFile,
  initialOffset: number,
  signal: AbortSignal,
  onBytes: (bytes: number) => void,
) {
  let offset = Math.max(0, initialOffset);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    signal.throwIfAborted();
    const headers = offset > 0 ? { Range: `bytes=${offset}-` } : undefined;
    const response = await fetch(file.url, { signal, headers });
    if (response.status === 416) {
      const current = Math.min((await handle.getFile()).size, file.size_bytes);
      if (current >= file.size_bytes) return file.size_bytes;
      await truncate(handle, 0);
      offset = 0;
      continue;
    }
    if (response.status !== 200 && response.status !== 206) throw new Error(`Download failed with HTTP ${response.status}.`);
    if (!response.body) throw new Error('The model download response did not include a readable stream.');

    let writeOffset = offset;
    if (offset > 0 && response.status === 200) {
      await truncate(handle, 0);
      offset = 0;
      writeOffset = 0;
    }
    const writable = await handle.createWritable({ keepExistingData: true });
    const reader = response.body.getReader();
    try {
      await writable.seek(writeOffset);
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        const remaining = file.size_bytes - writeOffset;
        if (remaining <= 0) break;
        const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
        await writable.write(chunk);
        writeOffset += chunk.byteLength;
        onBytes(writeOffset);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      await writable.close();
    }
    const current = Math.min((await handle.getFile()).size, file.size_bytes);
    if (current >= file.size_bytes) {
      if ((await handle.getFile()).size > file.size_bytes) await truncate(handle, file.size_bytes);
      return file.size_bytes;
    }
    offset = current;
  }
  return Math.min((await handle.getFile()).size, file.size_bytes);
}

async function normalizedExistingBytes(modelId: string, version: string, file: ModelFile) {
  let handle: FileSystemFileHandle;
  try { handle = await fileHandle(modelId, version, file.path, false); }
  catch { return 0; }
  const local = await handle.getFile();
  if (local.size > file.size_bytes) {
    await truncate(handle, 0);
    return 0;
  }
  if (local.size === file.size_bytes && file.sha256 && (await digestBlob(local)).toLowerCase() !== file.sha256.toLowerCase()) {
    await truncate(handle, 0);
    return 0;
  }
  return local.size;
}

export async function resumableModelBytes(manifest: ModelManifest) {
  let downloaded = 0;
  for (const file of manifest.files) {
    try {
      const handle = await fileHandle(manifest.id, manifest.version, file.path, false);
      downloaded += Math.min((await handle.getFile()).size, file.size_bytes);
    } catch { /* No partial file for this path. */ }
  }
  return downloaded;
}

export async function installModel(
  manifest: ModelManifest,
  signal: AbortSignal,
  progress: (snapshot: ModelDownloadProgress) => void,
) {
  await navigator.storage.persist?.();
  const total = manifest.files.reduce((sum, file) => sum + file.size_bytes, 0);
  const bytesByFile = new Map<string, number>();
  for (const file of manifest.files) bytesByFile.set(file.path, await normalizedExistingBytes(manifest.id, manifest.version, file));
  const initialBytes = [...bytesByFile.values()].reduce((sum, bytes) => sum + bytes, 0);
  const isResuming = initialBytes > 0;
  const estimate = await navigator.storage.estimate();
  const remaining = total - initialBytes;
  assertStorageCapacity(estimate, remaining);

  const startedAt = performance.now();
  let lastReportedAt = 0;
  let lastReportedBytes = -1;
  const report = (file: string, force = false) => {
    const downloadedBytes = [...bytesByFile.values()].reduce((sum, bytes) => sum + bytes, 0);
    const now = performance.now();
    if (!force && downloadedBytes - lastReportedBytes < 1024 * 1024 && now - lastReportedAt < 250) return;
    const transferred = Math.max(downloadedBytes - initialBytes, 0);
    const elapsedSeconds = Math.max((now - startedAt) / 1000, 0.001);
    const bytesPerSecond = transferred / elapsedSeconds;
    progress({ downloadedBytes, totalBytes: total, currentFile: file, isResuming, bytesPerSecond, etaSeconds: bytesPerSecond > 0 ? (total - downloadedBytes) / bytesPerSecond : undefined });
    lastReportedAt = now;
    lastReportedBytes = downloadedBytes;
  };
  report('', true);
  for (const file of manifest.files) {
    signal.throwIfAborted();
    await downloadFile(manifest.id, manifest.version, file, signal, bytesByFile.get(file.path) ?? 0, bytes => {
      bytesByFile.set(file.path, Math.min(bytes, file.size_bytes));
      report(file.path);
    });
    bytesByFile.set(file.path, file.size_bytes);
    report(file.path, true);
  }
  const missing: string[] = [];
  for (const path of manifest.required_files) {
    try {
      await fileHandle(manifest.id, manifest.version, path, false);
    } catch {
      missing.push(path);
    }
  }
  if (missing.length > 0) throw new Error(`Installed model is missing: ${missing.join(', ')}`);
  const record: InstalledModel = {
    id: manifest.id,
    version: manifest.version,
    installedAt: new Date().toISOString(),
    files: manifest.files,
  };
  await putRegistryRecord(record);
  return record;
}

export function installedModel(id: string) {
  return getRegistryRecord<InstalledModel>(id);
}

export async function getInstalledModelFile(modelId: string, path: string) {
  const record = await installedModel(modelId);
  if (!record) throw new Error(`${modelId} is not installed.`);
  return (await fileHandle(modelId, record.version, path, false)).getFile();
}

export async function deleteModel(modelId: string) {
  const root = await modelRoot();
  try {
    await root.removeEntry(modelId, { recursive: true });
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
  }
  await deleteRegistryRecord(modelId);
}
