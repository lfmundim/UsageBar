import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as child_process from 'child_process';
import * as vscode from 'vscode';
import { ProviderInterface, UsageSnapshot, RateWindow, emptySnapshot } from './base';
import { httpGetJson } from '../util/http';
import { SecretStore } from '../util/secrets';

const PROVIDER_ID = 'antigravity';
const CLOUDCODE_BASE = 'https://cloudcode-pa.googleapis.com';
const CLOUDCODE_METADATA = { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' };
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

// --- antigravity-usage token storage types ---

interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // unix ms
  email?: string;
  projectId?: string;
}

interface AguConfig {
  activeAccount?: string;
}

// --- Cloud Code API response types ---

interface LoadCodeAssistResponse {
  cloudaicompanionProject?: string | { id?: string };
  availablePromptCredits?: number;
  planInfo?: { monthlyPromptCredits?: number; planType?: string };
  allowedTiers?: Array<{ id?: string; isDefault?: boolean }>;
  paidTier?: { id?: string };
}

interface ModelInfo {
  displayName?: string;
  label?: string;
  quotaInfo?: {
    remainingFraction?: number;
    resetTime?: string;
    isExhausted?: boolean;
  };
}

interface FetchAvailableModelsResponse {
  models?: Record<string, ModelInfo>;
}

// --- Local language server types (for app probe) ---

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
      return (await this.loadTokens()) !== null;
    }
    const appPort = await this.discoverAppPort();
    if (appPort) return true;
    return (await this.loadTokens()) !== null;
  }

  async fetch(): Promise<UsageSnapshot> {
    const source = vscode.workspace
      .getConfiguration('usagebar')
      .get<string>('providers.antigravity.source', 'auto');

    if (source !== 'oauth') {
      const appResult = await this.tryAppProbe();
      if (appResult) return appResult;
    }

    const oauthResult = await this.tryOAuth();
    if (oauthResult) return oauthResult;

    throw new Error(
      'Antigravity: no data source. Run `antigravity-usage login` or start the Antigravity IDE extension.',
    );
  }

  /** Force-refresh stored tokens on demand (for the detail panel action). */
  async fetchFreshToken(): Promise<boolean> {
    try {
      const tokens = this.loadAguTokens();
      this.aguRefresh(tokens?.email);
      return true;
    } catch {
      return false;
    }
  }

  // --- App probe (Antigravity IDE extension language server) ---

  private async tryAppProbe(): Promise<UsageSnapshot | null> {
    try {
      const port = await this.discoverAppPort();
      if (!port) return null;
      const csrf = await this.extractCsrfToken();
      return await this.probeLanguageServer('127.0.0.1', port, csrf, 'app');
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

  private async probeLanguageServer(
    host: string,
    port: number,
    csrf: string | null,
    sourceLabel: string,
  ): Promise<UsageSnapshot | null> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (csrf) headers['X-CSRF-Token'] = csrf;

    const data = await httpGetJson<QuotaSummaryResponse>(
      `https://${host}:${port}/exa.language_server_pb.LanguageServerService/GetQuotaSummary`,
      { method: 'POST', headers, body: '{}', timeoutMs: 8_000 },
    );

    return this.parseGroupsSnapshot(data, sourceLabel);
  }

  // --- OAuth via antigravity-usage token storage ---

  private async tryOAuth(): Promise<UsageSnapshot | null> {
    const tokens = await this.loadTokens();
    if (!tokens) return null;

    try {
      let accessToken = tokens.accessToken;

      // Refresh if expired or expiring soon — delegate to antigravity-usage CLI
      if (Date.now() >= tokens.expiresAt - EXPIRY_BUFFER_MS) {
        this.aguRefresh(tokens.email);
        const fresh = this.loadAguTokens();
        if (!fresh) return null;
        accessToken = fresh.accessToken;
      }

      const authHeader = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };

      // Step 1: loadCodeAssist → get projectId
      const loadResp = await httpGetJson<LoadCodeAssistResponse>(
        `${CLOUDCODE_BASE}/v1internal:loadCodeAssist`,
        { method: 'POST', headers: { ...authHeader, 'User-Agent': 'antigravity' }, body: JSON.stringify({ metadata: CLOUDCODE_METADATA }), timeoutMs: 12_000 },
      );

      let projectId = tokens.projectId;
      if (loadResp.cloudaicompanionProject) {
        const proj = loadResp.cloudaicompanionProject;
        projectId = typeof proj === 'string' ? proj : proj.id;
      }

      // Step 2: fetchAvailableModels → quota per model
      const modelsResp = await httpGetJson<FetchAvailableModelsResponse>(
        `${CLOUDCODE_BASE}/v1internal:fetchAvailableModels`,
        {
          method: 'POST',
          headers: { ...authHeader, 'User-Agent': 'antigravity' },
          body: JSON.stringify(projectId ? { project: projectId } : {}),
          timeoutMs: 12_000,
        },
      );

      return this.parseModelsSnapshot(modelsResp, loadResp);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/HTTP 40[13]/.test(msg)) {
        throw new Error('Antigravity: token invalid or expired. Run `antigravity-usage login`.');
      }
      throw err;
    }
  }

  /**
   * Load tokens. Priority:
   * 1. antigravity-usage file storage (auto-refresh capable)
   * 2. VS Code secrets (manually pasted, no auto-refresh — fallback only)
   */
  private async loadTokens(): Promise<StoredTokens | null> {
    const agu = this.loadAguTokens();
    if (agu) return agu;

    // Manual override — used only if antigravity-usage is not installed/logged in
    const manual = await this.secrets.get('antigravity.googleOAuthToken');
    if (manual) {
      return { accessToken: manual, refreshToken: '', expiresAt: Date.now() + 3_600_000 };
    }
    return null;
  }

  /** Read tokens from antigravity-usage's file-based storage. */
  private loadAguTokens(): StoredTokens | null {
    try {
      const configDir = this.aguConfigDir();
      const configPath = path.join(configDir, 'config.json');

      let email: string | undefined;
      try {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')) as AguConfig;
        email = cfg.activeAccount;
      } catch { /* no config */ }

      if (email) {
        const safeName = email.replace(/[^a-zA-Z0-9@._-]/g, '_');
        const tokenPath = path.join(configDir, 'accounts', safeName, 'tokens.json');
        try {
          return JSON.parse(fs.readFileSync(tokenPath, 'utf8')) as StoredTokens;
        } catch { /* try legacy */ }
      }

      // Legacy single-account path
      const legacyPath = path.join(configDir, 'tokens.json');
      return JSON.parse(fs.readFileSync(legacyPath, 'utf8')) as StoredTokens;
    } catch {
      return null;
    }
  }

  private aguConfigDir(): string {
    const home = os.homedir();
    if (process.platform === 'win32') {
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'antigravity-usage');
    }
    if (process.platform === 'darwin') {
      return path.join(home, 'Library', 'Application Support', 'antigravity-usage');
    }
    return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'antigravity-usage');
  }

  /**
   * Delegate token refresh to antigravity-usage CLI.
   * It owns the OAuth credentials; we just ask it to refresh and re-read the file.
   */
  private aguRefresh(email?: string): void {
    const bin = this.findAguBinary();
    if (!bin) throw new Error('antigravity-usage not found. Run: npm install -g antigravity-usage');
    const args = ['accounts', 'refresh'];
    if (email) args.push(email);
    child_process.execFileSync(bin, args, { timeout: 15_000, stdio: 'ignore' });
  }

  private findAguBinary(): string | null {
    // Direct PATH lookup
    try {
      const found = child_process.execSync('which antigravity-usage', {
        encoding: 'utf8', timeout: 3_000, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (found) return found;
    } catch { /* not in PATH */ }

    // fnm global installs
    try {
      const fnmRoot = path.join(os.homedir(), '.local', 'share', 'fnm', 'node-versions');
      const versions = fs.readdirSync(fnmRoot).sort().reverse();
      for (const v of versions) {
        const candidate = path.join(fnmRoot, v, 'installation', 'bin', 'antigravity-usage');
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch { /* no fnm */ }

    // Common global install paths
    const candidates = [
      '/usr/local/bin/antigravity-usage',
      '/opt/homebrew/bin/antigravity-usage',
      path.join(os.homedir(), '.local', 'bin', 'antigravity-usage'),
    ];
    return candidates.find((c) => fs.existsSync(c)) ?? null;
  }

  // --- Snapshot parsing ---

  /** Parse Cloud Code API response (fetchAvailableModels + loadCodeAssist). */
  private parseModelsSnapshot(
    modelsResp: FetchAvailableModelsResponse,
    loadResp: LoadCodeAssistResponse,
  ): UsageSnapshot {
    const snap = emptySnapshot(PROVIDER_ID, 'oauth');
    const preferGroup = vscode.workspace
      .getConfiguration('usagebar')
      .get<string>('providers.antigravity.group', 'gemini');

    const isGemini = (id: string, label: string) => /gemini/i.test(id) || /gemini/i.test(label);
    const isClaude = (id: string, label: string) => /claude|gpt/i.test(id) || /claude|gpt/i.test(label);

    const allModels = Object.entries(modelsResp.models ?? {})
      .filter(([id, m]) =>
        m.quotaInfo !== undefined &&
        !id.startsWith('chat_') && !id.startsWith('tab_') &&
        !id.includes('image') && !id.startsWith('rev') &&
        !id.includes('mquery') && !id.includes('lite'),
      )
      .map(([id, m]) => ({
        id,
        label: m.displayName ?? m.label ?? id,
        remaining: m.quotaInfo?.remainingFraction ?? 1,
        resetAt: m.quotaInfo?.resetTime,
      }));

    const geminiModels  = allModels.filter(({ id, label }) => isGemini(id, label));
    const claudeGptModels = allModels.filter(({ id, label }) => isClaude(id, label));

    const primaryModels   = preferGroup === 'gemini' ? geminiModels  : claudeGptModels;
    const secondaryModels = preferGroup === 'gemini' ? claudeGptModels : geminiModels;
    const primaryLabel    = preferGroup === 'gemini' ? 'Gemini' : 'Claude|GPT';
    const secondaryLabel  = preferGroup === 'gemini' ? 'Claude|GPT' : 'Gemini';

    // Primary group: smart-merge models that share the same quota pool
    const primaryWindows = mergeModelGroup(primaryModels, primaryLabel);
    if (primaryWindows[0]) snap.primary   = primaryWindows[0];
    if (primaryWindows[1]) snap.secondary = primaryWindows[1];
    for (const w of primaryWindows.slice(2)) snap.extra.push(w);

    // Secondary group: always one merged entry (single shared pool)
    const secondaryWindow = mergeAsOne(secondaryModels, secondaryLabel);
    if (secondaryWindow) snap.extra.push(secondaryWindow);

    // Prompt credits as balance
    const avail = loadResp.availablePromptCredits;
    const monthly = loadResp.planInfo?.monthlyPromptCredits;
    if (avail !== undefined && monthly !== undefined && monthly > 0) {
      snap.balanceUsd = avail;
      snap.capacityUsd = monthly;
    }

    return snap;
  }

  /** Parse local language server response (GetQuotaSummary → groups format). */
  private parseGroupsSnapshot(data: QuotaSummaryResponse, sourceLabel: string): UsageSnapshot {
    const snap = emptySnapshot(PROVIDER_ID, sourceLabel);
    const preferGroup = vscode.workspace
      .getConfiguration('usagebar')
      .get<string>('providers.antigravity.group', 'gemini');

    const group = selectGroup(data.groups, preferGroup);
    if (!group) return snap;

    const sorted = [...group.buckets].sort(
      (a, b) => a.remaining.remainingFraction - b.remaining.remainingFraction,
    );

    if (sorted[0]) snap.primary = bucketToRateWindow(sorted[0]);
    if (sorted[1]) snap.secondary = bucketToRateWindow(sorted[1]);
    for (const b of sorted.slice(2)) snap.extra.push(bucketToRateWindow(b));

    for (const g of data.groups) {
      if (g === group) continue;
      for (const b of g.buckets) {
        snap.extra.push({
          label: `${g.displayName} — ${b.displayName}`,
          usedPercent: (1 - b.remaining.remainingFraction) * 100,
          resetAt: b.remaining.description ? relativeToIso(b.remaining.description) : undefined,
        });
      }
    }

    return snap;
  }
}

// --- Helpers ---

type ModelEntry = { label: string; remaining: number; resetAt?: string };

/**
 * Merge models that share the same quota pool into one entry.
 * If all have the same remaining value → single "<groupLabel>" entry.
 * If split → outliers shown individually, majority group shown as "<groupLabel> (others)".
 */
function mergeModelGroup(models: ModelEntry[], groupLabel: string): RateWindow[] {
  if (models.length === 0) return [];

  // Round to 4 decimals to absorb float noise
  const key = (m: ModelEntry) => Math.round(m.remaining * 10_000);
  const byValue = new Map<number, ModelEntry[]>();
  for (const m of models) {
    const k = key(m);
    if (!byValue.has(k)) byValue.set(k, []);
    byValue.get(k)!.push(m);
  }

  if (byValue.size === 1) {
    const m = models[0];
    return [{ label: groupLabel, usedPercent: (1 - m.remaining) * 100, resetAt: m.resetAt }];
  }

  // Multiple distinct values: majority → "(others)", outliers → individual
  let majorityKey = 0;
  let majorityCount = 0;
  for (const [k, arr] of byValue) {
    if (arr.length > majorityCount) { majorityKey = k; majorityCount = arr.length; }
  }

  const result: RateWindow[] = [];
  for (const [k, arr] of byValue) {
    if (k === majorityKey) {
      const m = arr[0];
      result.push({ label: `${groupLabel} (others)`, usedPercent: (1 - m.remaining) * 100, resetAt: m.resetAt });
    } else {
      for (const m of arr) {
        result.push({ label: m.label, usedPercent: (1 - m.remaining) * 100, resetAt: m.resetAt });
      }
    }
  }
  // Most constrained first
  result.sort((a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0));
  return result;
}

/** Merge all models into a single entry using the most constrained value. */
function mergeAsOne(models: ModelEntry[], label: string): RateWindow | null {
  if (models.length === 0) return null;
  const worst = models.reduce((a, b) => a.remaining < b.remaining ? a : b);
  return { label, usedPercent: (1 - worst.remaining) * 100, resetAt: worst.resetAt };
}

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
    resetAt: b.remaining.description ? relativeToIso(b.remaining.description) : undefined,
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
