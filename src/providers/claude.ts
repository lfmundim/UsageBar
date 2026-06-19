import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as child_process from 'child_process';
import { ProviderInterface, UsageSnapshot, RateWindow, emptySnapshot } from './base';
import { httpGetJson, httpRequest } from '../util/http';
import { SecretStore } from '../util/secrets';

const PROVIDER_ID = 'claude';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

interface ClaudeCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix epoch seconds
}

interface OAuthUsageResponse {
  five_hour?: UsageWindow;
  seven_day?: UsageWindow;
  seven_day_sonnet?: UsageWindow;
  seven_day_opus?: UsageWindow;
  seven_day_routines?: UsageWindow;
  extra_usage?: UsageWindow;
}

interface UsageWindow {
  used_count: number;
  limit_count: number;
  reset_at?: string;
}

export class ClaudeProvider implements ProviderInterface {
  readonly id = PROVIDER_ID;
  readonly displayName = 'Claude Code';

  constructor(private readonly secrets: SecretStore) {}

  async isAvailable(): Promise<boolean> {
    return (
      (await this.loadCredentials()) != null ||
      (await this.findClaudeBinary()) != null ||
      (await this.secrets.get('claude.sessionCookie')) != null
    );
  }

  async fetch(): Promise<UsageSnapshot> {
    const source = vscode.workspace
      .getConfiguration('usagebar')
      .get<string>('providers.claude.source', 'auto');

    if (source === 'oauth' || source === 'auto') {
      const result = await this.tryOAuth();
      if (result) return result;
    }
    if (source === 'cli' || source === 'auto') {
      const result = await this.tryCLI();
      if (result) return result;
    }
    if (source === 'web' || source === 'auto') {
      const result = await this.tryWebCookie();
      if (result) return result;
    }

    throw new Error('Claude: no working auth source. Configure credentials in the UsageBar sidebar.');
  }

  // --- OAuth strategy ---

  private async tryOAuth(): Promise<UsageSnapshot | null> {
    try {
      const creds = await this.loadCredentials();
      if (!creds) return null;

      const validCreds = await this.maybeRefreshToken(creds);
      const data = await httpGetJson<OAuthUsageResponse>(
        'https://api.anthropic.com/api/oauth/usage',
        {
          headers: {
            Authorization: `Bearer ${validCreds.accessToken}`,
            'anthropic-beta': 'oauth-2025-04-20',
          },
          timeoutMs: 15_000,
        },
      );
      return this.parseOAuthResponse(data);
    } catch {
      return null;
    }
  }

  private parseOAuthResponse(data: OAuthUsageResponse): UsageSnapshot {
    const snap = emptySnapshot(PROVIDER_ID, 'oauth');

    if (data.five_hour) {
      snap.primary = windowToRateWindow('Session', data.five_hour);
    }
    if (data.seven_day) {
      const rw = windowToRateWindow('Weekly', data.seven_day);
      if (snap.primary) snap.secondary = rw;
      else snap.primary = rw;
    }
    if (data.seven_day_opus) {
      snap.extra.push(windowToRateWindow('Opus weekly', data.seven_day_opus));
    }
    if (data.seven_day_sonnet) {
      snap.extra.push(windowToRateWindow('Sonnet weekly', data.seven_day_sonnet));
    }
    if (data.seven_day_routines) {
      snap.extra.push(windowToRateWindow('Daily Routines', data.seven_day_routines));
    }

    return snap;
  }

  private async loadCredentials(): Promise<ClaudeCredentials | null> {
    // 1. Try VS Code secret store
    const stored = await this.secrets.get('claude.credentials');
    if (stored) {
      try { return JSON.parse(stored) as ClaudeCredentials; } catch { /* ignore */ }
    }

    // 2. Try ~/.claude/.credentials.json
    const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
    try {
      const raw = fs.readFileSync(credPath, 'utf8');
      const parsed = JSON.parse(raw);
      const oauth = parsed?.claudeAiOauth;
      if (oauth?.accessToken) {
        return {
          accessToken: oauth.accessToken,
          refreshToken: oauth.refreshToken ?? '',
          expiresAt: oauth.expiresAt ?? 0,
        };
      }
    } catch { /* file absent */ }

    return null;
  }

  private async maybeRefreshToken(creds: ClaudeCredentials): Promise<ClaudeCredentials> {
    const fiveMinutes = 5 * 60;
    if (creds.expiresAt - Date.now() / 1000 > fiveMinutes) return creds;
    if (!creds.refreshToken) return creds;

    const res = await httpRequest('https://claude.ai/api/auth/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: creds.refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }),
      timeoutMs: 10_000,
    });
    const json = JSON.parse(res.body);
    const refreshed: ClaudeCredentials = {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? creds.refreshToken,
      expiresAt: Math.floor(Date.now() / 1000) + (json.expires_in ?? 86400),
    };
    await this.secrets.set('claude.credentials', JSON.stringify(refreshed));
    return refreshed;
  }

  // --- CLI PTY strategy ---

  private async tryCLI(): Promise<UsageSnapshot | null> {
    const binary = await this.findClaudeBinary();
    if (!binary) return null;

    try {
      const output = await runCommand(binary, ['/usage'], 10_000);
      const parsed = parseCLIOutput(output);
      if (!parsed.session && !parsed.weekly) return null;

      const snap = emptySnapshot(PROVIDER_ID, 'cli');
      snap.primary = parsed.session;
      snap.secondary = parsed.weekly;
      return snap;
    } catch {
      return null;
    }
  }

  private async findClaudeBinary(): Promise<string | null> {
    const candidates = [
      'claude',
      '/usr/local/bin/claude',
      path.join(os.homedir(), '.local', 'bin', 'claude'),
      '/opt/homebrew/bin/claude',
    ];
    for (const bin of candidates) {
      try {
        child_process.execFileSync('which', [bin], { stdio: 'ignore' });
        return bin;
      } catch {
        if (fs.existsSync(bin)) return bin;
      }
    }
    return null;
  }

  // --- Web cookie strategy ---

  private async tryWebCookie(): Promise<UsageSnapshot | null> {
    const cookie = await this.secrets.get('claude.sessionCookie');
    if (!cookie) return null;

    try {
      const orgs = await httpGetJson<Array<{ uuid: string }>>(
        'https://claude.ai/api/organizations',
        { headers: { Cookie: `sessionKey=${cookie}` }, timeoutMs: 10_000 },
      );
      if (!orgs[0]?.uuid) return null;

      const orgUuid = orgs[0].uuid;
      const data = await httpGetJson<{ usage: Record<string, { used: number; limit: number; reset_at?: string }> }>(
        `https://claude.ai/api/organizations/${orgUuid}/usage`,
        { headers: { Cookie: `sessionKey=${cookie}` }, timeoutMs: 10_000 },
      );

      const snap = emptySnapshot(PROVIDER_ID, 'web');
      const s = data.usage?.session;
      const w = data.usage?.weekly;
      if (s) snap.primary = { label: 'Session', usedPercent: pct(s.used, s.limit), resetAt: s.reset_at };
      if (w) snap.secondary = { label: 'Weekly', usedPercent: pct(w.used, w.limit), resetAt: w.reset_at };
      return snap;
    } catch {
      return null;
    }
  }
}

// --- Helpers ---

function windowToRateWindow(label: string, w: UsageWindow): RateWindow {
  return {
    label,
    usedPercent: pct(w.used_count, w.limit_count),
    resetAt: w.reset_at,
  };
}

function pct(used: number, limit: number): number {
  if (!limit) return 0;
  return Math.min(100, (used / limit) * 100);
}

function parseCLIOutput(raw: string): { session?: RateWindow; weekly?: RateWindow } {
  const stripped = raw.replace(/\x1b\[[0-9;]*[mGKHF]/g, '').replace(/\r/g, '');
  const sessionPct  = /Current session[\s\S]{0,300}?(\d+)%/.exec(stripped);
  const sessionReset = /Current session[\s\S]{0,300}?[Rr]esets?\s+in\s+([^\n]+)/.exec(stripped);
  const weeklyPct   = /Current week[\s\S]{0,300}?(\d+)%/.exec(stripped);
  const weeklyReset  = /Current week[\s\S]{0,300}?[Rr]esets?\s+in\s+([^\n]+)/.exec(stripped);
  return {
    session: sessionPct ? {
      label: 'Session',
      usedPercent: parseInt(sessionPct[1], 10),
      resetAt: sessionReset ? relativeToIso(sessionReset[1].trim()) : undefined,
    } : undefined,
    weekly: weeklyPct ? {
      label: 'Weekly',
      usedPercent: parseInt(weeklyPct[1], 10),
      resetAt: weeklyReset ? relativeToIso(weeklyReset[1].trim()) : undefined,
    } : undefined,
  };
}

function relativeToIso(text: string): string | undefined {
  const now = Date.now();
  const days  = /(\d+)\s*day/.exec(text);
  const hours = /(\d+)\s*h/.exec(text);
  const mins  = /(\d+)\s*m/.exec(text);
  const ms =
    (days  ? parseInt(days[1])  * 86_400_000 : 0) +
    (hours ? parseInt(hours[1]) * 3_600_000  : 0) +
    (mins  ? parseInt(mins[1])  * 60_000     : 0);
  return ms > 0 ? new Date(now + ms).toISOString() : undefined;
}

function runCommand(binary: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = child_process.spawn(binary, args, {
      shell: true,
      env: { ...process.env, TERM: 'xterm' },
    });
    const chunks: Buffer[] = [];
    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    proc.stderr.on('data', (d: Buffer) => chunks.push(d));
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`claude CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.on('close', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}
