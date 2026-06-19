import * as vscode from 'vscode';
import { ProviderInterface, UsageSnapshot } from '../providers/base';

const REFRESH_INTERVALS: Record<string, number> = {
  manual: 0,
  '1m':   60_000,
  '2m':   120_000,
  '5m':   300_000,
  '15m':  900_000,
  '30m':  1_800_000,
};

const FETCH_TIMEOUT_MS = 20_000;

export class UsageStore {
  private snapshots = new Map<string, UsageSnapshot>();
  private errors    = new Map<string, Error>();
  private providers: ProviderInterface[] = [];
  private timer: NodeJS.Timeout | undefined;

  /** Fired after every refresh cycle completes (success or partial failure). */
  readonly onDidUpdate = new vscode.EventEmitter<void>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Register providers. Must be called before startTimer(). */
  registerProviders(providers: ProviderInterface[]): void {
    this.providers = providers;
  }

  /** Start the automatic refresh timer based on VS Code config. */
  startTimer(): void {
    this.stopTimer();
    const intervalKey = vscode.workspace
      .getConfiguration('usagebar')
      .get<string>('refreshInterval', '5m');
    const ms = REFRESH_INTERVALS[intervalKey] ?? 300_000;
    if (ms === 0) return; // manual mode

    // Refresh immediately on start, then on interval
    this.refresh();
    this.timer = setInterval(() => this.refresh(), ms);
  }

  stopTimer(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Trigger an immediate refresh of all enabled providers in parallel. */
  async refresh(): Promise<void> {
    const active = this.providers.filter((p) => this.isEnabled(p.id));
    await Promise.all(active.map((p) => this.fetchProvider(p)));
    this.onDidUpdate.fire();
  }

  /** Get the latest snapshot for a provider, or undefined if never fetched. */
  getSnapshot(providerId: string): UsageSnapshot | undefined {
    return this.snapshots.get(providerId);
  }

  /** Get the last error for a provider, or undefined. */
  getError(providerId: string): Error | undefined {
    return this.errors.get(providerId);
  }

  /** All current snapshots (only providers that have been fetched at least once). */
  getAllSnapshots(): UsageSnapshot[] {
    return Array.from(this.snapshots.values());
  }

  dispose(): void {
    this.stopTimer();
    this.onDidUpdate.dispose();
  }

  // --- private ---

  private isEnabled(providerId: string): boolean {
    return vscode.workspace
      .getConfiguration('usagebar')
      .get<boolean>(`providers.${providerId}.enabled`, true);
  }

  private async fetchProvider(provider: ProviderInterface): Promise<void> {
    try {
      const snapshot = await Promise.race([
        provider.fetch(),
        timeout(FETCH_TIMEOUT_MS, provider.id),
      ]);
      this.snapshots.set(provider.id, snapshot);
      this.errors.delete(provider.id);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.errors.set(provider.id, error);
      // Keep stale snapshot — do not delete it on error
    }
  }
}

function timeout(ms: number, providerId: string): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`${providerId}: fetch timed out after ${ms}ms`)), ms),
  );
}
