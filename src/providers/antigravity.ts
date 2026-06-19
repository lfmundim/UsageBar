import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as child_process from 'child_process';
import * as vscode from 'vscode';
import { ProviderInterface, UsageSnapshot, RateWindow, emptySnapshot } from './base';
import { httpGetJson } from '../util/http';
import { SecretStore } from '../util/secrets';

const PROVIDER_ID = 'antigravity';

interface QuotaGroup {
  displayName: string;
  buckets: QuotaBucket[];
}

interface QuotaBucket {
  displayName: string;
  remaining: {
    remainingFraction: number;
    description?: string;
  };
}

interface QuotaSummaryResponse {
  groups: QuotaGroup[];
}

export class AntigravityProvider implements ProviderInterface {
  readonly id = PROVIDER_ID;
  readonly displayName = 'Antigravity';

  constructor(private readonly secrets: SecretStore) {}

  async isAvailable(): Promise<boolean> {
    const source = vscode.workspace
      .getConfiguration('usagebar')
      .get<string>('providers.antigravity.source', 'auto');
    if (source === 'oauth') {
      return (await this.getOAuthToken()) !== null;
    }
    // auto or cli: check if app running or agy binary exists
    const appPort = await this.discoverAppPort();
    if (appPort) return true;
    return (await this.findAgyBinary()) !== null;
  }

  async fetch(): Promise<UsageSnapshot> {
    const source = vscode.workspace
      .getConfiguration('usagebar')
      .get<string>('providers.antigravity.source', 'auto');

    if (source !== 'oauth') {
      // Try app probe
      const appResult = await this.tryAppProbe();
      if (appResult) return appResult;

      // Try CLI probe
      if (source === 'auto') {
        const cliResult = await this.tryCLIProbe();
        if (cliResult) return cliResult;
      }
    }

    // Try OAuth
    const oauthResult = await this.tryOAuth();
    if (oauthResult) return oauthResult;

    throw new Error(
      'Antigravity: no data source available. Start the Antigravity app or install the `agy` CLI.',
    );
  }

  // --- App probe ---

  private async tryAppProbe(): Promise<UsageSnapshot | null> {
    try {
      const port = await this.discoverAppPort();
      if (!port) return null;
      const csrf = await this.extractCsrfToken();
      return await this.probeLanguageServer(`127.0.0.1`, port, csrf, 'app');
    } catch {
      return null;
    }
  }

  private async discoverAppPort(): Promise<number | null> {
    if (process.platform === 'win32') return null;
    try {
      const psOut = child_process.execSync('ps -ax -o pid= -o command=', {
        encoding: 'utf8', timeout: 5_000,
      });
      const match = psOut
        .split('\n')
        .find((l) => l.includes('--app_data_dir antigravity') && !l.includes('antigravity-ide'));
      if (!match) return null;

      const pid = match.trim().split(/\s+/)[0];
      const lsofOut = child_process.execSync(
        `lsof -nP -iTCP -sTCP:LISTEN -a -p ${pid}`,
        { encoding: 'utf8', timeout: 5_000 },
      );
      // Parse "TCP 127.0.0.1:54321 (LISTEN)"
      const portMatch = /127\.0\.0\.1:(\d+)/.exec(lsofOut);
      return portMatch ? parseInt(portMatch[1], 10) : null;
    } catch {
      return null;
    }
  }

  private async extractCsrfToken(): Promise<string | null> {
    if (process.platform === 'win32') return null;
    try {
      const psOut = child_process.execSync('ps -ax -o command=', {
        encoding: 'utf8', timeout: 5_000,
      });
      const line = psOut
        .split('\n')
        .find((l) => l.includes('--app_data_dir antigravity') && !l.includes('antigravity-ide'));
      if (!line) return null;
      const csrfMatch = /--(?:csrf_token|extension_server_csrf_token)\s+(\S+)/.exec(line);
      return csrfMatch?.[1] ?? null;
    } catch {
      return null;
    }
  }

  // --- CLI probe ---

  private async tryCLIProbe(): Promise<UsageSnapshot | null> {
    const binary = await this.findAgyBinary();
    if (!binary) return null;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usagebar-agy-'));
    let proc: child_process.ChildProcess | null = null;

    try {
      proc = child_process.spawn(binary, ['--app_data_dir', tmpDir, '--port', '0'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });

      const port = await new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), 10_000);
        let buf = '';
        proc!.stdout!.on('data', (chunk: Buffer) => {
          buf += chunk.toString();
          const m = /[Ll]istening on port (\d+)/.exec(buf);
          if (m) { clearTimeout(timer); resolve(parseInt(m[1], 10)); }
        });
        proc!.on('close', () => { clearTimeout(timer); resolve(null); });
      });

      if (!port) return null;

      return await this.probeLanguageServer('127.0.0.1', port, null, 'cli');
    } catch {
      return null;
    } finally {
      proc?.kill();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  private async findAgyBinary(): Promise<string | null> {
    const candidates = [
      'agy',
      path.join(os.homedir(), '.local', 'bin', 'agy'),
      '/opt/homebrew/bin/agy',
      path.join(os.homedir(), 'antigravity', 'bin', 'agy'),
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

  // --- Shared language server probe ---

  private async probeLanguageServer(
    host: string,
    port: number,
    csrf: string | null,
    sourceLabel: string,
  ): Promise<UsageSnapshot | null> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (csrf) headers['X-CSRF-Token'] = csrf;

    const data = await httpGetJson<QuotaSummaryResponse>(
      `https://${host}:${port}/exa.language_server_pb.LanguageServerService/GetQuotaSummary`,
      {
        method: 'POST',
        headers,
        body: '{}',
        timeoutMs: 8_000,
      },
    );

    return this.parseQuotaSummary(data, sourceLabel);
  }

  // --- OAuth ---

  private async tryOAuth(): Promise<UsageSnapshot | null> {
    const token = await this.getOAuthToken();
    if (!token) return null;
    try {
      const data = await httpGetJson<QuotaSummaryResponse>(
        'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: '{}',
          timeoutMs: 12_000,
        },
      );
      return this.parseQuotaSummary(data, 'oauth');
    } catch {
      return null;
    }
  }

  private async getOAuthToken(): Promise<string | null> {
    const stored = await this.secrets.get('antigravity.googleOAuthToken');
    if (stored) return stored;

    // Try CodexBar's OAuth cache (if CodexBar is installed)
    const codexbarCredsPath = path.join(
      os.homedir(), '.codexbar', 'antigravity', 'oauth_creds.json',
    );
    try {
      const raw = fs.readFileSync(codexbarCredsPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed?.access_token) return parsed.access_token;
    } catch { /* absent */ }

    return null;
  }

  // --- Parsing ---

  private parseQuotaSummary(data: QuotaSummaryResponse, sourceLabel: string): UsageSnapshot {
    const snap = emptySnapshot(PROVIDER_ID, sourceLabel);
    const preferGroup = vscode.workspace
      .getConfiguration('usagebar')
      .get<string>('providers.antigravity.group', 'gemini');

    // Find preferred group
    const group = selectGroup(data.groups, preferGroup);
    if (!group) return snap;

    // Sort by lowest remainingFraction (most constrained first)
    const sorted = [...group.buckets].sort(
      (a, b) => a.remaining.remainingFraction - b.remaining.remainingFraction,
    );

    if (sorted[0]) {
      snap.primary = bucketToRateWindow(sorted[0]);
    }
    if (sorted[1]) {
      snap.secondary = bucketToRateWindow(sorted[1]);
    }
    for (const b of sorted.slice(2)) {
      snap.extra.push(bucketToRateWindow(b));
    }

    // Add all groups as extra windows (for tooltip/sidebar detail)
    for (const g of data.groups) {
      if (g === group) continue;
      for (const b of g.buckets) {
        snap.extra.push({
          label: `${g.displayName} — ${b.displayName}`,
          usedPercent: (1 - b.remaining.remainingFraction) * 100,
          resetAt: b.remaining.description
            ? relativeToIso(b.remaining.description)
            : undefined,
        });
      }
    }

    return snap;
  }
}

// --- Helpers ---

function selectGroup(groups: QuotaGroup[], prefer: string): QuotaGroup | undefined {
  const isGemini = (name: string) => /gemini/i.test(name);
  const isClaude = (name: string) => /claude|gpt/i.test(name);
  if (prefer === 'gemini') {
    return groups.find((g) => isGemini(g.displayName)) ?? groups[0];
  }
  return groups.find((g) => isClaude(g.displayName)) ?? groups[0];
}

function bucketToRateWindow(b: QuotaBucket): RateWindow {
  return {
    label: b.displayName,
    usedPercent: Math.min(100, (1 - b.remaining.remainingFraction) * 100),
    resetAt: b.remaining.description
      ? relativeToIso(b.remaining.description)
      : undefined,
  };
}

function relativeToIso(text: string): string | undefined {
  const now = Date.now();
  const days  = /(\d+)\s*day/.exec(text);
  const hours = /(\d+)\s*h(?:our)?/.exec(text);
  const mins  = /(\d+)\s*m(?:in)?/.exec(text);
  const ms =
    (days  ? parseInt(days[1])  * 86_400_000 : 0) +
    (hours ? parseInt(hours[1]) * 3_600_000  : 0) +
    (mins  ? parseInt(mins[1])  * 60_000     : 0);
  return ms > 0 ? new Date(now + ms).toISOString() : undefined;
}
