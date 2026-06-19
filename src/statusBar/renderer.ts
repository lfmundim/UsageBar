import * as vscode from 'vscode';
import { UsageSnapshot, RateWindow } from '../providers/base';

export function renderStatusBarText(snapshot: UsageSnapshot): string {
  const cfg = vscode.workspace.getConfiguration('usagebar');
  const showLabel = cfg.get<boolean>('display.showProviderLabel', true);
  const style = cfg.get<string>('display.progressBarStyle', 'blocks');

  const label = showLabel ? `${capitalize(snapshot.providerId)} ` : '';

  // No rate window — show balance
  if (!snapshot.primary && snapshot.balanceUsd !== undefined) {
    return `${label}$${snapshot.balanceUsd.toFixed(2)}`;
  }

  if (!snapshot.primary) return `${label}—`;

  const primaryBar = renderWindow(snapshot.primary, style);
  if (snapshot.secondary) {
    const secondaryBar = renderWindow(snapshot.secondary, style);
    return `${label}${primaryBar} │ ${secondaryBar}`;
  }
  return `${label}${primaryBar}`;
}

export function renderTooltip(snapshot: UsageSnapshot, error: Error | undefined): vscode.MarkdownString {
  const md = new vscode.MarkdownString('', true);
  md.isTrusted = true;

  if (error) {
    md.appendMarkdown(`**${capitalize(snapshot.providerId)}** — ⚠ ${error.message}\n\n`);
    md.appendMarkdown(`[Refresh](command:usagebar.refresh)`);
    return md;
  }

  md.appendMarkdown(`**${capitalize(snapshot.providerId)}** _(${snapshot.sourceLabel})_\n\n`);

  const allWindows: Array<{ label: string; rw: RateWindow }> = [];
  if (snapshot.primary) allWindows.push({ label: snapshot.primary.label, rw: snapshot.primary });
  if (snapshot.secondary) allWindows.push({ label: snapshot.secondary.label, rw: snapshot.secondary });
  for (const rw of snapshot.extra) allWindows.push({ label: rw.label, rw });

  for (const { label, rw } of allWindows) {
    const bar = renderWindow(rw, 'blocks');
    const reset = rw.resetAt ? ` — resets in ${formatResetIn(rw.resetAt)}` : '';
    md.appendMarkdown(`${label}: ${bar}${reset}\n\n`);
  }

  if (snapshot.balanceUsd !== undefined) {
    md.appendMarkdown(`Balance: **$${snapshot.balanceUsd.toFixed(2)}**\n\n`);
  }

  const time = snapshot.fetchedAt.toLocaleTimeString();
  md.appendMarkdown(`_Last updated: ${time}_\n\n`);
  md.appendMarkdown(`[Refresh](command:usagebar.refresh)`);
  return md;
}

export function getBackgroundColor(snapshot: UsageSnapshot): vscode.ThemeColor | undefined {
  const pct = snapshot.primary?.usedPercent;
  if (pct === undefined) return undefined;
  if (pct >= 100) return new vscode.ThemeColor('statusBarItem.errorBackground');
  if (pct >= 90)  return new vscode.ThemeColor('statusBarItem.warningBackground');
  return undefined;
}

// --- helpers ---

function renderWindow(rw: RateWindow, style: string): string {
  if (style === 'percent') {
    return rw.usedPercent !== undefined ? `${rw.usedPercent.toFixed(0)}%` : '?%';
  }
  const pct = rw.usedPercent ?? 0;
  const filled = Math.round(Math.min(100, Math.max(0, pct)) / 10);
  const empty = 10 - filled;
  if (style === 'dots') {
    return `${'●'.repeat(filled)}${'○'.repeat(empty)} ${pct.toFixed(0)}%`;
  }
  // blocks (default)
  return `${'█'.repeat(filled)}${'░'.repeat(empty)} ${pct.toFixed(0)}%`;
}

function formatResetIn(isoDate: string | undefined): string {
  if (!isoDate) return '';
  const ms = new Date(isoDate).getTime() - Date.now();
  if (ms <= 0) return 'now';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h > 24) return `${Math.floor(h / 24)}d`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
