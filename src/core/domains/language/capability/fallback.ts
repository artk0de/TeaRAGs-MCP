import type { LanguageCapability } from "../../../contracts/types/language.js";

/**
 * Languages with NO native provider — they fall back to the CharacterChunker at
 * syntax-neutral line boundaries (a chunk may split a symbol), and have no
 * codegraph. They are not in `LanguageFactory.supported()`; the generator
 * appends them so the matrix documents their absence of support explicitly, and
 * prime describes any such language an index holds with the same descriptor.
 */
export function unsupportedLanguageCapability(language: string): LanguageCapability {
  return {
    language,
    ast: { tier: "none", engine: "CharacterChunker" },
    tests: { tier: "na", detection: "—", tech: "—" },
    codegraph: { tier: "none", tech: "—", symbolKindRoles: { callee: new Set(), receiver: new Set() } },
    // Documentation rows only — never reach `LanguageFactory.capabilities()`, so
    // they are never stamped or compared. Declared to satisfy the descriptor.
    versions: { chunking: 1, walker: 1, codegraphSchema: 1 },
  };
}

/** The unsupported languages the generated matrix names explicitly. */
export const UNSUPPORTED_FALLBACK: readonly LanguageCapability[] = ["sql", "jsonc", "json"].map(
  unsupportedLanguageCapability,
);
