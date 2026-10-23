import type { IgnoredDirectoryMarker, IngestIgnoreContribution } from "../../../contracts/types/ingest-config.js";
import type { LanguageCapability } from "../../../contracts/types/language.js";

/**
 * Every language's ingest ignore contribution, merged into one: each vertical's
 * own `LanguageCapability.ingestIgnore` (declared in `<lang>/ingest-ignore.ts`),
 * patterns deduped by text, markers by their entry set. A new vertical
 * contributes by declaring `ingestIgnore` on its capability; nothing here
 * changes. The memoized aggregate the composition root injects is
 * `languageIngestIgnoreContribution` in `native.ts`.
 */
export function aggregateIngestIgnoreContributions(
  capabilities: ReadonlyMap<string, Pick<LanguageCapability, "ingestIgnore">>,
): IngestIgnoreContribution {
  const patterns = new Set<string>();
  const markers = new Map<string, IgnoredDirectoryMarker>();
  for (const { ingestIgnore } of capabilities.values()) {
    for (const pattern of ingestIgnore?.patterns ?? []) patterns.add(pattern);
    for (const marker of ingestIgnore?.markedDirectories ?? []) {
      const key = [...marker.entries].sort().join("\0");
      if (!markers.has(key)) markers.set(key, marker);
    }
  }
  return { patterns: [...patterns], markedDirectories: [...markers.values()] };
}
