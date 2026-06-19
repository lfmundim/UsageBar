import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as child_process from 'child_process';
import * as vscode from 'vscode';
import { ProviderInterface, UsageSnapshot, emptySnapshot } from './base';
import { httpGetJson } from '../util/http';
import { SecretStore } from '../util/secrets';

const PROVIDER_ID = 'mistral';

interface MistralBillingModel {
  input_tokens?: number;
  output_tokens?: number;
  cached_tokens?: number;
  total_cost?: number;
}

interface MistralBillingResponse {
  billing?: {
    completion?: { models?: Record<string, MistralBillingModel> };
    ocr?: { models?: Record<string, MistralBillingModel> };
    connectors?: { models?: Record<string, MistralBillingModel> };
    audio?: { models?: Record<string, MistralBillingModel> };
  };
}

interface VibeUsageData {
  usage_percentage: number;
  reset_at?: string;
}

export class MistralProvider implements ProviderInterface {
  readonly id = PROVIDER_ID;
  readonly displayName = 'Mistral';

  constructor(private readonly secrets: SecretStore) {}

  async isAvailable(): Promise<boolean> {
    const cookie = await this.getCookie();
    return cookie !== null;
  }

  async fetch(): Promise<UsageSnapshot> {
    const cookie = await this.getCookie();
    if (!cookie) {
      throw new Error('Mistral: no session cookie. Paste a Cookie: header from admin.mistral.ai in the UsageBar sidebar.');
    }

    const csrf = extractCsrf(cookie);
    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();

    const snap = emptySnapshot(PROVIDER_ID, 'web');

    // Fetch billing (required)
    const billing = await httpGetJson<MistralBillingResponse>(
      `https://admin.mistral.ai/api/billing/v2/usage?month=${month}&year=${year}`,
      {
        headers: {
          Cookie: cookie,
          ...(csrf ? { 'X-CSRFTOKEN': csrf } : {}),
          Referer: 'https://admin.mistral.ai/organization/usage',
        },
        timeoutMs: 15_000,
      },
    );

    const totalCost = sumBillingCost(billing);
    snap.balanceUsd = totalCost; // repurpose balanceUsd as "monthly spend"

    // Fetch Vibe plan (optional, non-fatal)
    const vibeData = await this.fetchVibe(cookie, csrf).catch(() => null);

    const metric = vscode.workspace
      .getConfiguration('usagebar')
      .get<string>('providers.mistral.metric', 'billing');

    const vibePercent = typeof vibeData?.usage_percentage === 'number' ? vibeData.usage_percentage : undefined;

    if (metric === 'vibe' && vibePercent !== undefined) {
      snap.primary = {
        label: 'Vibe plan',
        usedPercent: vibePercent,
        resetAt: vibeData?.reset_at,
      };
    } else {
      snap.primary = undefined;
    }

    if (vibePercent !== undefined) {
      snap.extra.push({
        label: 'Vibe plan',
        usedPercent: vibePercent,
        resetAt: vibeData?.reset_at,
      });
    }

    return snap;
  }

  private async fetchVibe(cookie: string, csrf: string | null): Promise<VibeUsageData | null> {
    const url =
      'https://console.mistral.ai/api-ui/trpc/billing.vibeUsage?batch=1&input=%7B%220%22%3A%7B%22json%22%3Anull%7D%7D';
    const data = await httpGetJson<Array<{ result?: { data?: { json?: VibeUsageData } } }>>(url, {
      headers: {
        Cookie: cookie,
        ...(csrf ? { 'X-CSRFToken': csrf } : {}),
        Referer: 'https://console.mistral.ai/codestral/cli',
      },
      timeoutMs: 4_000,
    });
    return data[0]?.result?.data?.json ?? null;
  }

  private async getCookie(): Promise<string | null> {
    const source = vscode.workspace
      .getConfiguration('usagebar')
      .get<string>('providers.mistral.cookieSource', 'auto');

    // Check stored secret first (both auto and manual paths store here)
    const stored = await this.secrets.get('mistral.adminCookie');
    if (stored) return stored;

    if (source === 'auto') {
      const imported = await this.tryImportFromBrowser();
      if (imported) {
        await this.secrets.set('mistral.adminCookie', imported);
        return imported;
      }
    }

    return null;
  }

  private async tryImportFromBrowser(): Promise<string | null> {
    // Only macOS Firefox is attempted (Chrome requires keychain decryption)
    if (process.platform !== 'darwin') return null;
    return this.tryFirefox();
  }

  private async tryFirefox(): Promise<string | null> {
    const profilesDir = path.join(
      os.homedir(),
      'Library', 'Application Support', 'Firefox', 'Profiles',
    );
    try {
      const profiles = fs.readdirSync(profilesDir);
      for (const profile of profiles) {
        const dbPath = path.join(profilesDir, profile, 'cookies.sqlite');
        if (!fs.existsSync(dbPath)) continue;
        try {
          const out = child_process.execFileSync('sqlite3', [
            dbPath,
            `SELECT name, value FROM moz_cookies WHERE host LIKE '%admin.mistral.ai%' OR host LIKE '%mistral.ai%'`,
          ], { encoding: 'utf8', timeout: 5_000 });
          const cookies = parseSqliteOutput(out);
          if (Object.keys(cookies).length > 0) {
            return Object.entries(cookies)
              .map(([k, v]) => `${k}=${v}`)
              .join('; ');
          }
        } catch { /* sqlite3 not installed or db locked */ }
      }
    } catch { /* profiles dir absent */ }
    return null;
  }
}

// --- Helpers ---

function extractCsrf(cookieHeader: string): string | null {
  const match = /csrftoken=([^;,\s]+)/.exec(cookieHeader);
  return match?.[1] ?? null;
}

function sumBillingCost(billing: MistralBillingResponse): number {
  let total = 0;
  const categories = billing.billing ?? {};
  for (const category of Object.values(categories)) {
    for (const model of Object.values((category as { models?: Record<string, MistralBillingModel> }).models ?? {})) {
      total += model.total_cost ?? 0;
    }
  }
  return total;
}

function parseSqliteOutput(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.trim().split('\n')) {
    const [name, ...rest] = line.split('|');
    if (name && rest.length > 0) result[name.trim()] = rest.join('|').trim();
  }
  return result;
}
