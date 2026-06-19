/** A single rate-limit window (e.g. "5-hour session", "7-day weekly"). */
export interface RateWindow {
  /** Name shown in UI, e.g. "Session", "Weekly", "Opus weekly" */
  label: string;
  /** 0–100 percent of quota *used*. undefined = unknown. */
  usedPercent: number | undefined;
  /** ISO-8601 string when this window resets. undefined = unknown. */
  resetAt: string | undefined;
}

/** Snapshot of usage data returned by a provider fetch. */
export interface UsageSnapshot {
  providerId: string;
  /** Primary window shown in status bar (e.g. session for Claude). */
  primary: RateWindow | undefined;
  /** Secondary window (e.g. weekly for Claude when session is primary). */
  secondary: RateWindow | undefined;
  /** Additional named windows (e.g. Opus weekly, Daily Routines). */
  extra: RateWindow[];
  /** Current credit/token balance. undefined = not applicable. */
  balanceUsd: number | undefined;
  /** Total capacity for balance (topped-up + granted). Enables a "used" progress bar. */
  capacityUsd: number | undefined;
  /** Human-readable source label, e.g. "oauth", "cli", "web". */
  sourceLabel: string;
  /** When this snapshot was fetched. */
  fetchedAt: Date;
}

/** Contract every provider must implement. */
export interface ProviderInterface {
  readonly id: string;
  readonly displayName: string;
  /** Returns true if this provider can be fetched right now (credentials/binary present). */
  isAvailable(): Promise<boolean>;
  /** Fetch current usage. Throws on unrecoverable error. */
  fetch(): Promise<UsageSnapshot>;
}

/** Helper: build an empty snapshot for a provider. */
export function emptySnapshot(providerId: string, sourceLabel: string): UsageSnapshot {
  return {
    providerId,
    primary: undefined,
    secondary: undefined,
    extra: [],
    balanceUsd: undefined,
    capacityUsd: undefined,
    sourceLabel,
    fetchedAt: new Date(),
  };
}
