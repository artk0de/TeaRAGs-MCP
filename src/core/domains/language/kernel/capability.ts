import type { LanguageSupportVersions } from "../../../contracts/types/language.js";
import type { ChunkSetBumpScopes } from "../../../contracts/types/rechunk.js";

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
 * walker 3: the resolution runner hands each file the run-global
 * `classAncestors` / `classPrependedAncestors` / `classExtends` and include-by
 * index of its own language FAMILY (bd tea-rags-mcp-nbf8q). One bare-name map
 * let a TypeScript `Error` answer `super`, the MRO and the include-by index for
 * a Ruby `Error`, so any polyglot index can hold edges resolved on another
 * language's hierarchy, whichever language the caller was.
 *
 * walker 4: the runner also hands each file its family's `functionReturnTypes`,
 * `structuredReturnTypes` and CHA hierarchy view (bd tea-rags-mcp-qea83). A Go
 * method `get` typed a Ruby `get`'s result, a Python `Store#load` answered for
 * a Ruby one, and a TypeScript `Error`'s subclasses joined a Ruby `Error`'s
 * cone. Bumped past an unreleased 3 because an index a worktree build already
 * stamped at 3 still holds those edges.
 *
 * codegraphSchema 2: `cg_symbols` gained `start_line` / `end_line` (migration
 * 024) and every writer of `codegraph.symbols.chunk.*` now maps a chunk to its
 * owner through one rule (bd tea-rags-mcp-9i2ow). Payload already on disk was
 * written under two disagreeing mappings, the heal reaches only symbols whose
 * signals move, and only a walk fills the new columns — so every index needs
 * `--force-enrichments codegraph`, across all languages.
 *
 * walker 5: `cg_symbols_edges_file` gained `imported_export_names` /
 * `reexported_export_names` (migration 030, bd tea-rags-mcp-r8hme.2). The
 * import→file engine and the runner's per-target dedupe carry them onto the
 * edge, unioned over every import of one target. No edge moves; only a walk
 * fills the columns, so the facade check reads the file-level rule until
 * `--force-enrichments codegraph` runs. `codegraphSchema` stays at 2: this
 * walker bump already routes every index to that same whole-collection
 * recompute, and a second axis would name the same remedy twice.
 */
export const sharedVersions: LanguageSupportVersions = {
  chunking: 1,
  walker: 5,
  codegraphSchema: 2,
};

/**
 * Which files each shared chunk-set bump touched (bd tea-rags-mcp-j4oww) — the
 * `*` half of `LanguageCapability.chunkSetBumpScopes`. A `sharedVersions.chunking`
 * revision with no entry here is unscoped and routes to the plain `--force`; one
 * that changed only test chunking declares `{ testFile: "only" }` under its
 * revision, and the drift report names the scoped force instead.
 */
export const sharedChunkSetBumpScopes: ChunkSetBumpScopes = {};
