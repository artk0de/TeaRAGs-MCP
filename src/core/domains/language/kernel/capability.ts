import type { LanguageSupportVersions } from "../../../contracts/types/language.js";

/**
 * Pseudo-language whose stamp vouches for every language at once. Defined in
 * contracts so the maintenance domain can compare it without importing this
 * one; re-exported here because this is where its numbers live.
 */
export { SHARED_LANGUAGE } from "../../../contracts/types/language.js";

/**
 * Versions of the sources every language vertical runs through. Bumped by
 * `.claude/rules/index-format-versions.md`; pinned by version-pins.test.ts.
 *
 * walker 2: the kernel gained return inference (4906f4fcc), type-fact channels
 * (fd51e5ce2), package re-export following (b88dd636b) and entry-narrowing
 * (2c321ba26) after every existing index stamped its languages at walker 1 —
 * edges moved for every language and no per-language number said so.
 *
 * codegraphSchema 2: `cg_symbols` gained `start_line` / `end_line` (migration
 * 024) and every writer of `codegraph.symbols.chunk.*` now maps a chunk to its
 * owner through one rule (bd tea-rags-mcp-9i2ow). Payload already on disk was
 * written under two disagreeing mappings, the heal reaches only symbols whose
 * signals move, and only a walk fills the new columns — so every index needs
 * `--force-enrichments codegraph`, across all languages.
 */
export const sharedVersions: LanguageSupportVersions = {
  chunking: 1,
  walker: 2,
  codegraphSchema: 2,
};
