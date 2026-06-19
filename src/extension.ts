import * as vscode from 'vscode';
import { ProviderRegistry } from './providers/registry';
import { UsageStore } from './store/usageStore';
import { SecretStore } from './util/secrets';
import { StatusBarController } from './statusBar/controller';
import { showProviderDetail } from './statusBar/detail';
import { ClaudeProvider } from './providers/claude';
import { CodexProvider } from './providers/codex';
import { MistralProvider } from './providers/mistral';
import { DeepSeekProvider } from './providers/deepseek';
import { AntigravityProvider } from './providers/antigravity';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const registry = new ProviderRegistry();

  const store = new UsageStore(context);
  context.subscriptions.push(store);

  const secretStore = new SecretStore(context.secrets);
  registry.register(new ClaudeProvider(secretStore));
  registry.register(new CodexProvider(secretStore));
  registry.register(new MistralProvider(secretStore));
  registry.register(new DeepSeekProvider(secretStore));
  registry.register(new AntigravityProvider(secretStore));
  store.registerProviders(registry.getAll());

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('usagebar.refreshInterval')) {
        store.startTimer();
      }
      if (e.affectsConfiguration('usagebar.providers')) {
        store.refresh();
      }
    }),
  );

  async function promptSecret(key: string, prompt: string, placeholder: string): Promise<void> {
    const value = await vscode.window.showInputBox({ prompt, placeHolder: placeholder, password: true, ignoreFocusOut: true });
    if (value !== undefined && value.trim()) {
      await secretStore.set(key, value.trim());
      await store.refresh();
      vscode.window.showInformationMessage(`UsageBar: ${key} saved.`);
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('usagebar.refresh', () => store.refresh()),
    vscode.commands.registerCommand('usagebar.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'usagebar'),
    ),
    vscode.commands.registerCommand('usagebar.showDetail', (providerId: string) =>
      showProviderDetail(providerId, store, registry),
    ),
    vscode.commands.registerCommand('usagebar.toggleMistralMetric', async () => {
      const cfg     = vscode.workspace.getConfiguration('usagebar');
      const current = cfg.get<string>('providers.mistral.metric', 'billing');
      await cfg.update('providers.mistral.metric', current === 'vibe' ? 'billing' : 'vibe', vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand('usagebar.setClaudeCookie', () =>
      promptSecret('claude.sessionCookie', 'Paste Claude session cookie (web source)', 'sk-ant-sid...'),
    ),
    vscode.commands.registerCommand('usagebar.setMistralCookie', () =>
      promptSecret('mistral.adminCookie', 'Paste Mistral Cookie header from admin.mistral.ai', 'ory_session_...'),
    ),
    vscode.commands.registerCommand('usagebar.setDeepseekApiKey', () =>
      promptSecret('deepseek.apiKey', 'Paste DeepSeek API key', 'sk-...'),
    ),
    vscode.commands.registerCommand('usagebar.setAntigravityToken', () =>
      promptSecret('antigravity.googleOAuthToken', 'Paste Antigravity Google OAuth token', 'ya29....'),
    ),
    vscode.commands.registerCommand('usagebar.clearSecrets', async () => {
      const pick = await vscode.window.showQuickPick(
        ['claude.sessionCookie', 'mistral.adminCookie', 'deepseek.apiKey', 'antigravity.googleOAuthToken', 'ALL'],
        { placeHolder: 'Select secret to clear' },
      );
      if (!pick) return;
      if (pick === 'ALL') {
        for (const k of ['claude.sessionCookie', 'mistral.adminCookie', 'deepseek.apiKey', 'antigravity.googleOAuthToken']) {
          await secretStore.delete(k);
        }
      } else {
        await secretStore.delete(pick);
      }
      vscode.window.showInformationMessage(`UsageBar: cleared ${pick}.`);
    }),
  );

  const controller = new StatusBarController(store, registry);
  context.subscriptions.push(controller);

  store.startTimer();
}

export function deactivate(): void {
  // cleanup via context.subscriptions
}
