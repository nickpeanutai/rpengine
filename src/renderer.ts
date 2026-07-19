import type { AppViewModelV3 } from './core-contract';
import { DiagnosticLog } from './diagnostics';

const $ = <T extends HTMLElement>(selector: string) => { const element = document.querySelector<T>(selector); if (!element) throw new Error(`Missing element: ${selector}`); return element; };

export class AppRenderer {
  render(view: AppViewModelV3) {
    const connection = $('#connectionStatus'); connection.textContent = view.connection.label; connection.className = `status launch-status ${view.connection.connected ? 'success' : ''}`;
    const primary = $('#primaryButton') as HTMLButtonElement; primary.disabled = view.primary.disabled; primary.classList.toggle('is-indeterminate', view.primary.indeterminate);
    $('#primaryButtonLabel').textContent = view.primary.label; $('#primaryButtonDetail').textContent = view.primary.detail;
    ($('#primaryButtonProgress') as HTMLElement).style.width = view.primary.progress === undefined ? '0%' : `${Math.round(Math.min(1, Math.max(0, view.primary.progress)) * 100)}%`;
    const notice = $('#engineOwnerNotice'); notice.hidden = !view.ownerNotice.visible; notice.textContent = view.ownerNotice.text;
    const microphone = $('#microphoneButton') as HTMLButtonElement; microphone.textContent = view.microphone.label; microphone.disabled = view.microphone.disabled; microphone.setAttribute('aria-pressed', String(view.microphone.enabled));
    const language = $('#languageSelect') as HTMLSelectElement;
    language.innerHTML = view.settings.languages.map(option => `<option value="${escapeHTML(option.value)}"${option.value === view.settings.language ? ' selected' : ''}>${escapeHTML(option.label)}</option>`).join('');
    language.disabled = view.settings.languageDisabled;
    const port = $('#rpEnginePortInput') as HTMLInputElement; port.value = String(view.settings.port); port.disabled = view.settings.portDisabled;
    const transport = $('#transportSelect') as HTMLSelectElement; transport.disabled = view.service.phase !== 'idle';
    ($('#chooseMailboxButton') as HTMLButtonElement).disabled = view.service.phase !== 'idle';
    $('#modelEntries').innerHTML = view.models.map(model => `<article class="model-entry"><div><span>${escapeHTML(model.role)}</span><strong>${escapeHTML(model.name)}</strong><small>${escapeHTML(model.status)}${model.transfer ? ` · ${escapeHTML(model.transfer)}` : ''}</small>${model.showProgress ? `<progress class="model-progress" max="100" value="${Math.round(model.progress * 100)}" aria-label="Download progress"></progress>` : ''}</div><button type="button" class="secondary compact" data-model-action="${model.action}" data-model-id="${escapeHTML(model.id)}"${model.disabled ? ' disabled' : ''}>${escapeHTML(model.actionLabel)}</button></article>`).join('');
  }

  renderDiagnostics(log: DiagnosticLog) {
    const container = $('#logEntries');
    container.innerHTML = log.entries.map(entry => {
      const line = `<time>${new Date(entry.timestamp).toLocaleTimeString()}</time><strong>${escapeHTML(entry.category)}</strong><span class="log-message">${escapeHTML(entry.message)}</span>`;
      return entry.level === 'error' && entry.details !== undefined ? `<details class="log-line error"><summary>${line}</summary><pre>${escapeHTML(stringify(entry.details))}</pre></details>` : `<div class="log-line ${entry.level}">${line}</div>`;
    }).join('') || '<div class="terminal-empty"><span>$</span> Waiting for model activity…</div>';
    container.scrollTop = container.scrollHeight;
  }
}

export function element<T extends HTMLElement>(selector: string) { return $<T>(selector); }
function escapeHTML(value: string) { const element = document.createElement('span'); element.textContent = value; return element.innerHTML; }
function stringify(value: unknown) { if (value instanceof Error) return value.stack ?? value.message; try { return JSON.stringify(value, null, 2); } catch { return String(value); } }
