import * as vscode from 'vscode';
import { ProviderInterface, UsageSnapshot, emptySnapshot } from './base';
import { httpGetJson } from '../util/http';
import { SecretStore } from '../util/secrets';

const PROVIDER_ID = 'deepseek';

interface BalanceInfo {
  currency: string;
  total_balance: string;
  granted_balance: string;
  topped_up_balance: string;
}

interface DeepSeekBalanceResponse {
  is_available: boolean;
  balance_infos: BalanceInfo[];
}

export class DeepSeekProvider implements ProviderInterface {
  readonly id = PROVIDER_ID;
  readonly displayName = 'DeepSeek';

  constructor(private readonly secrets: SecretStore) {}

  async isAvailable(): Promise<boolean> {
    return (await this.getApiKey()) !== null;
  }

  async fetch(): Promise<UsageSnapshot> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error(
        'DeepSeek: no API key. Set DEEPSEEK_API_KEY environment variable or add key in UsageBar sidebar.',
      );
    }

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    };

    // Required: balance
    const balance = await httpGetJson<DeepSeekBalanceResponse>(
      'https://api.deepseek.com/user/balance',
      { headers, timeoutMs: 10_000 },
    );

    const snap = emptySnapshot(PROVIDER_ID, 'api');
    const selected = selectCurrency(balance.balance_infos);

    if (selected) {
      const total    = parseFloat(selected.total_balance);
      snap.balanceUsd = isNaN(total) ? 0 : total;

      // Store availability as a special extra window (not a rate window but used for tooltip)
      if (!balance.is_available) {
        snap.extra.push({
          label: '⚠ API unavailable',
          usedPercent: 100,
          resetAt: undefined,
        });
      }
    }

    // Optional: monthly spend (2-second grace period)
    try {
      await Promise.race([
        this.fetchMonthlyCost(apiKey, snap),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2_000)),
      ]);
    } catch { /* non-fatal */ }

    return snap;
  }

  private async fetchMonthlyCost(apiKey: string, snap: UsageSnapshot): Promise<void> {
    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();
    const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };

    const [_amount, cost] = await Promise.allSettled([
      httpGetJson(`https://platform.deepseek.com/api/v0/usage/amount?month=${month}&year=${year}`, {
        headers, timeoutMs: 2_000,
      }),
      httpGetJson<{ data?: { total_cost?: number } }>(
        `https://platform.deepseek.com/api/v0/usage/cost?month=${month}&year=${year}`,
        { headers, timeoutMs: 2_000 },
      ),
    ]);

    if (cost.status === 'fulfilled') {
      const monthlyCost = cost.value?.data?.total_cost;
      if (typeof monthlyCost === 'number') {
        snap.extra.push({
          label: `This month: $${monthlyCost.toFixed(2)}`,
          usedPercent: undefined,
          resetAt: undefined,
        });
      }
    }
  }

  private async getApiKey(): Promise<string | null> {
    // 1. Environment variables
    const envKey = process.env['DEEPSEEK_API_KEY'] || process.env['DEEPSEEK_KEY'];
    if (envKey) return envKey;

    // 2. VS Code secret store
    const stored = await this.secrets.get('deepseek.apiKey');
    if (stored) return stored;

    return null;
  }
}

// --- Helpers ---

function selectCurrency(infos: BalanceInfo[]): BalanceInfo | null {
  if (!infos || infos.length === 0) return null;

  // Prefer USD with positive balance
  const usdPositive = infos.find(
    (b) => b.currency === 'USD' && parseFloat(b.total_balance) > 0,
  );
  if (usdPositive) return usdPositive;

  // First entry with positive balance
  const anyPositive = infos.find((b) => parseFloat(b.total_balance) > 0);
  if (anyPositive) return anyPositive;

  // First USD entry
  const firstUsd = infos.find((b) => b.currency === 'USD');
  if (firstUsd) return firstUsd;

  // First entry
  return infos[0];
}
