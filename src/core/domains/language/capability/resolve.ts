import type { LanguageCapability } from "../../../contracts/types/language.js";
import { unsupportedLanguageCapability } from "./fallback.js";
import { nativeLanguageCapabilities } from "./native.js";

/**
 * Capability descriptor for each of `languages` — the native one (the map
 * behind `LanguageFactory.capabilities()`), or the CharacterChunker fallback
 * for a language with no native provider. Loads no provider or grammar, so the
 * public barrel can carry it. Static ceiling only: the realized resolve rate is
 * per-index state the caller pairs in (bd tea-rags-mcp-xip6g, prime).
 */
export function resolveLanguageCapabilities(languages: readonly string[]): Map<string, LanguageCapability> {
  const native = nativeLanguageCapabilities();
  return new Map(
    languages.map((language) => [language, native.get(language) ?? unsupportedLanguageCapability(language)]),
  );
}
