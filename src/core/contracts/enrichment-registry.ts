/**
 * EnrichmentRegistry — collects enrichment providers via interface.
 *
 * Lives in contracts/ because it works ONLY through the EnrichmentProvider
 * interface. It does not know which concrete providers exist.
 * api/ creates providers and registers them here.
 */

import type { EnrichmentProvider } from "./types/provider.js";

export class EnrichmentRegistry {
  private readonly providers: EnrichmentProvider[] = [];

  /** Register a provider instance. */
  register(provider: EnrichmentProvider): void {
    this.providers.push(provider);
  }

  /** All registered providers. */
  getAll(): EnrichmentProvider[] {
    return this.providers;
  }

  /** Check if a specific provider is registered by key. */
  has(key: string): boolean {
    return this.providers.some((p) => p.key === key);
  }
}
