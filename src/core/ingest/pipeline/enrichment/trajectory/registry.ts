/**
 * EnrichmentRegistry — config-driven factory for enrichment providers.
 *
 * Reads config flags and returns active EnrichmentProvider instances.
 * New providers: add a config check + import here.
 */

import type { CodeConfig } from "../../../../types.js";
import type { EnrichmentProvider } from "../types.js";
import { GitEnrichmentProvider } from "./git/provider.js";

export function createEnrichmentProviders(config: CodeConfig): EnrichmentProvider[] {
  const providers: EnrichmentProvider[] = [];

  if (config.enableGitMetadata) {
    providers.push(new GitEnrichmentProvider());
  }

  return providers;
}
