/**
 * EnrichmentRegistry — config-driven factory for enrichment providers.
 *
 * Reads config flags and returns active EnrichmentProvider instances.
 * New providers: add a config check + import here.
 */

import { GitEnrichmentProvider } from "../../../trajectory/git/provider.js";
import type { CodeConfig } from "../../../types.js";
import type { EnrichmentProvider } from "./types.js";

export function createEnrichmentProviders(config: CodeConfig): EnrichmentProvider[] {
  const providers: EnrichmentProvider[] = [];

  if (config.enableGitMetadata) {
    providers.push(new GitEnrichmentProvider());
  }

  return providers;
}
