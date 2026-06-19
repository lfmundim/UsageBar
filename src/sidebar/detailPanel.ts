import * as vscode from 'vscode';
import { UsageStore } from '../store/usageStore';
import { ProviderRegistry } from '../providers/registry';
import { UsageSnapshot } from '../providers/base';

export class DetailPanelProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private storeListener: vscode.Disposable | undefined;

  constructor(
    private readonly store: UsageStore,
    private readonly registry: ProviderRegistry,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };

    this.render();

    this.storeListener = this.store.onDidUpdate.event(() => this.render());

    webviewView.onDidDispose(() => {
      this.storeListener?.dispose();
      this.storeListener = undefined;
      this.view = undefined;
    });

    webviewView.webview.onDidReceiveMessage(async (msg: { type: string }) => {
      const cfg = vscode.workspace.getConfiguration('usagebar');
      if (msg.type === 'refresh') {
        await this.store.refresh();
      } else if (msg.type === 'toggleMistral') {
        const current = cfg.get<string>('providers.mistral.metric', 'billing');
        await cfg.update('providers.mistral.metric', current === 'vibe' ? 'billing' : 'vibe', vscode.ConfigurationTarget.Global);
      } else if (msg.type === 'openSettings') {
        vscode.commands.executeCommand('workbench.action.openSettings', 'usagebar');
      }
    });

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('usagebar')) this.render();
    });
  }

  render(): void {
    if (!this.view) return;
    this.view.webview.html = this.buildHtml();
  }

  private buildHtml(): string {
    const providers = this.registry.getAll();
    const cfg = vscode.workspace.getConfiguration('usagebar');
    const sections: string[] = [];

    for (const provider of providers) {
      const enabled = cfg.get<boolean>(`providers.${provider.id}.enabled`, true);
      if (!enabled) continue;
      sections.push(this.buildSection(
        provider.id,
        provider.displayName,
        this.store.getSnapshot(provider.id),
        this.store.getError(provider.id),
        cfg,
      ));
    }

    const snapshots = providers
      .map(p => this.store.getSnapshot(p.id))
      .filter((s): s is UsageSnapshot => s !== undefined);
    const latest = snapshots.reduce<UsageSnapshot | undefined>(
      (a, b) => (!a || b.fetchedAt > a.fetchedAt ? b : a), undefined,
    );
    const footer = latest
      ? `<div class="footer">Last updated: ${latest.fetchedAt.toLocaleTimeString()}</div>`
      : '';

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body { padding: 12px 16px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-panel-background); margin: 0; }
  .provider { margin-bottom: 18px; }
  .provider-header { font-weight: 600; font-size: 1.05em; margin-bottom: 8px; }
  .row { margin-bottom: 8px; }
  .row-label { font-size: 0.82em; opacity: 0.65; margin-bottom: 3px; }
  .bar-track { background: var(--vscode-scrollbarSlider-background, #444); border-radius: 3px; height: 5px; margin: 3px 0; }
  .bar-fill { height: 100%; border-radius: 3px; background: var(--vscode-progressBar-background, #0e70c0); }
  .bar-fill.warn  { background: #cca700; }
  .bar-fill.danger { background: #f14c4c; }
  .row-meta { font-size: 0.8em; opacity: 0.55; }
  hr { border: none; border-top: 1px solid var(--vscode-panel-border, #3c3c3c); margin: 14px 0; }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 3px; padding: 4px 10px; cursor: pointer; font-size: 0.82em; font-family: inherit; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .err { color: var(--vscode-errorForeground); font-size: 0.82em; }
  .footer { font-size: 0.72em; opacity: 0.4; margin-top: 10px; }
</style>
</head>
<body>
${sections.join('<hr>\n')}
<hr>
<div class="actions">
  <button onclick="send('refresh')">↺ Refresh all</button>
  <button onclick="send('openSettings')">⚙ Settings</button>
</div>
${footer}
<script>
  const vscode = acquireVsCodeApi();
  function send(type) { vscode.postMessage({ type }); }
</script>
</body>
</html>`;
  }

  private buildSection(
    id: string,
    name: string,
    snapshot: UsageSnapshot | undefined,
    error: Error | undefined,
    cfg: vscode.WorkspaceConfiguration,
  ): string {
    if (error && !snapshot) {
      return `<div class="provider"><div class="provider-header">${name}</div><div class="err">⚠ ${esc(error.message)}</div></div>`;
    }
    if (!snapshot) {
      return `<div class="provider"><div class="provider-header">${name}</div><div class="row-meta">Loading…</div></div>`;
    }

    const rows: string[] = [];

    // Quota windows
    for (const rw of [snapshot.primary, snapshot.secondary, ...snapshot.extra]) {
      if (!rw || rw.usedPercent === undefined) continue;
      const pct = Math.min(100, Math.max(0, rw.usedPercent));
      const cls = pct >= 100 ? 'danger' : pct >= 90 ? 'warn' : '';
      const reset = rw.resetAt ? ` · resets ${fmtReset(rw.resetAt)}` : '';
      rows.push(`<div class="row">
  <div class="row-label">${esc(rw.label)}</div>
  <div class="bar-track"><div class="bar-fill ${cls}" style="width:${pct.toFixed(1)}%"></div></div>
  <div class="row-meta">${rw.usedPercent.toFixed(1)}% used${reset}</div>
</div>`);
    }

    // Balance / prepaid
    if (snapshot.balanceUsd !== undefined) {
      if (snapshot.capacityUsd !== undefined && snapshot.capacityUsd > 0) {
        const used = Math.max(0, snapshot.capacityUsd - snapshot.balanceUsd);
        const pct  = Math.min(100, (used / snapshot.capacityUsd) * 100);
        const cls  = pct >= 90 ? 'warn' : '';
        rows.push(`<div class="row">
  <div class="row-label">Balance</div>
  <div class="bar-track"><div class="bar-fill ${cls}" style="width:${pct.toFixed(1)}%"></div></div>
  <div class="row-meta">$${snapshot.balanceUsd.toFixed(2)} of $${snapshot.capacityUsd.toFixed(2)} remaining</div>
</div>`);
      } else {
        const cycle = nextFirstOfMonth();
        rows.push(`<div class="row">
  <div class="row-label">Balance</div>
  <div class="row-meta">$${snapshot.balanceUsd.toFixed(2)} · next cycle ${cycle}</div>
</div>`);
      }
    }

    if (error) {
      rows.push(`<div class="err">⚠ ${esc(error.message)}</div>`);
    }

    // Mistral toggle action
    let extra = '';
    if (id === 'mistral') {
      const metric = cfg.get<string>('providers.mistral.metric', 'billing');
      extra = `<div style="margin-top:6px"><button onclick="send('toggleMistral')">Switch to ${metric === 'vibe' ? 'Billing' : 'Vibe'}</button></div>`;
    }

    return `<div class="provider">
  <div class="provider-header">${name}</div>
  ${rows.join('\n  ')}
  ${extra}
</div>`;
  }

  dispose(): void {
    this.storeListener?.dispose();
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtReset(iso: string): string {
  const d   = new Date(iso);
  const ms  = d.getTime() - Date.now();
  if (ms <= 0) return 'now';
  const h   = Math.floor(ms / 3_600_000);
  const days = Math.floor(h / 24);
  const rem  = h % 24;
  const m   = Math.floor((ms % 3_600_000) / 60_000);
  const date = d.toLocaleString('en', { month: 'short', day: 'numeric' });
  if (days >= 1) return `${date} (${days}d)`;
  if (rem > 0)   return `in ${rem}h ${m}m`;
  return `in ${m}m`;
}

function nextFirstOfMonth(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1, 1)
    .toLocaleString('en', { month: 'short', day: 'numeric' });
}
