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
 *
 * The type-abstractness census (bd tea-rags-mcp-r8hme.8) — every language's
 * walker counts abstract / concrete type declarations per file, persisted on
 * `cg_symbols_files` (migration 032) for the main-sequence detector — ships
 * under this release's walker 5 and re-pins the digests without bumping
 * again. Only a walk fills the columns; until the release's
 * `--force-enrichments codegraph` runs, the detector reports those components
 * `unmeasured`.
 *
 * chunking 2 is this release's ONE chunking bump, shared by two changes:
 *   - an oversized symbol is cut on its statement boundaries into
 *     `#part1..#partN` parts, numbered once, each prefixed with its enclosing
 *     context instead of overlapping raw lines; markdown sections are cut
 *     between blocks and the character fallback between syntax-neutral units
 *     (bd tea-rags-mcp-y5vx4, tea-rags-mcp-308ff);
 *   - test files are chunked by EXAMPLE (bd tea-rags-mcp-msv3l, epic
 *     tea-rags-mcp-phftd) — `kernel/test-scope-chunks.ts` emits one chunk per
 *     example with the id `<top>.<scope>.<example>` and a `test_scope`
 *     parentType, and the engine honours a hook-provided parentType.
 * Every language's test-chunker migration onto the kernel shipped in the same
 * release lands under it and re-pins its own `chunking` digest without bumping
 * again. The chunk set moves in every language and no narrower drift scope is
 * declared, so every index needs `tea-rags index-codebase --force`.
 */
export const sharedVersions: LanguageSupportVersions = {
  // chunking 3, bd tea-rags-mcp-nu05a: a heading-less markdown document and an
  // oversized preamble are split under maxChunkSize instead of emitted whole.
  // Only markdown files move — scoped in `sharedChunkSetBumpScopes`.
  // chunking 4, bd tea-rags-mcp-5xpq4: test setup is stored once per scope,
  // packed across consecutive scopes with per-member scope spans, tiny
  // examples are grouped instead of dropped. Unscoped — no entry below.
  chunking: 4,
  // walker 3: release v1.44.2 shipped shared walker 2 and a release cycle gets
  // ONE bump, so the branch-local 3..5 collapse into 3. Same walker 3, bd
  // tea-rags-mcp-r8hme.12: the resolution runner resolves `typeOnlyImports`
  // into `GraphEdges.typeOnlyFileEdges`. Same walker 3, bd
  // tea-rags-mcp-39xca.14: the barrier derives `structural` hierarchy rows
  // (`kernel/structural-conformance.ts`), so the CHA cone reaches implementers
  // no `implements` / subclass clause names. Same walker 3, bd
  // tea-rags-mcp-7t2ee: the runner records each file's hierarchy dependencies
  // (`cg_hierarchy_dependencies`, migration 039) so an incremental run
  // re-resolves the unchanged callers whose cone moved. No edge of a full run
  // moves; only a walk fills the table, which this walker's
  // `--force-enrichments codegraph` already does — so `codegraphSchema` stays.
  walker: 3,
  codegraphSchema: 2,
};

/**
 * Which files each shared chunk-set bump touched (bd tea-rags-mcp-j4oww) — the
 * `*` half of `LanguageCapability.chunkSetBumpScopes`. A `sharedVersions.chunking`
 * revision with no entry here is unscoped and routes to the plain `--force`; one
 * that changed only test chunking declares `{ testFile: "only" }` under its
 * revision, and the drift report names the scoped force instead.
 */
export const sharedChunkSetBumpScopes: ChunkSetBumpScopes = {
  chunking: { 3: { fileExtensions: [".md", ".markdown"] } },
};
