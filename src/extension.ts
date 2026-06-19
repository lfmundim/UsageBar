import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('usagebar.refresh', () => {
      vscode.window.showInformationMessage('UsageBar: Refresh triggered (not yet implemented)');
    }),
    vscode.commands.registerCommand('usagebar.openSettings', () => {
      vscode.commands.executeCommand('workbench.view.extension.usagebar-sidebar');
    }),
  );

  // Status bar placeholder — will be replaced by StatusBarController in TASK-08
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBarItem.text = '$(pulse) UsageBar';
  statusBarItem.tooltip = 'AI usage tracking (loading…)';
  statusBarItem.command = 'usagebar.openSettings';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);
}

export function deactivate(): void {
  // cleanup handled via context.subscriptions
}
