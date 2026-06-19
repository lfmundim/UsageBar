import * as vscode from 'vscode';
import { ProviderRegistry } from './providers/registry';
import { UsageStore } from './store/usageStore';
import { SecretStore } from './util/secrets';
import { StatusBarController } from './statusBar/controller';
import { ClaudeProvider } from './providers/claude';
import { CodexProvider } from './providers/codex';
import { MistralProvider } from './providers/mistral';
import { DeepSeekProvider } from './providers/deepseek';
import { AntigravityProvider } from './providers/antigravity';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const registry = new ProviderRegistry();

  // Providers will be registered here in later tasks:
  // registry.register(new DeepSeekProvider(context));

  const store = new UsageStore(context);
  context.subscriptions.push(store);

  const secretStore = new SecretStore(context.secrets);
  registry.register(new ClaudeProvider(secretStore));
  registry.register(new CodexProvider(secretStore));
  registry.register(new MistralProvider(secretStore));
  registry.register(new DeepSeekProvider(secretStore));
  registry.register(new AntigravityProvider(secretStore));
  store.registerProviders(registry.getAll());

  // Re-start timer when refresh interval config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('usagebar.refreshInterval')) {
        store.startTimer();
      }
    }),
  );

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('usagebar.refresh', () => store.refresh()),
    vscode.commands.registerCommand('usagebar.openSettings', () =>
      vscode.commands.executeCommand('workbench.view.extension.usagebar-sidebar'),
    ),
  );

  const controller = new StatusBarController(store, registry);
  context.subscriptions.push(controller);

  store.startTimer();
}

export function deactivate(): void {
  // cleanup via context.subscriptions
}
