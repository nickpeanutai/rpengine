export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface DiagnosticEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  category: string;
  message: string;
  details?: unknown;
  activityKey?: string;
}
export class DiagnosticLog extends EventTarget {
  readonly entries: DiagnosticEntry[] = [];

  add(level: LogLevel, category: string, message: string, details?: unknown) {
    this.append({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      level,
      category,
      message,
      // Routine activity stays deliberately terse. The response-processing
      // category contains only rule ids, counts, removal targets, and sizes;
      // it deliberately excludes generated or captured text.
      details: retainedDetails(level, category, details),
    });
  }

  upsert(activityKey: string, level: LogLevel, category: string, message: string, details?: unknown) {
    const existing = this.entries.find(entry => entry.activityKey === activityKey);
    if (!existing) {
      this.append({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), level, category, message, details: retainedDetails(level, category, details), activityKey });
      return;
    }
    existing.timestamp = new Date().toISOString();
    existing.level = level;
    existing.category = category;
    existing.message = message;
    existing.details = retainedDetails(level, category, details);
    this.dispatchEvent(new Event('change'));
  }

  clear() {
    this.entries.splice(0);
    this.dispatchEvent(new Event('change'));
  }

  export(promptSnapshots?: unknown[]) {
    const entries = this.entries.map(({ activityKey: _activityKey, ...entry }) => entry);
    const payload: { exportedAt: string; entries: typeof entries; promptSnapshots?: unknown[] } = { exportedAt: new Date().toISOString(), entries };
    if (promptSnapshots !== undefined) payload.promptSnapshots = promptSnapshots;
    return new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    });
  }

  private append(entry: DiagnosticEntry) {
    this.entries.push(entry);
    if (this.entries.length > 500) this.entries.splice(0, this.entries.length - 500);
    this.dispatchEvent(new Event('change'));
  }
}

function meaningful(details: unknown) {
  return details !== undefined && details !== null
    && (!(typeof details === 'object') || Object.keys(details as object).length > 0);
}

function retainedDetails(level: LogLevel, category: string, details: unknown) {
  return meaningful(details) && (level === 'error' || category === 'response-processing') ? details : undefined;
}
