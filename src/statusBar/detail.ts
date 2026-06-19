import * as vscode from 'vscode';
import { UsageStore } from '../store/usageStore';
import { ProviderRegistry } from '../providers/registry';
import { RateWindow } from '../providers/base';

const PORTAL_URLS: Record<string, string> = {
  claude:      'https://claude.ai/new',
  codex:       'https://chatgpt.com/#settings',
  mistral:     'https://console.mistral.ai/codestral/cli',
  deepseek:    'https://platform.deepseek.com/usage',
  antigravity: 'https://antigravity.google',
};

const ACTION_REFRESH       = '$(refresh) Refresh';
const ACTION_SETTINGS      = '$(gear) Open Settings';
const ACTION_PORTAL        = '$(link-external) Open portal';
const ACTION_TOGGLE_METRIC = '$(arrow-swap) Toggle Vibe / Billing';
const ACTION_TOGGLE_EXTRAS = '$(eye) Toggle extra windows';
const ACTION_SET_TOKEN     = '$(key) Set OAuth token';
const ACTION_REFRESH_TOKEN = '$(sync) Refresh token';
const ACTION_SET_COOKIE    = '$(key) Set admin cookie';
const ACTION_SET_API_KEY   = '$(key) Set API key';

export async function showProviderDetail(
  providerId: string,
  store: UsageStore,
  registry: ProviderRegistry,
): Promise<void> {
  const provider = registry.getById(providerId);
  if (!provider) return;

  const snapshot = store.getSnapshot(providerId);
  const error    = store.getError(providerId);
  const cfg      = vscode.workspace.getConfiguration('usagebar');
  const style    = cfg.get<string>('display.progressBarStyle', 'blocks');

  const showExtras   = cfg.get<boolean>('providers.claude.showExtras', true);
  const showBilling  = cfg.get<boolean>('providers.mistral.showBillingInDetail', true);

  const ACTION_LABELS = new Set([
    ACTION_REFRESH, ACTION_SETTINGS, ACTION_PORTAL,
    ACTION_TOGGLE_METRIC, ACTION_TOGGLE_EXTRAS,
    ACTION_SET_TOKEN, ACTION_REFRESH_TOKEN, ACTION_SET_COOKIE, ACTION_SET_API_KEY,
  ]);

  const items: vscode.QuickPickItem[] = [];

  // --- data section ---
  if (error && !snapshot) {
    items.push({ label: `$(error) ${error.message}`, alwaysShow: true });
  } else if (!snapshot) {
    items.push({ label: '$(sync~spin) Loading…', alwaysShow: true });
  } else {
    const windows: RateWindow[] = [];
    if (snapshot.primary)   windows.push(snapshot.primary);
    if (snapshot.secondary) windows.push(snapshot.secondary);

    const extras = snapshot.extra.filter(rw => rw.usedPercent !== undefined);
    const showThisProviderExtras = providerId !== 'claude' || showExtras;
    if (showThisProviderExtras) {
      windows.push(...extras);
    }

    for (const rw of windows) {
      const bar    = renderBar(rw.usedPercent ?? 0, style);
      const pctStr = rw.usedPercent !== undefined ? `${rw.usedPercent.toFixed(1)}%` : '?%';
      const detail = rw.resetAt ? `resets ${formatResetDate(rw.resetAt)}` : undefined;
      items.push({ label: `${rw.label}   ${bar}  ${pctStr}`, detail, alwaysShow: true });
    }

    // Balance row
    if (snapshot.balanceUsd !== undefined) {
      const showRow = providerId !== 'mistral' || showBilling;
      if (showRow) {
        if (snapshot.capacityUsd !== undefined && snapshot.capacityUsd > 0) {
          const used = Math.max(0, snapshot.capacityUsd - snapshot.balanceUsd);
          const pct  = Math.min(100, (used / snapshot.capacityUsd) * 100);
          const bar  = renderBar(pct, style);
          items.push({
            label:  `Balance   ${bar}  $${snapshot.balanceUsd.toFixed(2)} left`,
            detail: `$${snapshot.capacityUsd.toFixed(2)} paid total · $${used.toFixed(2)} spent`,
            alwaysShow: true,
          });
        } else {
          items.push({
            label:  `Balance: $${snapshot.balanceUsd.toFixed(2)}`,
            detail: `next billing cycle: ${nextFirstOfMonth()}`,
            alwaysShow: true,
          });
        }
      }
    }

    if (error) {
      items.push({ label: `$(warning) ${error.message}`, alwaysShow: true });
    }

    items.push({ label: `Last updated: ${snapshot.fetchedAt.toLocaleTimeString()}`, alwaysShow: true });
  }

  // --- actions section ---
  items.push({ label: 'Actions', kind: vscode.QuickPickItemKind.Separator });

  if (providerId === 'mistral') {
    const metric = cfg.get<string>('providers.mistral.metric', 'billing');
    items.push({ label: ACTION_TOGGLE_METRIC, description: `currently: ${metric}`, alwaysShow: true });
    items.push({
      label: ACTION_TOGGLE_EXTRAS,
      description: `billing row: ${showBilling ? 'visible' : 'hidden'}`,
      alwaysShow: true,
    });
    items.push({ label: ACTION_SET_COOKIE, description: 'paste Cookie header from console.mistral.ai', alwaysShow: true });
  }
  if (providerId === 'deepseek') {
    items.push({ label: ACTION_SET_API_KEY, description: 'paste API key from platform.deepseek.com', alwaysShow: true });
  }
  if (providerId === 'claude') {
    items.push({
      label: ACTION_TOGGLE_EXTRAS,
      description: `extra windows: ${showExtras ? 'visible' : 'hidden'}`,
      alwaysShow: true,
    });
  }
  if (providerId === 'antigravity') {
    items.push({ label: ACTION_REFRESH_TOKEN, description: 'force refresh via antigravity-usage credentials', alwaysShow: true });
    items.push({ label: ACTION_SET_TOKEN, description: 'paste Google OAuth access token manually', alwaysShow: true });
  }

  if (PORTAL_URLS[providerId]) {
    items.push({ label: ACTION_PORTAL, alwaysShow: true });
  }
  items.push({ label: ACTION_REFRESH,  alwaysShow: true });
  items.push({ label: ACTION_SETTINGS, alwaysShow: true });

  const picked = await vscode.window.showQuickPick(items, {
    title:              `UsageBar — ${provider.displayName}`,
    placeHolder:        'Select action · Enter on data row opens portal',
    matchOnDescription: false,
    matchOnDetail:      false,
  });

  if (!picked) return;

  // Data row selected → open portal
  if (!ACTION_LABELS.has(picked.label) && picked.kind !== vscode.QuickPickItemKind.Separator) {
    const url = PORTAL_URLS[providerId];
    if (url) vscode.env.openExternal(vscode.Uri.parse(url));
    return;
  }

  if (picked.label === ACTION_REFRESH) {
    await store.refresh();
  } else if (picked.label === ACTION_SETTINGS) {
    vscode.commands.executeCommand('workbench.action.openSettings', 'usagebar');
  } else if (picked.label === ACTION_PORTAL) {
    const url = PORTAL_URLS[providerId];
    if (url) vscode.env.openExternal(vscode.Uri.parse(url));
  } else if (picked.label === ACTION_TOGGLE_METRIC) {
    const current = cfg.get<string>('providers.mistral.metric', 'billing');
    await cfg.update('providers.mistral.metric', current === 'vibe' ? 'billing' : 'vibe', vscode.ConfigurationTarget.Global);
  } else if (picked.label === ACTION_TOGGLE_EXTRAS) {
    if (providerId === 'claude') {
      await cfg.update('providers.claude.showExtras', !showExtras, vscode.ConfigurationTarget.Global);
    } else if (providerId === 'mistral') {
      await cfg.update('providers.mistral.showBillingInDetail', !showBilling, vscode.ConfigurationTarget.Global);
    }
  } else if (picked.label === ACTION_REFRESH_TOKEN) {
    await vscode.commands.executeCommand('usagebar.refreshAntigravityToken');
  } else if (picked.label === ACTION_SET_TOKEN) {
    await vscode.commands.executeCommand('usagebar.setAntigravityToken');
  } else if (picked.label === ACTION_SET_COOKIE) {
    await vscode.commands.executeCommand('usagebar.setMistralCookie');
  } else if (picked.label === ACTION_SET_API_KEY) {
    await vscode.commands.executeCommand('usagebar.setDeepseekApiKey');
  }
}

// --- helpers ---

function renderBar(pct: number, style: string): string {
  const filled = Math.round(Math.min(100, Math.max(0, pct)) / 10);
  const empty  = 10 - filled;
  if (style === 'dots') return `${'●'.repeat(filled)}${'○'.repeat(empty)}`;
  return `${'▰'.repeat(filled)}${'▱'.repeat(empty)}`;
}

function formatResetDate(isoDate: string): string {
  const d      = new Date(isoDate);
  const ms     = d.getTime() - Date.now();
  if (ms <= 0) return 'now';
  const totalH = Math.floor(ms / 3_600_000);
  const days   = Math.floor(totalH / 24);
  const h      = totalH % 24;
  const m      = Math.floor((ms % 3_600_000) / 60_000);
  const dateStr = d.toLocaleString('en', { month: 'short', day: 'numeric' });
  if (days >= 1) return `${dateStr} (${days}d)`;
  if (h > 0)    return `in ${h}h ${m}m`;
  return `in ${m}m`;
}

function nextFirstOfMonth(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1, 1)
    .toLocaleString('en', { month: 'short', day: 'numeric' });
}
