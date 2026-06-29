import type { LanguageCapability } from "../../../contracts/types/language.js";

/**
 * Languages with NO native provider — they fall back to the CharacterChunker at
 * arbitrary offsets (a chunk may split a symbol), and have no codegraph. They
 * are not in `LanguageFactory.supported()`; the generator appends them so the
 * matrix documents their absence of support explicitly.
 */
export const UNSUPPORTED_FALLBACK: readonly LanguageCapability[] = ["sql", "jsonc", "json"].map((language) => ({
  language,
  ast: { tier: "none", engine: "CharacterChunker" },
  tests: { tier: "na", detection: "—", tech: "—" },
  codegraph: { tier: "none", tech: "—" },
}));
