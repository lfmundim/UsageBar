import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as child_process from 'child_process';
import * as readline from 'readline';
import * as vscode from 'vscode';
import { ProviderInterface, UsageSnapshot, RateWindow, emptySnapshot } from './base';
import { httpGetJson, httpRequest } from '../util/http';
import { SecretStore } from '../util/secrets';

const PROVIDER_ID = 'codex';

interface CodexAuth {
  access_token: string;
  refresh_token: string;
  last_refresh: string; // ISO-8601
}

interface WhamUsageResponse {
  rate_limit?: {
    primary_window?: WhamRateLimitWindow | null;
    secondary_window?: WhamRateLimitWindow | null;
  };
  additional_rate_limits?: WhamRateLimitWindow[] | null;
  credits?: {
    balance?: number | null;
  } | null;
}

interface WhamRateLimitWindow {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_at?: number; // Unix timestamp (seconds)
}

export class CodexProvider implements ProviderInterface {
  readonly id = PROVIDER_ID;
  readonly displayName = 'OpenAI Codex CLI';

  constructor(private readonly _secrets: SecretStore) {}

  async isAvailable(): Promise<boolean> {
    return (
      (await this.loadAuth()) !== null ||
      (await this.findCodexBinary()) !== null
    );
  }

  async fetch(): Promise<UsageSnapshot> {
    const source = vscode.workspace
      .getConfiguration('usagebar')
      .get<string>('providers.codex.source', 'auto');

    if (source === 'oauth' || source === 'auto') {
      const result = await this.tryOAuth();
      if (result) return result;
    }
    if (source === 'cli' || source === 'auto') {
      const result = await this.tryCLIRPC();
      if (result) return result;
    }

    throw new Error('Codex: no working auth source. Run `codex login` or configure in UsageBar sidebar.');
  }

  // --- OAuth strategy ---

  private async tryOAuth(): Promise<UsageSnapshot | null> {
    try {
      const auth = await this.loadAuth();
      if (!auth) return null;

      const validAuth = await this.maybeRefreshToken(auth);
      const data = await httpGetJson<WhamUsageResponse>(
        'https://chatgpt.com/backend-api/wham/usage',
        {
          headers: { Authorization: `Bearer ${validAuth.access_token}` },
          timeoutMs: 15_000,
        },
      );
      return this.parseWhamResponse(data);
    } catch {
      return null;
    }
  }

  private parseWhamResponse(data: WhamUsageResponse): UsageSnapshot {
    const snap = emptySnapshot(PROVIDER_ID, 'oauth');
    const rl = data.rate_limit;

    const toRateWindow = (w: WhamRateLimitWindow): RateWindow => ({
      label: windowLabel(w.limit_window_seconds),
      usedPercent: w.used_percent !== undefined ? Math.min(100, Math.max(0, w.used_percent)) : undefined,
      resetAt: w.reset_at !== undefined ? new Date(w.reset_at * 1000).toISOString() : undefined,
    });

    if (rl?.primary_window) {
      snap.primary = toRateWindow(rl.primary_window);
    }
    if (rl?.secondary_window) {
      const rw = toRateWindow(rl.secondary_window);
      if (snap.primary) snap.secondary = rw;
      else snap.primary = rw;
    }
    for (const extra of (data.additional_rate_limits ?? [])) {
      snap.extra.push(toRateWindow(extra));
    }

    const bal = data.credits?.balance;
    if (bal !== null && bal !== undefined) snap.balanceUsd = bal;

    return snap;
  }

  private async loadAuth(): Promise<CodexAuth | null> {
    const authPath = path.join(os.homedir(), '.codex', 'auth.json');
    try {
      const raw = fs.readFileSync(authPath, 'utf8');
      const parsed = JSON.parse(raw);
      // New codex CLI format: tokens nested under "tokens" key
      if (parsed?.tokens?.access_token) {
        return {
          access_token: parsed.tokens.access_token,
          refresh_token: parsed.tokens.refresh_token ?? '',
          last_refresh: parsed.last_refresh ?? new Date(0).toISOString(),
        };
      }
      // Legacy flat format
      if (parsed?.access_token) return parsed as CodexAuth;
    } catch { /* file absent */ }
    return null;
  }

  private async maybeRefreshToken(auth: CodexAuth): Promise<CodexAuth> {
    const eightDays = 8 * 24 * 60 * 60 * 1000;
    const age = Date.now() - new Date(auth.last_refresh || 0).getTime();
    if (age < eightDays) return auth;
    if (!auth.refresh_token) return auth;

    try {
      const res = await httpRequest('https://chatgpt.com/backend-api/auth/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: auth.refresh_token }),
        timeoutMs: 10_000,
      });
      const json = JSON.parse(res.body);
      const refreshed: CodexAuth = {
        access_token: json.access_token ?? auth.access_token,
        refresh_token: json.refresh_token ?? auth.refresh_token,
        last_refresh: new Date().toISOString(),
      };
      // Write back to ~/.codex/auth.json
      const authPath = path.join(os.homedir(), '.codex', 'auth.json');
      fs.writeFileSync(authPath, JSON.stringify(refreshed, null, 2), 'utf8');
      return refreshed;
    } catch {
      return auth; // use existing, best effort
    }
  }

  // --- CLI RPC strategy ---

  private async tryCLIRPC(): Promise<UsageSnapshot | null> {
    const binary = await this.findCodexBinary();
    if (!binary) return null;

    let proc: child_process.ChildProcess | null = null;
    try {
      proc = child_process.spawn(binary, ['-s', 'read-only', '-a', 'untrusted', 'app-server'], {
        shell: false,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const rl = readline.createInterface({ input: proc.stdout! });
      const pending = new Map<number, (line: string) => void>();

      rl.on('line', (line: string) => {
        try {
          const msg = JSON.parse(line);
          const handler = pending.get(msg.id);
          if (handler) handler(line);
        } catch { /* ignore non-JSON */ }
      });

      const sendRPC = (id: number, method: string, params: object, timeoutMs = 15_000): Promise<string> => {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`RPC ${method} timed out`));
          }, timeoutMs);
          pending.set(id, (line) => {
            clearTimeout(timer);
            pending.delete(id);
            resolve(line);
          });
          proc!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        });
      };

      // Initialize (wait up to 30s for any response)
      await sendRPC(1, 'initialize', { clientName: 'UsageBar', clientVersion: '0.1.0' }, 30_000);

      // Fetch rate limits
      const rateLimitsRaw = await sendRPC(3, 'account/rateLimits/read', {});
      const rateLimitsMsg = JSON.parse(rateLimitsRaw);
      const result = rateLimitsMsg?.result;
      if (!result) return null;

      const snap = emptySnapshot(PROVIDER_ID, 'cli');
      const windows: Array<{ name: string; usedPercent: number; resetAt?: string }> =
        result.windows ?? [];
      for (const [i, w] of windows.entries()) {
        const rw: RateWindow = {
          label: w.name,
          usedPercent: Math.min(100, Math.max(0, w.usedPercent)),
          resetAt: w.resetAt,
        };
        if (i === 0) snap.primary = rw;
        else if (i === 1) snap.secondary = rw;
        else snap.extra.push(rw);
      }

      const credits = result.credits;
      if (credits?.balance !== undefined) snap.balanceUsd = credits.balance;

      return snap;
    } catch {
      return null;
    } finally {
      proc?.kill();
    }
  }

  private async findCodexBinary(): Promise<string | null> {
    const candidates = [
      'codex',
      '/usr/local/bin/codex',
      path.join(os.homedir(), '.local', 'bin', 'codex'),
      '/opt/homebrew/bin/codex',
    ];
    for (const bin of candidates) {
      try {
        child_process.execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], {
          stdio: 'ignore',
        });
        return bin;
      } catch {
        if (fs.existsSync(bin)) return bin;
      }
    }
    return null;
  }
}

function windowLabel(seconds?: number): string {
  if (!seconds) return 'Quota';
  if (seconds <= 3_600) return 'Hourly';
  if (seconds <= 21_600) return `${Math.round(seconds / 3600)}h`;
  if (seconds <= 86_400) return 'Daily';
  if (seconds <= 604_800) return 'Weekly';
  return 'Monthly';
}
