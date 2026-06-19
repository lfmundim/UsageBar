import * as vscode from 'vscode';
import { UsageStore } from '../store/usageStore';
import { ProviderRegistry } from '../providers/registry';
import { renderStatusBarText, renderTooltip, getBackgroundColor } from './renderer';

const PROVIDER_PRIORITIES: Record<string, number> = {
  antigravity: 105,
  claude:      104,
  codex:       103,
  mistral:     102,
  deepseek:    101,
};

export class StatusBarController implements vscode.Disposable {
  private items = new Map<string, vscode.StatusBarItem>();
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly store: UsageStore,
    private readonly registry: ProviderRegistry,
  ) {
    // Create one status bar item per provider
    for (const provider of registry.getAll()) {
      const item = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        PROVIDER_PRIORITIES[provider.id] ?? 100,
      );
      item.command = 'usagebar.openSettings';
      item.name = `UsageBar — ${provider.displayName}`;
      item.text = `$(sync~spin) ${provider.displayName}`;
      item.show();
      this.items.set(provider.id, item);
    }

    // Re-render on every store update
    this.disposables.push(
      store.onDidUpdate.event(() => this.render()),
    );

    // Re-render when display config changes
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('usagebar.display') ||
          e.affectsConfiguration('usagebar.providers')
        ) {
          this.render();
        }
      }),
    );
  }

  render(): void {
    for (const [providerId, item] of this.items) {
      const enabled = vscode.workspace
        .getConfiguration('usagebar')
        .get<boolean>(`providers.${providerId}.enabled`, true);

      if (!enabled) {
        item.hide();
        continue;
      }
      item.show();

      const snapshot = this.store.getSnapshot(providerId);
      const error    = this.store.getError(providerId);

      if (!snapshot && error) {
        item.text = `$(error) ${providerId}`;
        item.tooltip = `${providerId}: ${error.message}`;
        item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        continue;
      }

      if (!snapshot) {
        item.text = `$(sync~spin) ${providerId}`;
        item.tooltip = 'Loading…';
        item.backgroundColor = undefined;
        continue;
      }

      item.text = renderStatusBarText(snapshot);
      item.tooltip = renderTooltip(snapshot, error);
      item.backgroundColor = getBackgroundColor(snapshot);
    }
  }

  dispose(): void {
    for (const item of this.items.values()) item.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
