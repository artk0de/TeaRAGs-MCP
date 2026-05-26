import type { LanguageFactory, LanguageProvider } from "../../contracts/types/language.js";
import { UnsupportedLanguageError } from "./errors.js";

/**
 * Skeleton `LanguageFactory` (spec §1, §4, migration step 1). It establishes
 * the composition-root surface — `create(lang)` (keyed family resolver) and
 * `supported()` — before any per-language vertical exists. Until the verticals
 * land (migration step 2: ruby, ts, …), `supported()` is empty and `create`
 * throws `UnsupportedLanguageError` for every language.
 *
 * `create` is intended to spawn a FRESH `LanguageProvider` per call (each with
 * its own tree-sitter `Parser`, spec §5); callers cache per language. The
 * registration map and Parser construction are filled in per-language vertical.
 */
export class LanguageFactoryImpl implements LanguageFactory {
  // TODO: wired in per-language verticals (spec migration step 2) — each vertical
  //       registers its `LanguageProvider` builder here, keyed by language string.
  create(lang: string): LanguageProvider {
    throw new UnsupportedLanguageError(lang);
  }

  supported(): string[] {
    return [];
  }
}
