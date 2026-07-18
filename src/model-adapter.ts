import { deleteModel, fetchModelManifest, installModel, installedModel, resumableModelBytes } from './model-store';
import type { ModelStatusSnapshot } from './core-contract';
import type { ModelManifest } from './types';

export class ModelAdapter {
  private manifests = new Map<string, ModelManifest>();
  private controllers = new Map<string, AbortController>();
  readonly statuses = new Map<string, ModelStatusSnapshot>();
  constructor(private readonly ids: string[], private readonly changed: (status: ModelStatusSnapshot) => void) {}

  async refresh() {
    const manifests = await fetchModelManifest();
    this.manifests = new Map(manifests.map(manifest => [manifest.id, manifest]));
    for (const id of this.ids) {
      const manifest = this.manifests.get(id);
      if (!manifest) { this.update({ id, name: id, phase: 'error', progress: 0, downloadedBytes: 0, totalBytes: 0, error: 'The bundled web model catalog does not include this model.' }); continue; }
      const totalBytes = manifest.files.reduce((sum, file) => sum + file.size_bytes, 0);
      const installed = await installedModel(id);
      const downloadedBytes = installed?.version === manifest.version ? totalBytes : await resumableModelBytes(manifest);
      this.update({ id, name: manifest.name, phase: installed?.version === manifest.version ? 'installed' : downloadedBytes > 0 ? 'paused' : 'missing', progress: downloadedBytes / Math.max(totalBytes, 1), downloadedBytes, totalBytes, isResuming: downloadedBytes > 0 && downloadedBytes < totalBytes });
    }
    return [...this.statuses.values()];
  }

  async download(id: string) {
    const manifest = this.manifests.get(id); if (!manifest) throw new Error('Refresh the model catalog before downloading.');
    if (this.controllers.has(id)) return;
    const controller = new AbortController(); this.controllers.set(id, controller);
    const totalBytes = manifest.files.reduce((sum, file) => sum + file.size_bytes, 0);
    const partial = await resumableModelBytes(manifest);
    this.update({ id, name: manifest.name, phase: 'downloading', progress: partial / Math.max(totalBytes, 1), downloadedBytes: partial, totalBytes, isResuming: partial > 0, bytesPerSecond: 0 });
    try {
      await installModel(manifest, controller.signal, progress => this.update({ id, name: manifest.name, phase: progress.downloadedBytes >= progress.totalBytes ? 'verifying' : 'downloading', progress: Math.min(progress.downloadedBytes / Math.max(progress.totalBytes, 1), 0.99), downloadedBytes: progress.downloadedBytes, totalBytes: progress.totalBytes, isResuming: progress.isResuming, bytesPerSecond: progress.bytesPerSecond, etaSeconds: progress.etaSeconds }));
      this.update({ id, name: manifest.name, phase: 'installed', progress: 1, downloadedBytes: totalBytes, totalBytes, isResuming: false });
    } catch (error) {
      const downloadedBytes = await resumableModelBytes(manifest); const partialExists = downloadedBytes > 0;
      this.update({ id, name: manifest.name, phase: controller.signal.aborted ? partialExists ? 'paused' : 'missing' : 'error', progress: downloadedBytes / Math.max(totalBytes, 1), downloadedBytes, totalBytes, isResuming: partialExists, error: controller.signal.aborted ? undefined : error instanceof Error ? error.message : String(error) });
      throw error;
    } finally { this.controllers.delete(id); }
  }

  cancel(id: string) { this.controllers.get(id)?.abort(); }
  failRefresh(error: string) {
    for (const id of this.ids) {
      const current = this.statuses.get(id);
      this.update({ id, name: current?.name ?? id, phase: 'error', progress: 0, downloadedBytes: current?.downloadedBytes ?? 0, totalBytes: current?.totalBytes ?? 0, error });
    }
    return [...this.statuses.values()];
  }
  async delete(id: string) { this.cancel(id); await deleteModel(id); const current = this.statuses.get(id); this.update({ id, name: current?.name ?? id, phase: 'missing', progress: 0, downloadedBytes: 0, totalBytes: current?.totalBytes ?? 0 }); }
  async cleanup(id: string) { const removed = Boolean(await installedModel(id)); await deleteModel(id); return removed; }
  markRuntime(id: string, runtimePhase: 'loading' | 'ready' | 'error', runtimeProgress: number, runtimeError?: string) { const current = this.statuses.get(id); if (current) this.update({ ...current, runtimePhase, runtimeProgress, runtimeError }); }
  snapshot(id: string) { return this.statuses.get(id); }
  private update(status: ModelStatusSnapshot) { this.statuses.set(status.id, status); this.changed(status); }
}
