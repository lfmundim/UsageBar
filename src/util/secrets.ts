import * as vscode from 'vscode';

/** Namespaced wrapper around vscode.SecretStorage. */
export class SecretStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async get(key: string): Promise<string | undefined> {
    return this.secrets.get(`usagebar.${key}`);
  }

  async set(key: string, value: string): Promise<void> {
    await this.secrets.store(`usagebar.${key}`, value);
  }

  async delete(key: string): Promise<void> {
    await this.secrets.delete(`usagebar.${key}`);
  }
}
