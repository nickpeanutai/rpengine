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
      // Routine activity stays deliberately terse. Diagnostic payloads are
      // retained only for errors, where they are useful for support/debugging.
      details: level === 'error' && meaningful(details) ? details : undefined,
    });
  }

  upsert(activityKey: string, level: LogLevel, category: string, message: string, details?: unknown) {
    const existing = this.entries.find(entry => entry.activityKey === activityKey);
    if (!existing) {
      this.append({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), level, category, message, details: level === 'error' && meaningful(details) ? details : undefined, activityKey });
      return;
    }
    existing.timestamp = new Date().toISOString();
    existing.level = level;
    existing.category = category;
    existing.message = message;
    existing.details = level === 'error' && meaningful(details) ? details : undefined;
    this.dispatchEvent(new Event('change'));
  }

  clear() {
    this.entries.splice(0);
    this.dispatchEvent(new Event('change'));
  }

  export() {
    const entries = this.entries.map(({ activityKey: _activityKey, ...entry }) => entry);
    return new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), entries }, null, 2)], {
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
