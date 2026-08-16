/**
 * Per-language code versions — the three axes that decide whether a language's
 * indexed data is behind the code (bd tea-rags-mcp-frwka).
 *
 * Two halves with different owners. `chunking` / `walker` / `codegraphSchema`
 * are hand-bumped constants on the capability descriptor, so a change to a
 * language's hooks, walker or resolver is reviewed in the same file the
 * capability tier is (`.claude/rules/language-capability-sync.md` step 1
 * already routes every such change there). `grammar` is upstream's, read from
 * the installed package at runtime — declaring it by hand would just be a
 * second copy of `package.json` waiting to go stale.
 *
 * Deliberately NOT folded into `LanguageFactory.capabilities()`: that Map is
 * lightweight by contract (const imports, no FS, no grammar load) and this
 * function reads `node_modules`. The composition root calls it once.
 */

import { createRequire } from "node:module";

import type { LanguageCapability, LanguageCodeVersions } from "../../../contracts/types/language.js";

/** Reads an installed package's declared version. Injected so tests never touch `node_modules`. */
export type GrammarVersionReader = (packageName: string) => string | undefined;

const nodeRequire = createRequire(import.meta.url);

/**
 * Default reader: the grammar's own `package.json`, which is the version we
 * actually parse with — a range from our manifest would report what we asked
 * for, not what npm installed. Unresolvable package → undefined, and the
 * comparison then declines to claim grammar drift at all.
 */
export const readInstalledGrammarVersion: GrammarVersionReader = (packageName) => {
  try {
    const manifest = nodeRequire(`${packageName}/package.json`) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Resolve the full version stamp for every language the factory declares.
 * `grammar` is omitted — not defaulted — when the language has no grammar
 * package or the package cannot be resolved.
 */
export function resolveLanguageCodeVersions(
  capabilities: ReadonlyMap<string, LanguageCapability>,
  readGrammarVersion: GrammarVersionReader = readInstalledGrammarVersion,
): Map<string, LanguageCodeVersions> {
  const resolved = new Map<string, LanguageCodeVersions>();
  for (const [language, capability] of capabilities) {
    const { grammarPackage } = capability.ast;
    const grammar = grammarPackage === undefined ? undefined : readGrammarVersion(grammarPackage);
    resolved.set(language, {
      ...capability.versions,
      ...(grammar !== undefined ? { grammar } : {}),
    });
  }
  return resolved;
}
