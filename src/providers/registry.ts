import * as vscode from 'vscode';
import { ProviderInterface } from './base';

/**
 * Holds all provider instances. Providers are registered once at activation
 * and the registry does not change at runtime (VS Code reload required for
 * enabling/disabling providers).
 */
export class ProviderRegistry {
  private providers: ProviderInterface[] = [];

  register(provider: ProviderInterface): void {
    this.providers.push(provider);
  }

  getAll(): ProviderInterface[] {
    return [...this.providers];
  }

  getById(id: string): ProviderInterface | undefined {
    return this.providers.find((p) => p.id === id);
  }
}
