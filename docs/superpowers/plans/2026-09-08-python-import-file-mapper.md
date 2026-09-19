# Python Import File Mapper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Python's file graph from being built out of paths a string
synthesiser made up. Today `defaultImportFileEdges` pushes a fake call through
the resolver chain and `importMatch` commits a FILE-ONLY edge on
`mapPythonImportToFile`'s guess, so a package import lands on `dcim/models.py`
when the real file is `netbox/dcim/models/__init__.py` — 39% of netbox's
first-party absolute imports, 62% of ugnest's. Those rows are persisted
unfiltered, and every Python file signal (fanIn, fanOut, instability,
transitiveImpact, isHub) is computed over them. This plan introduces one
`ImportFileMapper` seam that answers `project | external | unknown` from the
symbol table alone, routes the four consumers that ask "which file does this
import name" through it, teaches the walker to keep the NAMES an import binds,
and adds a Python `importedName` strategy that reaches a re-exported declaration
through the barrel it was imported from.

**Architecture:** One contract (`ImportFileMapper`) + one shared engine
(`resolveImportFileEdges`) in `domains/language/`, one Python implementation
(`PythonImportFileMapper`) that probes `GlobalSymbolTable.hasFile` /
`hasFilesUnder` — never the disk — and one relocation (`reexportOriginFile` from
the TypeScript strategies into `kernel/`, byte-identical, re-exported so no TS
consumer or TS test moves). Python's `resolveFileEdges` override then replaces
`defaultImportFileEdges` for Python, and the new
`PythonImportedNameSymbolResolutionStrategy` sits at chain index 4 — after
`localBinding`, before `importMatch` — so an imported binding resolves through
its declaring file instead of through short-name fan-out.

**Tech Stack:** TypeScript (NodeNext, `strict`), vitest, tree-sitter, tsx for
the corpus harnesses. New code in `src/core/domains/language/` and
`src/core/domains/language/python/`; the contract change is two additive
declarations in `src/core/contracts/types/language.ts`.

**Spec:**
docs/superpowers/specs/2026-09-03-python-codegraph-unification-program-design.md
— "Decision records → E2 seam 1" (`9fgdi`)

## Decision record

The nine decisions this plan encodes. They are settled; a task that finds them
inconvenient reports back rather than re-opening them.

1. **The seam is a contract, not a function.**
   `ImportFileTarget = { kind: "project"; relPath } | { kind: "external" } | { kind: "unknown" }`
   and `ImportFileMapper.mapImportToFile(importText, fromFile, ctx)` go into
   `contracts/types/language.ts` (additive). Three states, not two: "I know it
   is a library" and "I cannot tell" drive different consumer behaviour —
   `external` is a resolution STOP (the q9u85 external gate), `unknown` keeps
   today's conservative fallback. A two-state `RelPath | null` would collapse
   them and either fabricate edges for numpy or drop real ones.

2. **The edge builder is shared, the mapper is per language.**
   `resolveImportFileEdges(extraction, mapper, ctx)` in
   `src/core/domains/language/import-file-edges.ts` turns `extraction.imports`
   into `GraphEdges["fileEdges"]`: one edge per `project` mapping, self-loop
   dropped, `importText` carried verbatim; `external` and `unknown` produce no
   edge. Python wires it through `resolveFileEdges` in `python/index.ts`.
   TypeScript keeps its own `ts-path-mapper` this seam — it probes disk via a
   memoized `existsSync` and moving it is a separate risk surface. Follow-up
   bead migrates TS onto `ImportFileMapper`.

3. **Source roots are inferred from the symbol table, never from disk.** The
   import root is not the repo root in three of the five corpora (netbox
   `netbox/`, flask `src/`, polar `server/`), so a fixed root is wrong on sight.
   `PythonImportFileMapper` tries `""`, then every ancestor directory of
   `fromFile` deepest→shallowest, then a per-run memo of roots that already
   worked. A root R fits `a.b.c` when
   `hasFile(R/a/b/c.py) || hasFile(R/a/b/c/__init__.py) || hasFilesUnder(R/a/b/c) || hasFilesUnder(R/a)`.
   `hasFile` / `hasFilesUnder` are O(1) and land in E0; production code calls no
   `existsSync` / `statSync`. Manifest-declared roots (`pyproject.toml`) are a
   follow-up bead.

4. **A package import answers `<dir>/__init__.py`, and a namespace package
   answers `unknown`.** An empty `__init__.py` is a real file with zero symbols,
   so membership must be asked with `hasFile` (file index), not inferred from
   `hasFilesUnder` (directory index). For a PEP 420 namespace directory —
   `hasFilesUnder(dir)` true, `hasFile(dir/__init__.py)` false — the honest
   answer is `unknown`. `cg_symbols_edges_file.target_rel_path` is a free
   VARCHAR with no foreign key, so a DIRECTORY would physically store, but it
   joins nothing: `getFanInP95` LEFT JOINs `cg_symbols_files.rel_path`, the
   `transitiveImpact` recursion walks `target_rel_path → rel_path`, and a
   directory row is a dead node that only inflates the source's `fanOut`. That
   is the same defect class as today's phantom, so no edge is better than a
   directory edge. Follow-up bead: attribute namespace-package imports to their
   member files.

5. **The consumers migrate in the same change as the mapper.** Four of them:
   `python-import-match.ts` (`project` → today's behaviour on a REAL path;
   `external` → `CONTINUE` so the external gate can classify; `unknown` →
   today's file-only commit), `resolveTypeFile` in `python-local-binding.ts`,
   `PythonExternalVocabulary.isQualifiedReceiverExternal`, and the new
   `resolveFileEdges` override. Leaving any of them on the string synthesiser
   reintroduces the phantom through a side door and makes the oracle unreadable.

6. **The walker keeps the names, not just the module text.** `importText` stays
   byte-identical (`"a.b"`, `"a"` for `from a import b, c`, `"."`, `".a"`);
   `importedNames` and `importedBindings` are populated alongside it.
   `importedBindings` maps LOCAL name → imported name: `from a import b as c` is
   `{ c: "b" }`, `import a.b as x` is `{ x: "a.b" }`, and plain `import a.b`
   binds `a` (Python binds the TOP package, not the submodule), so it is
   `{ a: "a.b" }`. A star import contributes `"*"` to `importedNames` and
   nothing to `importedBindings`. `python/capability.ts` `versions.walker` → 2.

7. **`reexportOriginFile` relocates, it does not get re-implemented.** It moves
   byte-identically from `typescript/resolver/strategies/shared.ts` to
   `src/core/domains/language/kernel/reexport-origin.ts`, with
   `pickSingleCandidate` if that helper lives in the same file, and the TS
   `shared.ts` re-exports both. Every TS consumer and every TS test keeps its
   import path. Relocation discipline: `.claude/rules/resolver-architecture.md`
   §4 — moved, never rewritten.

8. **The new strategy sits at chain index 4, and the index is the argument.**
   `PythonImportedNameSymbolResolutionStrategy` goes after `localBinding` and
   before `importMatch`: a locally-typed variable still wins (that is a narrower
   fact), and an imported binding must be tried before `importMatch` falls back
   to matching the receiver against the import's last segment. It answers
   exactly three ways — `resolved` (pinned), `DROP` (the binding maps to an
   `external` module), `CONTINUE` (ambiguous or nothing). Star imports resolve
   only when the declaration is unique.

9. **Two unit assertions that pin phantom targets are updated, and only those.**
   `strategies.test.ts` ~127 (`ExitStack`) and ~246 (`reaction.py`) assert the
   synthesised path. They are updated with a one-line comment citing this plan
   and `docs/superpowers/specs/2026-08-10-deferred-symbol-resolution-design.md`
   §"Measured outcome (Python and Java)". Every other existing test stays
   untouched — a task that needs a THIRD test edited has found a regression, not
   a stale assertion.

## Global Constraints

- **No disk probing in production Python resolution.** `existsSync`, `statSync`,
  `readdirSync` and `fs` in any form are banned from `python/resolver/**`. The
  TS mapper's memoized `existsSync`
  (`typescript/resolver/ts-path-mapper.ts:30-100`) is precedent for TypeScript,
  not licence for Python: pass-2 resolution runs inside the codegraph provider
  with a hydrated symbol table and no guarantee the working tree still matches.
  `hasFile` / `hasFilesUnder` are the only membership oracle. A grep for
  `existsSync` under `python/` must be empty at the end of Task 6.
- **`importText` is byte-identical after Task 2.** The walker gains fields; it
  never changes the one that already exists. Task 2's test asserts the exact
  strings for `import a.b`, `from a import b, c`, `from . import x`,
  `from .a import b`, `from a import *`, `import a.b as x`.
- **Edges MOVE, and that is the point.** The chain tally's `edges` /`fileOnly` /
  `unresolved` counts for Python are NOT expected to stay identical — a phantom
  target becoming a real one changes every one of them. What must stay 0 is
  chain DRIFT (a call taking a different chain than the one the tally's `CHAINS`
  table declares). The jedi oracle is the correctness gate, not the tally.
- **Oracle gate, per corpus, every task that can move resolution.** `lost` = 0
  (a call the chain resolved correctly before and does not now), `phantom` not
  up, `skippedInProject` not up, `match` up. Reported per corpus AND per
  receiverKind; a five-corpus headline is never quoted without its rows (spec
  §Measurement policy).
- **TypeScript suite untouched and green.**
  `git diff --stat -- tests/core/domains/language/typescript` must be empty at
  the end of Task 4 and stay empty.
- **Perf gate.** Peak RSS ≤ +20% of the recorded baseline per corpus (httpx 260
  MB, flask 275 MB, ugnest 352 MB, polar 959 MB, netbox 1,293 MB); wall within
  +25% under equal load. The mapper's memo is what keeps this true — it is
  per-symbol-table-identity, invalidated on `size()` change, and holds resolved
  roots plus a `Map` of already-answered import texts.
- **NDJSON spill discipline.** `ImportRef.importedBindings` is a plain
  `Record<string, string>` and `importedNames` a plain array. Never a `Map` or
  `Set` — a `FileExtraction` value serialises to `{}` and loses every entry
  (`contracts/types/codegraph-extraction.ts:8-11`).
- **Commit format.** One commit per task. `type(scope): subject (9fgdi)`, header
  ≤ 100 chars, body lines ≤ 100 chars,
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` trailer. Scopes:
  `contracts` for Task 1's contract half, `language` for everything else; Task 4
  is a `refactor(language)`.
- **No `Why:` line needed.** None of the touched files is on the deep-silo list
  in `.claude/rules/silo-pairing.md`. Do not add one.
- **Naming.** `.claude/rules/naming.md`: generic suffixes carry domain context.
  `ImportFileTarget` not `Target`; `PythonImportFileMapper` not `Mapper`;
  `PythonImportedNameSymbolResolutionStrategy` matches the existing
  `SymbolResolutionStrategy` family exactly.
- **Worktree per task.** Executed by a fresh Opus subagent in its own git
  worktree. A fresh worktree has no `build/` and the chunker pool forks the
  COMPILED worker, so run `npm ci` (once) and `npm run build` (once) before the
  first test run — a bare build, no `npm link`, no reindex. Keep any single tool
  call under 8 minutes.
- **E0 is a precondition.** `GlobalSymbolTable.hasFile` / `hasFilesUnder`,
  `PythonExternalVocabulary` (`python/resolver/python-external-vocabulary.ts`),
  `python/vocabulary/stdlib-modules.ts` and
  `scripts/py-codegraph-jedi-oracle.ts` must exist before Task 1 starts. If they
  do not, stop and report — do not stub them.

---

## File Structure

**Created**

| File                                                                                  | Single responsibility                                                                                       |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `src/core/domains/language/import-file-edges.ts`                                      | `resolveImportFileEdges` — imports + a mapper → file edges. Language-agnostic.                              |
| `src/core/domains/language/kernel/reexport-origin.ts`                                 | Relocated `reexportOriginFile` (+ `pickSingleCandidate`): follow a barrel to the file that DECLARES a name. |
| `src/core/domains/language/python/resolver/python-import-file-mapper.ts`              | `PythonImportFileMapper` — root inference, `.py` vs `__init__.py`, relative dots, external verdicts, memo.  |
| `src/core/domains/language/python/resolver/strategies/python-imported-name.ts`        | `PythonImportedNameSymbolResolutionStrategy` — imported binding / star import → declaring file.             |
| `src/core/domains/language/python/CLAUDE.md`                                          | Navigator stub for the Python vertical (create only if absent).                                             |
| `tests/core/domains/language/import-file-edges.test.ts`                               | Engine: one edge per project mapping, self-loop guard, external/unknown produce nothing, `importText` kept. |
| `tests/core/domains/language/python/resolver/python-import-file-mapper.test.ts`       | Mapper against an `InMemoryGlobalSymbolTable` shaped like the five corpora.                                 |
| `tests/core/domains/language/python/resolver/strategies/python-imported-name.test.ts` | The new strategy: pinned resolve, re-export hop, star import, external DROP, ambiguity CONTINUE.            |
| `tests/core/domains/language/python/walker/python-import-bindings.test.ts`            | Walker: `importText` byte-identical, `importedNames` / `importedBindings` per import dialect.               |

**Modified**

| File                                                                           | Change                                                                                           |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `src/core/contracts/types/language.ts`                                         | `ImportFileTarget` + `ImportFileMapper` (additive).                                              |
| `src/core/domains/language/python/walker/walker.ts`                            | `collectPythonImports` fills `importedNames` / `importedBindings`.                               |
| `src/core/domains/language/python/capability.ts`                               | `versions.walker` → 2.                                                                           |
| `src/core/domains/language/python/index.ts`                                    | `resolveFileEdges` wired onto the resolver facade.                                               |
| `src/core/domains/language/python/resolver/python-resolver.ts`                 | New strategy at chain index 4; `resolveFileEdges`; owns the mapper instance.                     |
| `src/core/domains/language/python/resolver/strategies/python-import-match.ts`  | Consumes the mapper; `external` → CONTINUE.                                                      |
| `src/core/domains/language/python/resolver/strategies/python-local-binding.ts` | `resolveTypeFile` consumes the mapper.                                                           |
| `src/core/domains/language/python/resolver/strategies/index.ts`                | Export the new strategy.                                                                         |
| `src/core/domains/language/python/resolver/index.ts`                           | Export `PythonImportFileMapper`.                                                                 |
| `src/core/domains/language/python/resolver/python-external-vocabulary.ts`      | `isQualifiedReceiverExternal` routes through the mapper; `isBareCallExternal` consults bindings. |
| `src/core/domains/language/typescript/resolver/strategies/shared.ts`           | Re-export the relocated `reexportOriginFile` / `pickSingleCandidate`.                            |
| `tests/core/domains/language/python/resolver/strategies/strategies.test.ts`    | Two phantom-pinning assertions updated with rationale (ONLY those two).                          |
| `src/core/domains/language/CLAUDE.md`                                          | One Mechanics paragraph for the mapper seam and the chain index.                                 |

---

## Context the implementer needs

Read these before Task 1; the plan assumes them.

- **Where Python's file edges come from today.**
  `CallEdgeResolutionRunner#buildFileEdges` (`resolution-runner.ts:274-298`)
  builds a `fileEdgeCtx` — it carries `symbolTable`, `projectRoot`,
  `gemfileContent`, `imports`, and the inheritance channels — then calls
  `resolver.resolveFileEdges` when the language has one, otherwise
  `defaultImportFileEdges` (`resolution-runner.ts:67-84`), which synthesises
  `{ callText: importText, receiver: last, member: last }` per import and pushes
  it through the full chain. Whatever comes back is deduped by
  `dedupeFileEdgesByTarget` (`:88-100`) — first occurrence per target wins,
  because `cg_symbols_edges_file` has PK `(source_rel_path, target_rel_path)`
  and one `import_text` column.
- **A directory target is storable and useless.**
  `cg_symbols_edges_file.target_rel_path` is `VARCHAR NOT NULL` with no foreign
  key (migration `001-cg-symbols-init.ts`), so nothing rejects a directory. But
  `getFanInP95` LEFT JOINs `cg_symbols_files.rel_path`
  (`duckdb/file-metrics-reader.ts:54`) and `getTransitiveImpact` recurses
  `target_rel_path → rel_path` (`:87-100`): a directory row joins nothing,
  contributes fanIn to no file, and only inflates the SOURCE's `fanOut`
  (`:26-31`, a bare `COUNT(*)` with no join). Hence decision 4.
- **`GlobalSymbolTable`** (`contracts/types/codegraph-symbols.ts:158-188`):
  `lookup(fqName) → SymbolDefinition[]`, `lookupByShortName(name, options)`,
  `size()`, `hydrate`, `shortNameDefCounts`. E0 adds `hasFile(relPath)` and
  `hasFilesUnder(dirRelPath)`. `SymbolDefinition` (`:228-233`) carries
  `symbolId`, `fqName`, `shortName`, `relPath`, `scope`.
  `InMemoryGlobalSymbolTable` lives in
  `src/core/domains/trajectory/codegraph/symbols/symbol-table.ts` and is what
  the existing Python resolver tests instantiate.
- **`ImportRef`** (`contracts/types/codegraph-extraction.ts:298-340`) already
  declares `importedNames?: string[]` and
  `importedBindings?: Record<string, string>` — TypeScript fills them (local
  name → exported name; a default import and `* as ns` appear in `importedNames`
  only). Python fills neither today.
- **Python symbolIds carry no module path.** `class Flask` in `src/flask/app.py`
  is `Flask`, not `flask.app.Flask`. So a mapper answer must be combined with a
  `relPath` filter over `lookup(name)` results — the fqName alone cannot
  disambiguate two same-named classes in different modules.
- **`resolveFileEdges`** is optional on `LanguageSymbolResolver`
  (`contracts/types/language.ts`, the `resolveFileEdges?` member): when present
  the provider delegates ALL file→file edge construction for that language to
  it. Ruby is the only implementor today.

---

## Task 1: the `ImportFileMapper` contract and the shared edge engine

**Files**

- Modify `src/core/contracts/types/language.ts`
- Create `src/core/domains/language/import-file-edges.ts`
- Create `tests/core/domains/language/import-file-edges.test.ts`

**Interfaces**

_Consumes_

```ts
import type {
  CallContext,
  FileExtraction,
  GraphEdges,
  RelPath,
} from "../../contracts/types/codegraph.js";
import type { ImportFileMapper } from "../../contracts/types/language.js";
```

`CallContext`, `FileExtraction`, `GraphEdges` and `RelPath` are ALREADY imported
by `contracts/types/language.ts` (its `import type { … } from "./codegraph.js"`
block) — the contract half of this task adds no new import.

_Produces_

```ts
// contracts/types/language.ts
export type ImportFileTarget =
  | { kind: "project"; relPath: RelPath }
  | { kind: "external" }
  | { kind: "unknown" };

export interface ImportFileMapper {
  mapImportToFile: (
    importText: string,
    fromFile: RelPath,
    ctx: CallContext,
  ) => ImportFileTarget;
}

// domains/language/import-file-edges.ts
export function resolveImportFileEdges(
  extraction: FileExtraction,
  mapper: ImportFileMapper,
  ctx: CallContext,
): GraphEdges["fileEdges"];
```

**Steps**

- [x] Prepare the worktree once: `npm ci`, then `npm run build`. Bare build — no
      `npm link`, no reindex. Worker-forking specs need the compiled worker.

- [x] Write the failing test file
      `tests/core/domains/language/import-file-edges.test.ts`:

```ts
/**
 * The shared import→file-edge engine (E2 seam 1, bd tea-rags-mcp-9fgdi). The
 * engine is deliberately dumb: a mapper answers project/external/unknown and
 * this turns the project answers into edges. Every judgement call — which root,
 * `.py` or `__init__.py`, is numpy external — belongs to the mapper and is
 * tested there.
 */
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  FileExtraction,
} from "../../../../src/core/contracts/types/codegraph.js";
import type {
  ImportFileMapper,
  ImportFileTarget,
} from "../../../../src/core/contracts/types/language.js";
import { resolveImportFileEdges } from "../../../../src/core/domains/language/import-file-edges.js";

function extractionWith(
  relPath: string,
  importTexts: string[],
): FileExtraction {
  return {
    relPath,
    language: "python",
    imports: importTexts.map((importText, i) => ({
      importText,
      startLine: i + 1,
    })),
    chunks: [],
    fileScope: [],
  };
}

function mapperFrom(
  answers: Record<string, ImportFileTarget>,
): ImportFileMapper {
  return {
    mapImportToFile: (importText) => answers[importText] ?? { kind: "unknown" },
  };
}

const ctx = {
  callerFile: "pkg/a.py",
  callerScope: [],
  imports: [],
} as unknown as CallContext;

describe("resolveImportFileEdges", () => {
  it("emits one edge per project mapping, carrying the import text verbatim", () => {
    const edges = resolveImportFileEdges(
      extractionWith("pkg/a.py", ["pkg.b", "pkg.sub"]),
      mapperFrom({
        "pkg.b": { kind: "project", relPath: "pkg/b.py" },
        "pkg.sub": { kind: "project", relPath: "pkg/sub/__init__.py" },
      }),
      ctx,
    );
    expect(edges).toEqual([
      { targetRelPath: "pkg/b.py", importText: "pkg.b" },
      { targetRelPath: "pkg/sub/__init__.py", importText: "pkg.sub" },
    ]);
  });

  it("emits nothing for an external mapping", () => {
    const edges = resolveImportFileEdges(
      extractionWith("pkg/a.py", ["numpy"]),
      mapperFrom({ numpy: { kind: "external" } }),
      ctx,
    );
    expect(edges).toEqual([]);
  });

  it("emits nothing for an unknown mapping", () => {
    const edges = resolveImportFileEdges(
      extractionWith("pkg/a.py", ["domains.orders"]),
      mapperFrom({ "domains.orders": { kind: "unknown" } }),
      ctx,
    );
    expect(edges).toEqual([]);
  });

  it("drops a self-loop: `from . import x` inside the package __init__", () => {
    const edges = resolveImportFileEdges(
      extractionWith("pkg/__init__.py", ["."]),
      mapperFrom({ ".": { kind: "project", relPath: "pkg/__init__.py" } }),
      ctx,
    );
    expect(edges).toEqual([]);
  });

  it("does NOT dedupe — the runner owns that (dedupeFileEdgesByTarget)", () => {
    const edges = resolveImportFileEdges(
      extractionWith("pkg/a.py", ["pkg.b", "pkg.b"]),
      mapperFrom({ "pkg.b": { kind: "project", relPath: "pkg/b.py" } }),
      ctx,
    );
    expect(edges).toHaveLength(2);
  });

  it("passes the OWNING file, not ctx.callerFile, as fromFile", () => {
    const seen: string[] = [];
    const mapper: ImportFileMapper = {
      mapImportToFile: (_importText, fromFile) => {
        seen.push(fromFile);
        return { kind: "unknown" };
      },
    };
    resolveImportFileEdges(extractionWith("pkg/deep/c.py", ["x"]), mapper, ctx);
    expect(seen).toEqual(["pkg/deep/c.py"]);
  });

  it("returns an empty array for a file with no imports", () => {
    expect(
      resolveImportFileEdges(
        extractionWith("pkg/a.py", []),
        mapperFrom({}),
        ctx,
      ),
    ).toEqual([]);
  });
});
```

- [x] Run it and watch it fail on the missing module:
      `npx vitest run tests/core/domains/language/import-file-edges.test.ts`.

- [x] Add the contract to `src/core/contracts/types/language.ts`, directly ABOVE
      `export interface LanguageSymbolResolver` so the seam and its consumer
      read together. No new imports — `CallContext` and `RelPath` are already in
      the file's `./codegraph.js` import block:

```ts
/**
 * What file, if any, an import statement names (bd tea-rags-mcp-9fgdi).
 *
 * Three states, not two. `external` is a POSITIVE verdict — the module belongs
 * to the stdlib or an installed distribution, so a resolver should stop rather
 * than keep guessing, and the external gate counts the call out of the recall
 * denominator. `unknown` means the mapper could not decide (an empty symbol
 * table on a cold pass, a PEP 420 namespace package with no `__init__.py`), and
 * every consumer must keep its pre-mapper conservative behaviour there.
 * Collapsing the two into `RelPath | null` is what makes a resolver either
 * fabricate an edge into numpy or drop a real one.
 */
export type ImportFileTarget =
  | { kind: "project"; relPath: RelPath }
  | { kind: "external" }
  | { kind: "unknown" };

/**
 * Translate an import statement's module text into the project file it names.
 *
 * The ONE place a language answers "which file is `foo.bar`". Every consumer
 * that used to synthesise a path itself — the file-edge builder, the
 * import-match strategy, local-binding type resolution, the external
 * vocabulary — asks this instead, so the answer cannot disagree with itself
 * between the file graph and the call graph.
 *
 * `fromFile` is the file CONTAINING the import (relative imports and
 * ancestor-root inference both need it), which is not always `ctx.callerFile`:
 * the file-edge pass maps a whole `FileExtraction`'s imports at once.
 *
 * Implementations answer from `ctx.symbolTable` membership, never from disk —
 * pass 2 runs against a hydrated table whose working tree may have moved on.
 */
export interface ImportFileMapper {
  mapImportToFile: (
    importText: string,
    fromFile: RelPath,
    ctx: CallContext,
  ) => ImportFileTarget;
}
```

- [x] Create `src/core/domains/language/import-file-edges.ts`:

```ts
/**
 * Import → file-edge construction, shared by every language whose file graph is
 * explicit imports (bd tea-rags-mcp-9fgdi, E2 seam 1).
 *
 * Replaces `defaultImportFileEdges`'s fake-call trick
 * (`trajectory/codegraph/symbols/resolution-runner.ts:67-84`) for languages
 * that supply an `ImportFileMapper`: instead of synthesising a call per import
 * and reading whatever the resolver chain happens to commit, ask the mapper
 * directly. The chain answers "what does this CALL reach"; a file edge asks
 * "what does this IMPORT name" — different questions that only accidentally
 * shared an implementation.
 *
 * Deliberately without judgement. Root inference, `.py` vs `__init__.py`,
 * stdlib membership, namespace packages — all of that belongs to the mapper.
 * What lives here is the part every language agrees on.
 */

import type {
  CallContext,
  FileExtraction,
  GraphEdges,
} from "../../contracts/types/codegraph.js";
import type { ImportFileMapper } from "../../contracts/types/language.js";

export function resolveImportFileEdges(
  extraction: FileExtraction,
  mapper: ImportFileMapper,
  ctx: CallContext,
): GraphEdges["fileEdges"] {
  const fileEdges: GraphEdges["fileEdges"] = [];
  for (const imp of extraction.imports) {
    const target = mapper.mapImportToFile(
      imp.importText,
      extraction.relPath,
      ctx,
    );
    // `external` and `unknown` both produce nothing. An external module has no
    // row in `cg_symbols_files` to point at, and an unknown one would be the
    // phantom this seam exists to remove.
    if (target.kind !== "project") continue;
    // A package `__init__.py` doing `from . import x` maps to itself. A
    // self-edge is a real row in `cg_symbols_edges_file` and would count into
    // the file's own fanIn and fanOut.
    if (target.relPath === extraction.relPath) continue;
    fileEdges.push({
      targetRelPath: target.relPath,
      importText: imp.importText,
    });
  }
  // NOT deduped here. `CallEdgeResolutionRunner#buildFileEdges` applies
  // `dedupeFileEdgesByTarget` to whatever either branch returns
  // (`resolution-runner.ts:296`), because the uniqueness is a property of the
  // persisted EDGE, not of any one language's import loop.
  return fileEdges;
}
```

- [x] Green:
      `npx vitest run tests/core/domains/language/import-file-edges.test.ts`.
- [x] `npx tsc --noEmit` clean.
- [x] Commit both halves as one:
      `feat(contracts): add ImportFileMapper seam and shared import file edges (9fgdi)`.

---

## Task 2: the Python walker keeps the names an import binds

**Files**

- Modify `src/core/domains/language/python/walker/walker.ts`
  (`collectPythonImports`, ~line 485)
- Modify `src/core/domains/language/python/capability.ts`
- Create
  `tests/core/domains/language/python/walker/python-import-bindings.test.ts`

**Interfaces**

_Consumes_ — unchanged signature, richer output:

```ts
function collectPythonImports(root: AstNode): ImportRef[];
function pickModuleText(node: AstNode): string | null; // untouched
```

_Produces_ — per `ImportRef`, in addition to today's `importText` / `startLine`:

```ts
importedNames?: string[];              // LOCAL names this statement binds; "*" for a star import
importedBindings?: Record<string, string>; // local name → the name the module exports it under
```

Both omitted when empty (emit-only-non-empty, as Ruby does for its optional
channels). One new private helper:

```ts
function pythonModuleBinding(
  moduleText: string,
  alias: string | null,
): { local: string; imported: string };
```

**Binding table this task must produce**

| Source                 | `importText` | `importedNames`  | `importedBindings`   |
| ---------------------- | ------------ | ---------------- | -------------------- |
| `import a`             | `"a"`        | `["a"]`          | `{ a: "a" }`         |
| `import a.b`           | `"a.b"`      | `["a"]`          | `{ a: "a.b" }`       |
| `import a.b as x`      | `"a.b"`      | `["x"]`          | `{ x: "a.b" }`       |
| `import a, b`          | two refs     | `["a"]`, `["b"]` | `{a:"a"}`, `{b:"b"}` |
| `from a import b, c`   | `"a"`        | `["b","c"]`      | `{ b:"b", c:"c" }`   |
| `from a import b as c` | `"a"`        | `["c"]`          | `{ c: "b" }`         |
| `from a import *`      | `"a"`        | `["*"]`          | omitted              |
| `from . import x`      | `"."`        | `["x"]`          | `{ x: "x" }`         |
| `from .a import b`     | `".a"`       | `["b"]`          | `{ b: "b" }`         |
| `import numpy as np`   | `"numpy"`    | `["np"]`         | `{ np: "numpy" }`    |

`import a.b` binds the TOP package `a` — that is Python's own rule, not a
simplification: after `import os.path`, the name in scope is `os`. The aliased
form `import a.b as x` binds `x` to the SUBMODULE, so the imported side is the
full dotted text in both rows. A star import names no single member, so it
contributes `"*"` to `importedNames` and nothing to `importedBindings` —
matching the TypeScript contract, where a namespace binding is a name but not a
member mapping.

**Steps**

- [x] Build the worktree once if this is a fresh one: `npm ci && npm run build`.

- [x] Write the failing test file
      `tests/core/domains/language/python/walker/python-import-bindings.test.ts`.
      It parses real Python through tree-sitter (same harness as
      `python-walker.test.ts`) so grammar drift is caught, not just regex
      behaviour:

```ts
/**
 * Import bindings on `ImportRef` (E2 seam 1, bd tea-rags-mcp-9fgdi). The walker
 * used to keep only the module text, so `from .models import Device` told a
 * resolver nothing about `Device` — the import-match strategy was left matching
 * a receiver against the module's last segment. These are the names the new
 * `importedName` strategy resolves through.
 *
 * `importText` is asserted in EVERY case: it is consumed by the file-edge
 * mapper, the external vocabulary and two persisted payload keys, and this task
 * must not move it by a byte.
 */
import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import { extractFromPythonFile } from "../../../../../../src/core/domains/language/python/walker/walker.js";

function importsOf(src: string, relPath = "pkg/a.py") {
  const parser = new Parser();
  parser.setLanguage(PyLang as unknown as Parser.Language);
  const tree = parser.parse(src);
  return extractFromPythonFile({
    tree,
    code: src,
    relPath,
    language: "python",
    chunks: [],
  }).imports;
}
```

```ts
describe("collectPythonImports — importText is unchanged", () => {
  it("keeps the exact module text for every dialect", () => {
    expect(importsOf("import a.b\n").map((i) => i.importText)).toEqual(["a.b"]);
    expect(importsOf("import a.b as x\n").map((i) => i.importText)).toEqual([
      "a.b",
    ]);
    expect(importsOf("from a import b, c\n").map((i) => i.importText)).toEqual([
      "a",
    ]);
    expect(importsOf("from a import *\n").map((i) => i.importText)).toEqual([
      "a",
    ]);
    expect(importsOf("from . import x\n").map((i) => i.importText)).toEqual([
      ".",
    ]);
    expect(importsOf("from .a import b\n").map((i) => i.importText)).toEqual([
      ".a",
    ]);
    expect(
      importsOf("from ..pkg.mod import b\n").map((i) => i.importText),
    ).toEqual(["..pkg.mod"]);
    expect(
      importsOf("import a, b\n")
        .map((i) => i.importText)
        .sort(),
    ).toEqual(["a", "b"]);
  });
});

describe("collectPythonImports — importedNames / importedBindings", () => {
  it("`import a.b` binds the TOP package, not the submodule", () => {
    const [imp] = importsOf("import a.b\n");
    expect(imp.importedNames).toEqual(["a"]);
    expect(imp.importedBindings).toEqual({ a: "a.b" });
  });

  it("`import a` binds itself", () => {
    const [imp] = importsOf("import a\n");
    expect(imp.importedNames).toEqual(["a"]);
    expect(imp.importedBindings).toEqual({ a: "a" });
  });

  it("`import a.b as x` binds the alias to the SUBMODULE", () => {
    const [imp] = importsOf("import a.b as x\n");
    expect(imp.importedNames).toEqual(["x"]);
    expect(imp.importedBindings).toEqual({ x: "a.b" });
  });

  it("`import numpy as np` binds np → numpy", () => {
    const [imp] = importsOf("import numpy as np\n");
    expect(imp.importedBindings).toEqual({ np: "numpy" });
  });

  it("`import a, b` yields one ref per target, each with its own binding", () => {
    const imps = importsOf("import a, b\n")
      .slice()
      .sort((l, r) => l.importText.localeCompare(r.importText));
    expect(imps.map((i) => i.importedBindings)).toEqual([
      { a: "a" },
      { b: "b" },
    ]);
  });

  it("`from a import b, c` binds both names identically", () => {
    const [imp] = importsOf("from a import b, c\n");
    expect(imp.importedNames).toEqual(["b", "c"]);
    expect(imp.importedBindings).toEqual({ b: "b", c: "c" });
  });

  it("`from a import b as c` maps the LOCAL name to the EXPORTED one", () => {
    const [imp] = importsOf("from a import b as c\n");
    expect(imp.importedNames).toEqual(["c"]);
    expect(imp.importedBindings).toEqual({ c: "b" });
  });

  it("`from a import *` names the star and binds no member", () => {
    const [imp] = importsOf("from a import *\n");
    expect(imp.importedNames).toEqual(["*"]);
    expect(imp.importedBindings).toBeUndefined();
  });

  it("`from . import x` keeps the package-relative name", () => {
    const [imp] = importsOf("from . import x\n", "pkg/__init__.py");
    expect(imp.importText).toBe(".");
    expect(imp.importedNames).toEqual(["x"]);
    expect(imp.importedBindings).toEqual({ x: "x" });
  });

  it("`from .models import Device, Rack as R` mixes plain and aliased", () => {
    const [imp] = importsOf(
      "from .models import Device, Rack as R\n",
      "dcim/views.py",
    );
    expect(imp.importText).toBe(".models");
    expect(imp.importedNames).toEqual(["Device", "R"]);
    expect(imp.importedBindings).toEqual({ Device: "Device", R: "Rack" });
  });

  it("parenthesised multi-line imports bind every name", () => {
    const src = "from .models import (\n    Device,\n    Rack,\n)\n";
    const [imp] = importsOf(src, "dcim/views.py");
    expect(imp.importedNames).toEqual(["Device", "Rack"]);
  });

  it("a bare side-effect import omits both channels", () => {
    const [imp] = importsOf("from a import *\n");
    expect(imp.importedBindings).toBeUndefined();
  });
});
```

- [x] Run it and watch the binding assertions fail (the `importText` ones
      already pass — that is the point):
      `npx vitest run tests/core/domains/language/python/walker/python-import-bindings.test.ts`.

- [x] Replace `collectPythonImports` in
      `src/core/domains/language/python/walker/walker.ts` (~line 485). Keep
      `pickModuleText` exactly as it is — it produces `importText`, which must
      not move:

```ts
/**
 * The LOCAL name an `import` statement binds, and the module it binds it to
 * (bd tea-rags-mcp-9fgdi).
 *
 * Unaliased `import a.b` binds `a`, NOT `a.b` — after `import os.path` the name
 * in scope is `os`. The aliased form binds the alias to the full submodule
 * path, so the imported side is the dotted text in both cases.
 */
function pythonModuleBinding(
  moduleText: string,
  alias: string | null,
): { local: string; imported: string } {
  if (alias) return { local: alias, imported: moduleText };
  return { local: moduleText.split(".")[0], imported: moduleText };
}

function collectPythonImports(root: AstNode): ImportRef[] {
  const out: ImportRef[] = [];
  walk(root, (node) => {
    if (node.type === "import_statement") {
      // `import a`, `import a.b`, `import a as x`, `import a, b`
      // Tree-sitter-python wraps each dotted_name (or aliased_import)
      // in `name` field of `dotted_as_name` etc. Walk children for
      // `dotted_name` / `aliased_import` nodes.
      for (const child of node.namedChildren) {
        const moduleText = pickModuleText(child);
        if (!moduleText) continue;
        const alias =
          child.type === "aliased_import"
            ? (child.childForFieldName("alias")?.text ?? null)
            : null;
        const { local, imported } = pythonModuleBinding(moduleText, alias);
        out.push({
          importText: moduleText,
          startLine: node.startPosition.row + 1,
          importedNames: [local],
          importedBindings: { [local]: imported },
        });
      }
    } else if (node.type === "import_from_statement") {
      // `from M import x` — the module is in `module_name` field.
      // Relative imports: `from .` / `from ..` — leading dots are
      // emitted as `import_prefix` nodes; preserve them so the
      // resolver can resolve relative paths.
      const startLine = node.startPosition.row + 1;
      const moduleField = node.childForFieldName("module_name");
      let prefix = "";
      for (const child of node.children) {
        if (child.type === "import_prefix") prefix = child.text;
      }
      // Everything that is not the module and not the dot prefix is an imported
      // NAME. There is no `childrenForFieldName` on `AstNode`, so the module is
      // excluded by node IDENTITY — `from a import a` is a real shape and a
      // text comparison would drop it.
      const importedNames: string[] = [];
      const importedBindings: Record<string, string> = {};
      for (const child of node.namedChildren) {
        if (child === moduleField || child.type === "import_prefix") continue;
        if (child.type === "wildcard_import") {
          // A star binds no single member: it is a name for the resolver's
          // star-import path and nothing for the binding table.
          importedNames.push("*");
          continue;
        }
        if (child.type === "aliased_import") {
          const importedName = child.childForFieldName("name")?.text;
          const localName = child.childForFieldName("alias")?.text;
          if (!importedName || !localName) continue;
          importedNames.push(localName);
          importedBindings[localName] = importedName;
          continue;
        }
        if (child.type === "dotted_name" || child.type === "identifier") {
          importedNames.push(child.text);
          importedBindings[child.text] = child.text;
        }
      }
      // Emit only non-empty: a channel the statement does not carry is absent,
      // never `[]` / `{}` — same discipline the Ruby walker applies to its
      // optional channels, and what keeps the NDJSON spill small.
      const names = importedNames.length > 0 ? { importedNames } : {};
      const bindings =
        Object.keys(importedBindings).length > 0 ? { importedBindings } : {};
      if (moduleField) {
        out.push({
          importText: prefix + (pickModuleText(moduleField) ?? ""),
          startLine,
          ...names,
          ...bindings,
        });
      } else if (prefix) {
        // `from . import x` — no module name, just the prefix.
        out.push({ importText: prefix, startLine, ...names, ...bindings });
      }
    }
  });
  return out;
}
```

- [x] Bump the walker version in
      `src/core/domains/language/python/capability.ts` — the walker's OUTPUT
      shape changed, which is exactly what the version gates:

```ts
  // codegraphSchema 2: bd tea-rags-mcp-ex28m — see typescript/capability.ts.
  // walker 2: bd tea-rags-mcp-9fgdi — `ImportRef` now carries importedNames /
  // importedBindings, which the importedName strategy and the import file
  // mapper resolve through. A file walked by walker 1 has neither.
  versions: { chunking: 1, walker: 2, codegraphSchema: 2 },
```

- [x] Green, including the two pre-existing walker suites —
      `python-walker.test.ts` asserts `importText` for the full import matrix
      and must not need an edit:
      `npx vitest run tests/core/domains/language/python/walker`.
- [x] `npx tsc --noEmit` clean.
- [x] Commit:
      `feat(language): fill Python importedNames and importedBindings (9fgdi)`.

---

## Task 3: `PythonImportFileMapper`

**Files**

- Create
  `src/core/domains/language/python/resolver/python-import-file-mapper.ts`
- Create
  `tests/core/domains/language/python/resolver/python-import-file-mapper.test.ts`
- Modify `src/core/domains/language/python/resolver/index.ts` (export it)

**Interfaces**

_Consumes_

```ts
import { posix } from "node:path";

import type {
  CallContext,
  GlobalSymbolTable,
  RelPath,
} from "../../../../contracts/types/codegraph.js";
import type {
  ImportFileMapper,
  ImportFileTarget,
} from "../../../../contracts/types/language.js";
import { isStdlibModule } from "../vocabulary/stdlib-modules.js"; // E0
```

From E0, on `GlobalSymbolTable`:

```ts
hasFile: (relPath: RelPath) => boolean; // O(1), no disk
hasFilesUnder: (dirRelPath: RelPath) => boolean; // O(1) refcounted directory index
```

_Produces_

```ts
export class PythonImportFileMapper implements ImportFileMapper {
  mapImportToFile(
    importText: string,
    fromFile: RelPath,
    ctx: CallContext,
  ): ImportFileTarget;
}
```

`mapPythonImportToFile` is NOT deleted and NOT changed. It stays the pure
candidate-path helper, and its nine unit tests in `python-resolver.test.ts:8-43`
stay green untouched. The mapper is what adds membership: candidate SHAPES from
the same arithmetic, verdicts from the table.

**The algorithm**

1. **Normalise.** Trim, strip a defensive ` as alias` suffix exactly as
   `mapPythonImportToFile` does. Empty text answers `unknown`.
2. **Relative import** (leading `.`): count the dots, walk up from
   `posix.dirname(fromFile)` by `dots - 1` levels, append the tail. The result
   is already anchored, so no root inference runs. Then probe (step 4).
   `from . import x` arrives as the module text `"."`, so the mapper cannot see
   `x` and answers the package itself, `<pkgdir>/__init__.py`; the STRATEGY
   (Task 5) is what tries `<pkgdir>/x.py` first.
3. **Absolute import**: try roots until one probes true. Order: `""`, then every
   ancestor directory of `fromFile` DEEPEST to SHALLOWEST, then every root
   already in the run memo. Deepest first because a monorepo's inner package
   root (`server/`) is more specific than the repo root, and a shallow root
   holding a same-named directory would otherwise shadow it.
4. **Probe** root R against segments `a.b.c`, in this order:
   - `hasFile(R/a/b/c.py)` gives `project` at that path. The module file wins
     over the package, matching Python's own import order and
     `mapPythonImportToFile`'s documented preference.
   - `hasFile(R/a/b/c/__init__.py)` gives `project` at the `__init__.py` — the
     15-62% of first-party absolute imports that land on a phantom today. Asked
     with `hasFile`, so an EMPTY `__init__.py` (a real file with zero symbols)
     still answers `project`.
   - `hasFilesUnder(R/a/b/c)` means the directory is in the project with no
     `__init__.py`: a PEP 420 namespace package. Answer `unknown` (decision 4)
     and record R as fitting, so sibling imports skip the root scan.
   - `hasFilesUnder(R/a)` means the root is right but the deeper path is not a
     file we hold — a submodule behind an ignore glob, a C extension. Answer
     `unknown`, record R.
   - otherwise R does not fit; try the next root.
5. **No root fits.** Root segment in the stdlib snapshot gives `external`.
   Otherwise a non-empty symbol table gives `external` (the module is not in the
   project and the table is trustworthy); an EMPTY table gives `unknown` — a
   cold or degraded pass must not be read as "everything is a library".
6. **Memo.** `WeakMap<GlobalSymbolTable, { size, roots, cache }>` keyed by table
   IDENTITY, invalidated when `size()` changes — the invalidation shape the TS
   path mapper uses for its `existsSync` memo
   (`typescript/resolver/ts-path-mapper.ts:30-100`), minus the disk. `cache` is
   keyed `${fromFileDir}\0${importText}`: two files in different directories can
   legitimately give the same import text different answers.

**The fixture — corpus shapes, inline**

The test builds an `InMemoryGlobalSymbolTable` from this file list. Each path
gets throwaway symbol definitions so `upsertFile` registers the file; an "empty"
`__init__.py` gets an EMPTY definition array, which is precisely the case
`hasFilesUnder` alone would get wrong.

```ts
/** relPath -> shortNames declared there. An empty array = a real, symbol-free file. */
const CORPUS_FILES: Record<string, string[]> = {
  // netbox: import root is `netbox/`, packages are directories with __init__.py
  "netbox/dcim/models/__init__.py": ["Device", "Rack"],
  "netbox/dcim/views.py": ["DeviceListView"],
  "netbox/dcim/__init__.py": [],
  "netbox/extras/ui/widgets.py": ["Widget"], // namespace pkg: no extras/ui/__init__.py
  "netbox/extras/__init__.py": [],
  "netbox/netbox/settings.py": ["Settings"], // root dir name repeats the package name
  // flask: import root is `src/`, alias re-exports in the package __init__
  "src/flask/__init__.py": ["Flask"],
  "src/flask/app.py": ["Flask"],
  "src/flask/sansio/app.py": ["App"], // namespace pkg: no sansio/__init__.py
  // polar: import root is `server/`
  "server/polar/health/endpoints.py": ["healthz"], // namespace pkg: no health/__init__.py
  "server/polar/order/service.py": ["OrderService"],
  "server/polar/order/__init__.py": [],
  // ugnest: import root is the repo root, `domains/` is a namespace package
  "domains/orders/handlers.py": ["place_order"],
  "domains/orders/__init__.py": [],
  "domains/billing/invoice.py": ["Invoice"], // no domains/__init__.py anywhere
  // httpx: import root is the repo root
  "httpx/_client.py": ["Client"],
  "httpx/__init__.py": ["Client"],
};
```

**Steps**

- [ ] Build the worktree once if fresh: `npm ci && npm run build`.

- [ ] Write the failing test
      `tests/core/domains/language/python/resolver/python-import-file-mapper.test.ts`:

```ts
/**
 * `PythonImportFileMapper` (E2 seam 1, bd tea-rags-mcp-9fgdi). The fixture
 * reproduces the root shapes of the five oracle corpora, because the bug this
 * class fixes is a root bug: `mapPythonImportToFile("dcim.models", …)` answers
 * `dcim/models.py` and netbox's file is `netbox/dcim/models/__init__.py`. The
 * import root is not the repo root in three of the five.
 *
 * Every assertion goes through the symbol table. There is no disk in this test
 * and there must be none in the implementation.
 */
import { describe, expect, it } from "vitest";

import type { CallContext } from "../../../../../../src/core/contracts/types/codegraph.js";
import { PythonImportFileMapper } from "../../../../../../src/core/domains/language/python/resolver/python-import-file-mapper.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const CORPUS_FILES: Record<string, string[]> = {
  /* the table above, verbatim */
};

function corpusTable(
  files: Record<string, string[]> = CORPUS_FILES,
): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  for (const [relPath, shortNames] of Object.entries(files)) {
    table.upsertFile(
      relPath,
      shortNames.map((shortName) => ({
        symbolId: shortName,
        fqName: shortName,
        shortName,
        relPath,
        scope: [],
      })),
    );
  }
  return table;
}

function ctxFor(
  table: InMemoryGlobalSymbolTable,
  callerFile: string,
): CallContext {
  return {
    callerFile,
    callerScope: [],
    imports: [],
    symbolTable: table,
  } as CallContext;
}
```

```ts
describe("PythonImportFileMapper — absolute imports under an inferred root", () => {
  const mapper = new PythonImportFileMapper();
  const table = corpusTable();

  it("netbox: a package import resolves to its __init__.py, not to a phantom .py", () => {
    // The whole point of the seam. mapPythonImportToFile answers "dcim/models.py".
    expect(
      mapper.mapImportToFile(
        "dcim.models",
        "netbox/dcim/views.py",
        ctxFor(table, "netbox/dcim/views.py"),
      ),
    ).toEqual({ kind: "project", relPath: "netbox/dcim/models/__init__.py" });
  });

  it("netbox: a module import prefers the .py over a same-named package", () => {
    expect(
      mapper.mapImportToFile(
        "dcim.views",
        "netbox/dcim/models/__init__.py",
        ctxFor(table, "netbox/dcim/models/__init__.py"),
      ),
    ).toEqual({ kind: "project", relPath: "netbox/dcim/views.py" });
  });

  it("netbox: the root directory may repeat the package name", () => {
    expect(
      mapper.mapImportToFile(
        "netbox.settings",
        "netbox/dcim/views.py",
        ctxFor(table, "netbox/dcim/views.py"),
      ),
    ).toEqual({ kind: "project", relPath: "netbox/netbox/settings.py" });
  });

  it("flask: the src/ layout root is inferred from the importing file's ancestors", () => {
    expect(
      mapper.mapImportToFile(
        "flask.app",
        "src/flask/__init__.py",
        ctxFor(table, "src/flask/__init__.py"),
      ),
    ).toEqual({ kind: "project", relPath: "src/flask/app.py" });
  });

  it("polar: the server/ root is inferred the same way", () => {
    expect(
      mapper.mapImportToFile(
        "polar.order.service",
        "server/polar/order/__init__.py",
        ctxFor(table, "server/polar/order/__init__.py"),
      ),
    ).toEqual({ kind: "project", relPath: "server/polar/order/service.py" });
  });

  it("ugnest: the repo root is a valid root", () => {
    expect(
      mapper.mapImportToFile(
        "domains.orders.handlers",
        "domains/billing/invoice.py",
        ctxFor(table, "domains/billing/invoice.py"),
      ),
    ).toEqual({ kind: "project", relPath: "domains/orders/handlers.py" });
  });

  it("an EMPTY __init__.py still answers project (hasFile, not hasFilesUnder)", () => {
    expect(
      mapper.mapImportToFile(
        "domains.orders",
        "domains/billing/invoice.py",
        ctxFor(table, "domains/billing/invoice.py"),
      ),
    ).toEqual({ kind: "project", relPath: "domains/orders/__init__.py" });
  });
});

describe("PythonImportFileMapper — namespace packages", () => {
  const mapper = new PythonImportFileMapper();
  const table = corpusTable();

  it("a PEP 420 namespace directory answers unknown, never a directory path", () => {
    // `cg_symbols_edges_file.target_rel_path` would store "netbox/extras/ui",
    // but it joins no row in cg_symbols_files, so it is a phantom by another name.
    expect(
      mapper.mapImportToFile(
        "extras.ui",
        "netbox/dcim/views.py",
        ctxFor(table, "netbox/dcim/views.py"),
      ),
    ).toEqual({ kind: "unknown" });
  });

  it("a MEMBER of a namespace package still resolves", () => {
    expect(
      mapper.mapImportToFile(
        "extras.ui.widgets",
        "netbox/dcim/views.py",
        ctxFor(table, "netbox/dcim/views.py"),
      ),
    ).toEqual({ kind: "project", relPath: "netbox/extras/ui/widgets.py" });
  });

  it("ugnest: `domains` itself is a namespace package", () => {
    expect(
      mapper.mapImportToFile(
        "domains",
        "domains/billing/invoice.py",
        ctxFor(table, "domains/billing/invoice.py"),
      ),
    ).toEqual({ kind: "unknown" });
  });

  it("flask: sansio has no __init__.py but sansio.app does resolve", () => {
    expect(
      mapper.mapImportToFile(
        "flask.sansio",
        "src/flask/app.py",
        ctxFor(table, "src/flask/app.py"),
      ),
    ).toEqual({ kind: "unknown" });
    expect(
      mapper.mapImportToFile(
        "flask.sansio.app",
        "src/flask/app.py",
        ctxFor(table, "src/flask/app.py"),
      ),
    ).toEqual({ kind: "project", relPath: "src/flask/sansio/app.py" });
  });
});

describe("PythonImportFileMapper — relative imports", () => {
  const mapper = new PythonImportFileMapper();
  const table = corpusTable();

  it("one dot with a tail is a sibling module", () => {
    expect(
      mapper.mapImportToFile(
        ".app",
        "src/flask/__init__.py",
        ctxFor(table, "src/flask/__init__.py"),
      ),
    ).toEqual({ kind: "project", relPath: "src/flask/app.py" });
  });

  it("one dot alone is the package __init__.py", () => {
    expect(
      mapper.mapImportToFile(
        ".",
        "src/flask/app.py",
        ctxFor(table, "src/flask/app.py"),
      ),
    ).toEqual({ kind: "project", relPath: "src/flask/__init__.py" });
  });

  it("two dots walk up one package", () => {
    expect(
      mapper.mapImportToFile(
        "..app",
        "src/flask/sansio/app.py",
        ctxFor(table, "src/flask/sansio/app.py"),
      ),
    ).toEqual({ kind: "project", relPath: "src/flask/app.py" });
  });

  it("a relative import resolving to a package answers its __init__.py", () => {
    expect(
      mapper.mapImportToFile(
        "..models",
        "netbox/dcim/views.py",
        ctxFor(table, "netbox/dcim/views.py"),
      ),
    ).toEqual({ kind: "unknown" }); // ..models from netbox/dcim -> netbox/models, which does not exist
    expect(
      mapper.mapImportToFile(
        ".models",
        "netbox/dcim/views.py",
        ctxFor(table, "netbox/dcim/views.py"),
      ),
    ).toEqual({ kind: "project", relPath: "netbox/dcim/models/__init__.py" });
  });

  it("a relative import never triggers root inference", () => {
    // `.orders` from domains/billing/invoice.py is domains/billing/orders, NOT
    // domains/orders — a root-inferring implementation would answer the latter.
    expect(
      mapper.mapImportToFile(
        ".orders",
        "domains/billing/invoice.py",
        ctxFor(table, "domains/billing/invoice.py"),
      ),
    ).toEqual({ kind: "unknown" });
  });

  it("walking above the repo root is unknown, not a crash", () => {
    expect(
      mapper.mapImportToFile("....x", "a/b.py", ctxFor(table, "a/b.py")),
    ).toEqual({ kind: "unknown" });
  });
});

describe("PythonImportFileMapper — external and degraded verdicts", () => {
  const mapper = new PythonImportFileMapper();
  const table = corpusTable();

  it("a stdlib module is external", () => {
    expect(
      mapper.mapImportToFile(
        "os.path",
        "netbox/dcim/views.py",
        ctxFor(table, "netbox/dcim/views.py"),
      ),
    ).toEqual({ kind: "external" });
    expect(
      mapper.mapImportToFile(
        "contextlib",
        "netbox/dcim/views.py",
        ctxFor(table, "netbox/dcim/views.py"),
      ),
    ).toEqual({ kind: "external" });
  });

  it("a third-party module absent from a populated table is external", () => {
    expect(
      mapper.mapImportToFile(
        "django.db.models",
        "netbox/dcim/views.py",
        ctxFor(table, "netbox/dcim/views.py"),
      ),
    ).toEqual({ kind: "external" });
  });

  it("an EMPTY symbol table answers unknown, never external", () => {
    const empty = new InMemoryGlobalSymbolTable();
    expect(
      mapper.mapImportToFile(
        "dcim.models",
        "netbox/dcim/views.py",
        ctxFor(empty, "netbox/dcim/views.py"),
      ),
    ).toEqual({ kind: "unknown" });
  });

  it("empty and whitespace import text answers unknown", () => {
    expect(mapper.mapImportToFile("", "a.py", ctxFor(table, "a.py"))).toEqual({
      kind: "unknown",
    });
    expect(
      mapper.mapImportToFile("   ", "a.py", ctxFor(table, "a.py")),
    ).toEqual({ kind: "unknown" });
  });

  it("tolerates a stray ` as alias` suffix, like the path helper does", () => {
    expect(
      mapper.mapImportToFile(
        "dcim.models as m",
        "netbox/dcim/views.py",
        ctxFor(table, "netbox/dcim/views.py"),
      ),
    ).toEqual({ kind: "project", relPath: "netbox/dcim/models/__init__.py" });
  });
});

describe("PythonImportFileMapper — memo", () => {
  it("re-answers after the table grows (size change invalidates)", () => {
    const mapper = new PythonImportFileMapper();
    const table = corpusTable({ "netbox/dcim/views.py": ["DeviceListView"] });
    const ctx = ctxFor(table, "netbox/dcim/views.py");
    expect(
      mapper.mapImportToFile("dcim.models", "netbox/dcim/views.py", ctx),
    ).toEqual({ kind: "external" });
    table.upsertFile("netbox/dcim/models/__init__.py", [
      {
        symbolId: "Device",
        fqName: "Device",
        shortName: "Device",
        relPath: "netbox/dcim/models/__init__.py",
        scope: [],
      },
    ]);
    expect(
      mapper.mapImportToFile("dcim.models", "netbox/dcim/views.py", ctx),
    ).toEqual({ kind: "project", relPath: "netbox/dcim/models/__init__.py" });
  });

  it("two tables do not share answers", () => {
    const mapper = new PythonImportFileMapper();
    const full = corpusTable();
    const bare = corpusTable({ "netbox/dcim/views.py": ["DeviceListView"] });
    expect(
      mapper.mapImportToFile(
        "dcim.models",
        "netbox/dcim/views.py",
        ctxFor(full, "netbox/dcim/views.py"),
      ).kind,
    ).toBe("project");
    expect(
      mapper.mapImportToFile(
        "dcim.models",
        "netbox/dcim/views.py",
        ctxFor(bare, "netbox/dcim/views.py"),
      ).kind,
    ).toBe("external");
  });

  it("the same import text from two directories can differ", () => {
    const mapper = new PythonImportFileMapper();
    const table = corpusTable();
    expect(
      mapper.mapImportToFile(
        ".app",
        "src/flask/__init__.py",
        ctxFor(table, "src/flask/__init__.py"),
      ),
    ).toEqual({ kind: "project", relPath: "src/flask/app.py" });
    expect(
      mapper.mapImportToFile(
        ".app",
        "server/polar/order/__init__.py",
        ctxFor(table, "server/polar/order/__init__.py"),
      ),
    ).toEqual({ kind: "unknown" });
  });
});
```

- [ ] Run it, watch it fail on the missing module:
      `npx vitest run tests/core/domains/language/python/resolver/python-import-file-mapper.test.ts`.

- [ ] Create
      `src/core/domains/language/python/resolver/python-import-file-mapper.ts` —
      head, memo, and entry point:

```ts
/**
 * `PythonImportFileMapper` — which project file an import statement names
 * (bd tea-rags-mcp-9fgdi, E2 seam 1).
 *
 * `mapPythonImportToFile` synthesises a candidate path from the module text
 * alone: `dcim.models` becomes `dcim/models.py`. netbox's file is
 * `netbox/dcim/models/__init__.py` — wrong root, wrong shape. That guess is
 * committed as a file edge and persisted unfiltered, so 39% of netbox's and
 * 62% of ugnest's first-party absolute imports point at files that do not
 * exist, and every Python file signal is computed over them.
 *
 * This class answers the same question from symbol-table MEMBERSHIP: the root
 * is inferred from paths the table already holds, and `.py` vs `__init__.py` vs
 * namespace directory is decided by `hasFile` / `hasFilesUnder` rather than by
 * convention. NO DISK. Pass 2 runs against a hydrated table whose working tree
 * may have moved on, and a `statSync` per import per file is a syscall storm on
 * a 24k-file corpus besides.
 */

import { posix } from "node:path";

import type {
  CallContext,
  GlobalSymbolTable,
  RelPath,
} from "../../../../contracts/types/codegraph.js";
import type {
  ImportFileMapper,
  ImportFileTarget,
} from "../../../../contracts/types/language.js";
import { isStdlibModule } from "../vocabulary/stdlib-modules.js";

const EXTERNAL: ImportFileTarget = { kind: "external" };
const UNKNOWN: ImportFileTarget = { kind: "unknown" };

/**
 * Per-symbol-table memo. Keyed by table IDENTITY (a run holds one) and
 * invalidated when `size()` moves, which is the same shape the TS path mapper
 * uses for its `existsSync` memo — pass 1 grows the table, pass 2 does not.
 *
 * `roots` is the ordered set of roots already proven to fit: on a corpus with
 * one source root, the second import onward skips the ancestor scan entirely.
 * `answers` is keyed by `<dir> <importText>` because the same text resolves
 * differently from two directories — every relative import, and any absolute
 * one whose root inference depends on the caller's ancestors.
 */
interface ImportMapperMemo {
  size: number;
  roots: string[];
  answers: Map<string, ImportFileTarget>;
}

export class PythonImportFileMapper implements ImportFileMapper {
  private readonly memos = new WeakMap<GlobalSymbolTable, ImportMapperMemo>();

  mapImportToFile(
    importText: string,
    fromFile: RelPath,
    ctx: CallContext,
  ): ImportFileTarget {
    const head = importText.split(/\s+as\s+/)[0].trim();
    if (head.length === 0) return UNKNOWN;

    const table = ctx.symbolTable;
    const memo = this.memoFor(table);
    const fromDir = posix.dirname(fromFile);
    const key = `${fromDir} ${head}`;
    const cached = memo.answers.get(key);
    if (cached) return cached;

    const answer = head.startsWith(".")
      ? this.mapRelative(head, fromDir, table)
      : this.mapAbsolute(head, fromDir, table, memo);
    memo.answers.set(key, answer);
    return answer;
  }

  private memoFor(table: GlobalSymbolTable): ImportMapperMemo {
    const existing = this.memos.get(table);
    const size = table.size();
    // A grown table can turn `external` into `project`; a stale memo would
    // freeze the cold-pass answer for the whole run.
    if (existing && existing.size === size) return existing;
    const fresh: ImportMapperMemo = { size, roots: [], answers: new Map() };
    this.memos.set(table, fresh);
    return fresh;
  }
}
```

- [ ] Add the relative branch, as private methods of the same class. The dot
      arithmetic is `resolveRelative`'s, kept identical so the two never
      disagree about what `..foo.bar` means:

```ts
  /**
   * `.foo` / `..foo.bar` / `.` — already anchored to the importing file's
   * package, so root inference must NOT run. `.orders` from
   * `domains/billing/invoice.py` is `domains/billing/orders`, and a mapper that
   * fell back to root inference would answer `domains/orders` instead.
   */
  private mapRelative(head: string, fromDir: string, table: GlobalSymbolTable): ImportFileTarget {
    let dots = 0;
    while (dots < head.length && head[dots] === ".") dots++;
    let baseDir = fromDir === "." ? "" : fromDir;
    for (let i = 0; i < dots - 1; i++) {
      if (baseDir.length === 0) return UNKNOWN; // walked above the repo root
      baseDir = posix.dirname(baseDir);
      if (baseDir === ".") baseDir = "";
    }
    const tail = head
      .slice(dots)
      .split(".")
      .filter((s) => s.length > 0);
    const dir = [baseDir, ...tail].filter((s) => s.length > 0).join("/");
    // `from . import x` arrives here as `"."` with an empty tail: the package
    // itself. Task 5's strategy is what tries `<dir>/x.py` first, because only
    // it can see `importedNames`.
    return probePath(dir, table);
  }
```

- [ ] Add the absolute branch and the root scan:

```ts
  /**
   * `a.b.c` — the import root is not the repo root in three of the five
   * corpora, and nothing in the module text says which it is. Try roots
   * cheapest-first: the memo's proven ones, then `""`, then the importing
   * file's ancestors DEEPEST to SHALLOWEST.
   *
   * Deepest-first is load-bearing. netbox holds both `netbox/netbox/settings.py`
   * and the root `netbox/` package directory; a shallow-first scan would let
   * the outer `netbox/` shadow the inner one for `netbox.settings`.
   */
  private mapAbsolute(
    head: string,
    fromDir: string,
    table: GlobalSymbolTable,
    memo: ImportMapperMemo,
  ): ImportFileTarget {
    const segments = head.split(".").filter((s) => s.length > 0);
    if (segments.length === 0) return UNKNOWN;
    const modulePath = segments.join("/");

    for (const root of candidateRoots(fromDir, memo.roots)) {
      const dir = root.length === 0 ? modulePath : `${root}/${modulePath}`;
      const hit = probePath(dir, table);
      if (hit.kind === "unknown" && !rootFits(root, segments[0], table)) continue;
      if (!memo.roots.includes(root)) memo.roots.push(root);
      return hit;
    }

    // Nothing in the project holds it. The stdlib snapshot is checked FIRST so
    // the verdict is positive rather than residual, but the outcome is the same
    // either way — with one exception: an EMPTY table proves nothing, and
    // calling every import external there would silently zero the file graph on
    // a cold or degraded pass.
    if (isStdlibModule(segments[0])) return EXTERNAL;
    return table.size() > 0 ? EXTERNAL : UNKNOWN;
  }
}

/** `""`, then memo-proven roots, then the caller's ancestors deepest-first. */
function candidateRoots(fromDir: string, provenRoots: readonly string[]): string[] {
  const roots: string[] = [""];
  for (const root of provenRoots) if (!roots.includes(root)) roots.push(root);
  let dir = fromDir === "." ? "" : fromDir;
  const ancestors: string[] = [];
  while (dir.length > 0) {
    ancestors.push(dir);
    const parent = posix.dirname(dir);
    dir = parent === "." ? "" : parent;
  }
  for (const root of ancestors) if (!roots.includes(root)) roots.push(root);
  return roots;
}

/** Does this root hold the import's TOP package at all? */
function rootFits(root: string, topSegment: string, table: GlobalSymbolTable): boolean {
  const top = root.length === 0 ? topSegment : `${root}/${topSegment}`;
  return table.hasFile(`${top}.py`) || table.hasFilesUnder(top);
}

/**
 * A module path with the root already applied, decided by membership:
 * module file, then package `__init__.py`, then namespace directory.
 *
 * The `__init__.py` question is asked with `hasFile`, never inferred from
 * `hasFilesUnder`: an empty `__init__.py` is a real file with zero symbols
 * (netbox and polar both ship them), and a namespace package is a directory
 * with none. `hasFilesUnder` cannot tell those two apart, and they get
 * different answers.
 */
function probePath(dir: string, table: GlobalSymbolTable): ImportFileTarget {
  if (dir.length === 0) return UNKNOWN;
  if (table.hasFile(`${dir}.py`)) return { kind: "project", relPath: `${dir}.py` };
  const packageInit = `${dir}/__init__.py`;
  if (table.hasFile(packageInit)) return { kind: "project", relPath: packageInit };
  // PEP 420 namespace package, or a directory whose members are all excluded.
  // A DIRECTORY is not a legal file-edge target: `cg_symbols_edges_file` would
  // store it (the column has no FK), but it joins no row in `cg_symbols_files`,
  // so it adds fanIn to nothing and only inflates the source's fanOut — the
  // same phantom in a different costume. Follow-up bead: attribute a namespace
  // import to its member files.
  return UNKNOWN;
}
```

- [ ] Export it from `src/core/domains/language/python/resolver/index.ts`
      alongside `PythonCallResolver` and `mapPythonImportToFile`:

```ts
export { PythonImportFileMapper } from "./python-import-file-mapper.js";
```

- [ ] Green:
      `npx vitest run tests/core/domains/language/python/resolver/python-import-file-mapper.test.ts`.
- [ ] The nine `mapPythonImportToFile` unit tests must still pass UNTOUCHED —
      that helper was not modified:
      `npx vitest run tests/core/domains/language/python/resolver/python-resolver.test.ts`.
- [ ] Prove the no-disk constraint:
      `grep -rn "existsSync\|statSync\|readdirSync\|node:fs" src/core/domains/language/python/`
      must print nothing.
- [ ] `npx tsc --noEmit` clean.
- [ ] Commit:
      `feat(language): add PythonImportFileMapper over symbol-table membership (9fgdi)`.

---

## Task 4: relocate `reexportOriginFile` to the kernel

**Files**

- Create `src/core/domains/language/kernel/reexport-origin.ts`
- Modify `src/core/domains/language/typescript/resolver/strategies/shared.ts`

**Interfaces**

_Moves, byte-identically_ — the function, its ~70-line docblock (the measured
611/144/467/349/118 numbers and the `ex28m` incident are the reasoning that
justifies each gate; losing them loses the reason the gates exist), and its
private helper:

```ts
export function reexportOriginFile(
  name: string,
  importedFile: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
): string | null;

function withinPackageOf(
  barrelFile: string,
  candidates: readonly string[],
): string[]; // private
```

_Does NOT move._ `pickSingleCandidate` is already a shared export of
`contracts/types/codegraph.js` — the TS `shared.ts` merely imports it. Decision
7's parenthetical resolves to "it does not live there", so nothing to relocate.

_Consumers that must not change._ `ts-named-import.ts:6,46`,
`ts-imported-callee.ts:10,78`, and `strategies/index.ts:27` all import from
`./shared.js`. The re-export is what keeps their lines and every TS test
untouched.

**Steps**

- [ ] Create `src/core/domains/language/kernel/reexport-origin.ts`. Move
      `reexportOriginFile` (lines ~57-140 of the TS `shared.ts`, docblock
      included) and `withinPackageOf` (~145-155) VERBATIM — not one word of the
      docblock rewritten, no signature touched. Add only a relocation header
      above them:

```ts
/**
 * `reexportOriginFile` — follow a barrel to the file that DECLARES a name.
 *
 * Relocated from `typescript/resolver/strategies/shared.ts` (bd
 * tea-rags-mcp-9fgdi, E2 seam 1) when Python pulled on it: a Python package
 * `__init__.py` re-exports exactly the way a TS barrel does — `from .app import
 * Flask as Flask` (flask 39, polar 36), star re-export plus `__all__` (netbox
 * 178 star lines, `__all__` in 433 modules) — and the mechanism that answers it
 * is hop-agnostic symbol-table lookup, not anything TypeScript-shaped.
 *
 * Behaviour-preserving relocation per `.claude/rules/resolver-architecture.md`
 * §4: the function, its gates and its docblock are byte-identical to the
 * TypeScript original. `typescript/resolver/strategies/shared.ts` re-exports it
 * so every TS consumer and TS test keeps its import path.
 */

import {
  pickSingleCandidate,
  type AmbiguousResolveMode,
  type CallContext,
} from "../../../contracts/types/codegraph.js";
```

- [ ] In `typescript/resolver/strategies/shared.ts`: delete both moved
      functions, drop `pickSingleCandidate` from the `codegraph.js` import if
      nothing else in the file still uses it (`collectImportedFiles` does not),
      and re-export:

```ts
// `reexportOriginFile` moved to `kernel/reexport-origin.ts` — Python's package
// `__init__.py` re-exports need the same hop (bd tea-rags-mcp-9fgdi). Re-exported
// here so `ts-named-import`, `ts-imported-callee` and `strategies/index.ts` keep
// importing it from `./shared.js`.
export { reexportOriginFile } from "../../../kernel/reexport-origin.js";
```

- [ ] The TS suite must pass with ZERO test edits:
      `npx vitest run tests/core/domains/language/typescript` and
      `git diff --stat -- tests/core/domains/language/typescript` (empty).
- [ ] `npx tsc --noEmit` clean.
- [ ] Confirm the relocation was a move, not a rewrite: `git diff -M --stat`
      should show the function as moved lines, and `git log -1 --stat` after
      committing should show `shared.ts` shrinking by about what
      `reexport-origin.ts` gains.
- [ ] Commit:
      `refactor(language): relocate reexportOriginFile to kernel (9fgdi)`.

---

## Task 5: `PythonImportedNameSymbolResolutionStrategy`

**Files**

- Create
  `src/core/domains/language/python/resolver/strategies/python-imported-name.ts`
- Create
  `tests/core/domains/language/python/resolver/strategies/python-imported-name.test.ts`
- Modify `src/core/domains/language/python/resolver/strategies/index.ts`
- Modify `src/core/domains/language/python/resolver/python-resolver.ts` (chain +
  docblock)
- Modify
  `src/core/domains/language/python/resolver/python-external-vocabulary.ts`
  (`isBareCallExternal` consults `importedBindings`)

**Interfaces**

_Consumes_

```ts
import {
  CONTINUE,
  DROP,
  resolved,
} from "../../../../../contracts/resolution.js";
import {
  pickSingleCandidate,
  type CallContext,
  type CallRef,
} from "../../../../../contracts/types/codegraph.js";
import type {
  SymbolResolutionOutcome,
  SymbolResolutionStrategy,
} from "../../../../../contracts/types/language.js";
import { reexportOriginFile } from "../../../kernel/reexport-origin.js";
import { PythonImportFileMapper } from "../python-import-file-mapper.js";
import type { ResolverConfig } from "./shared.js";
```

_Produces_

```ts
export class PythonImportedNameSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "importedName";
  constructor(cfg: ResolverConfig, mapper: PythonImportFileMapper);
  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome;
}
```

**Chain position — index 4, and the index is the argument**

```
1 super          terminal guard
2 selfField      terminal guard
3 selfMember     terminal guard
4 localBinding   terminal guard
5 importedName   <- NEW
6 importMatch
7 globalShortName
```

After `localBinding`: a walker-bound local type is narrower evidence than an
import binding, and `localBinding` is a terminal guard whose DROP must keep
preempting everything downstream. Before `importMatch`: `importMatch` matches a
receiver against an import's LAST SEGMENT, which is a guess about what the
statement bound — this pass reads what it actually bound. Running it second
would let the guess win whenever both fire.

**Outcomes — exactly three**

| Situation                                                         | Outcome                    |
| ----------------------------------------------------------------- | -------------------------- |
| binding maps to project file F, `F` declares the name             | `resolved` (symbol pinned) |
| binding maps to F, F does not declare it, unique re-export origin | `resolved` (pinned)        |
| star import, member declared exactly once in F or F's package     | `resolved` (pinned)        |
| binding maps to an `external` module                              | `DROP`                     |
| no binding, `unknown` mapping, or several candidates              | `CONTINUE`                 |

`DROP` and not `CONTINUE` for external: a bare `loads(...)` after
`from json import loads` reaches a stdlib function, and letting it fall through
to `globalShortName` is exactly how a project function named `loads` becomes a
fabricated edge. The drop and `PythonExternalVocabulary.isBareCallExternal` must
agree, or the call is dropped from the graph AND kept in the recall denominator
— hence the vocabulary wiring in this same task.

Never `deferred`. This pass pins a symbol or declines; there is no partial
answer to park, and `importMatch`'s measured verdict on parking
(`python-import-match.ts` docblock, bd 86qfb) applies here too.

**Steps**

- [ ] Write the failing test
      `tests/core/domains/language/python/resolver/strategies/python-imported-name.test.ts`:

```ts
/**
 * `PythonImportedNameSymbolResolutionStrategy` (E2 seam 1, bd tea-rags-mcp-9fgdi).
 *
 * `from .models import Device` then `Device.objects` used to reach `importMatch`,
 * which matches the receiver against the import's LAST SEGMENT — `models` — and
 * so never sees `Device` at all. This pass reads the binding the walker recorded
 * and resolves through the file it names, including one re-export hop, which is
 * how `from flask import Flask` reaches `src/flask/app.py` rather than stopping
 * at the package `__init__.py`.
 */
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  ImportRef,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import { PythonImportFileMapper } from "../../../../../../../src/core/domains/language/python/resolver/python-import-file-mapper.js";
import { PythonImportedNameSymbolResolutionStrategy } from "../../../../../../../src/core/domains/language/python/resolver/strategies/python-imported-name.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function tableWith(files: Record<string, string[]>): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  for (const [relPath, symbolIds] of Object.entries(files)) {
    table.upsertFile(
      relPath,
      symbolIds.map((symbolId) => ({
        symbolId,
        fqName: symbolId,
        shortName: symbolId.split(/[#.]/).pop() ?? symbolId,
        relPath,
        scope: [],
      })),
    );
  }
  return table;
}

function ctxWith(
  callerFile: string,
  imports: ImportRef[],
  table: InMemoryGlobalSymbolTable,
): CallContext {
  return {
    callerFile,
    callerScope: [],
    imports,
    symbolTable: table,
  } as CallContext;
}

function strategy(): PythonImportedNameSymbolResolutionStrategy {
  return new PythonImportedNameSymbolResolutionStrategy(
    { mode: "strict" },
    new PythonImportFileMapper(),
  );
}

const call = (receiver: string | undefined, member: string): CallRef =>
  ({
    callText: `${receiver ?? ""}.${member}()`,
    receiver,
    member,
    startLine: 10,
  }) as CallRef;
```

```ts
describe("PythonImportedNameSymbolResolutionStrategy — receiver is an imported binding", () => {
  it("pins the symbol declared in the imported file", () => {
    const table = tableWith({
      "dcim/views.py": ["DeviceListView"],
      "dcim/models/__init__.py": ["Device", "Device.objects"],
    });
    const ctx = ctxWith(
      "dcim/views.py",
      [
        {
          importText: ".models",
          startLine: 1,
          importedNames: ["Device"],
          importedBindings: { Device: "Device" },
        },
      ],
      table,
    );
    expect(strategy().attempt(call("Device", "objects"), ctx)).toEqual({
      kind: "resolved",
      target: {
        targetRelPath: "dcim/models/__init__.py",
        targetSymbolId: "Device.objects",
      },
    });
  });

  it("follows an alias to the EXPORTED name, not the local one", () => {
    const table = tableWith({
      "app/views.py": ["v"],
      "app/models.py": ["Rack", "Rack.objects"],
    });
    const ctx = ctxWith(
      "app/views.py",
      [
        {
          importText: ".models",
          startLine: 1,
          importedNames: ["R"],
          importedBindings: { R: "Rack" },
        },
      ],
      table,
    );
    expect(strategy().attempt(call("R", "objects"), ctx)).toEqual({
      kind: "resolved",
      target: {
        targetRelPath: "app/models.py",
        targetSymbolId: "Rack.objects",
      },
    });
  });

  it("hops through a package __init__.py that re-exports the name", () => {
    // flask: `from flask import Flask`; the class lives in src/flask/app.py.
    const table = tableWith({
      "src/flask/__init__.py": [],
      "src/flask/app.py": ["Flask", "Flask#run"],
      "src/app/main.py": ["main"],
    });
    const ctx = ctxWith(
      "src/app/main.py",
      [
        {
          importText: "flask",
          startLine: 1,
          importedNames: ["Flask"],
          importedBindings: { Flask: "Flask" },
        },
      ],
      table,
    );
    expect(strategy().attempt(call("Flask", "run"), ctx)).toEqual({
      kind: "resolved",
      target: {
        targetRelPath: "src/flask/app.py",
        targetSymbolId: "Flask#run",
      },
    });
  });

  it("declines the hop when the name is declared in two files", () => {
    const table = tableWith({
      "ui/__init__.py": [],
      "ui/button.py": ["Button", "Button#click"],
      "legacy/button.py": ["Button", "Button#click"],
      "app/main.py": ["main"],
    });
    const ctx = ctxWith(
      "app/main.py",
      [
        {
          importText: "ui",
          startLine: 1,
          importedNames: ["Button"],
          importedBindings: { Button: "Button" },
        },
      ],
      table,
    );
    expect(strategy().attempt(call("Button", "click"), ctx)).toEqual({
      kind: "continue",
    });
  });
});

describe("PythonImportedNameSymbolResolutionStrategy — bare calls", () => {
  it("resolves a bare call whose member is an imported binding", () => {
    const table = tableWith({
      "app/main.py": ["main"],
      "app/util.py": ["make_thing"],
    });
    const ctx = ctxWith(
      "app/main.py",
      [
        {
          importText: ".util",
          startLine: 1,
          importedNames: ["make_thing"],
          importedBindings: { make_thing: "make_thing" },
        },
      ],
      table,
    );
    expect(strategy().attempt(call(undefined, "make_thing"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/util.py", targetSymbolId: "make_thing" },
    });
  });

  it("DROPS a bare call bound to an external module", () => {
    // `from json import loads` then `loads(x)`: the callee is the stdlib. Falling
    // through would let globalShortName attach it to a project `loads`.
    const table = tableWith({
      "app/main.py": ["main"],
      "app/serial.py": ["loads"],
    });
    const ctx = ctxWith(
      "app/main.py",
      [
        {
          importText: "json",
          startLine: 1,
          importedNames: ["loads"],
          importedBindings: { loads: "loads" },
        },
      ],
      table,
    );
    expect(strategy().attempt(call(undefined, "loads"), ctx)).toEqual({
      kind: "drop",
    });
  });

  it("DROPS a qualified call whose receiver is bound to an external module", () => {
    const table = tableWith({
      "app/main.py": ["main"],
      "app/np.py": ["linalg"],
    });
    const ctx = ctxWith(
      "app/main.py",
      [
        {
          importText: "numpy",
          startLine: 1,
          importedNames: ["np"],
          importedBindings: { np: "numpy" },
        },
      ],
      table,
    );
    expect(strategy().attempt(call("np", "array"), ctx)).toEqual({
      kind: "drop",
    });
  });
});

describe("PythonImportedNameSymbolResolutionStrategy — star imports", () => {
  it("resolves a unique declaration in the starred file", () => {
    const table = tableWith({
      "app/main.py": ["main"],
      "app/models.py": ["Device", "helper"],
    });
    const ctx = ctxWith(
      "app/main.py",
      [{ importText: ".models", startLine: 1, importedNames: ["*"] }],
      table,
    );
    expect(strategy().attempt(call(undefined, "helper"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/models.py", targetSymbolId: "helper" },
    });
  });

  it("resolves through the starred PACKAGE directory", () => {
    // netbox: `from .models import *` where models is a package whose members
    // declare the name. 178 star lines, __all__ in 433 modules.
    const table = tableWith({
      "dcim/views.py": ["v"],
      "dcim/models/__init__.py": [],
      "dcim/models/devices.py": ["Device"],
    });
    const ctx = ctxWith(
      "dcim/views.py",
      [{ importText: ".models", startLine: 1, importedNames: ["*"] }],
      table,
    );
    expect(strategy().attempt(call(undefined, "Device"), ctx)).toEqual({
      kind: "resolved",
      target: {
        targetRelPath: "dcim/models/devices.py",
        targetSymbolId: "Device",
      },
    });
  });

  it("CONTINUES when the starred package declares the name twice", () => {
    const table = tableWith({
      "dcim/views.py": ["v"],
      "dcim/models/__init__.py": [],
      "dcim/models/devices.py": ["Device"],
      "dcim/models/racks.py": ["Device"],
    });
    const ctx = ctxWith(
      "dcim/views.py",
      [{ importText: ".models", startLine: 1, importedNames: ["*"] }],
      table,
    );
    expect(strategy().attempt(call(undefined, "Device"), ctx)).toEqual({
      kind: "continue",
    });
  });

  it("CONTINUES when the starred file declares nothing by that name", () => {
    const table = tableWith({
      "app/main.py": ["main"],
      "app/models.py": ["Device"],
    });
    const ctx = ctxWith(
      "app/main.py",
      [{ importText: ".models", startLine: 1, importedNames: ["*"] }],
      table,
    );
    expect(strategy().attempt(call(undefined, "unrelated"), ctx)).toEqual({
      kind: "continue",
    });
  });
});

describe("PythonImportedNameSymbolResolutionStrategy — declines", () => {
  it("CONTINUES when no import binds the name", () => {
    const table = tableWith({
      "app/main.py": ["main"],
      "app/util.py": ["make_thing"],
    });
    const ctx = ctxWith(
      "app/main.py",
      [{ importText: ".util", startLine: 1, importedNames: ["other"] }],
      table,
    );
    expect(strategy().attempt(call(undefined, "make_thing"), ctx)).toEqual({
      kind: "continue",
    });
  });

  it("CONTINUES on a walker-1 ImportRef with no binding channels", () => {
    // An incremental run can hold files walked by walker 1. Missing channels
    // must degrade to the pre-seam chain, never to a drop.
    const table = tableWith({
      "app/main.py": ["main"],
      "app/util.py": ["make_thing"],
    });
    const ctx = ctxWith(
      "app/main.py",
      [{ importText: ".util", startLine: 1 }],
      table,
    );
    expect(strategy().attempt(call(undefined, "make_thing"), ctx)).toEqual({
      kind: "continue",
    });
  });

  it("CONTINUES when the mapping is unknown (namespace package)", () => {
    const table = tableWith({
      "app/main.py": ["main"],
      "domains/orders/handlers.py": ["place"],
    });
    const ctx = ctxWith(
      "app/main.py",
      [
        {
          importText: "domains",
          startLine: 1,
          importedNames: ["orders"],
          importedBindings: { orders: "domains" },
        },
      ],
      table,
    );
    expect(strategy().attempt(call("orders", "place"), ctx)).toEqual({
      kind: "continue",
    });
  });

  it("CONTINUES when the target file declares nothing and no unique origin exists", () => {
    const table = tableWith({ "app/main.py": ["main"], "app/empty.py": [] });
    const ctx = ctxWith(
      "app/main.py",
      [
        {
          importText: ".empty",
          startLine: 1,
          importedNames: ["Thing"],
          importedBindings: { Thing: "Thing" },
        },
      ],
      table,
    );
    expect(strategy().attempt(call("Thing", "go"), ctx)).toEqual({
      kind: "continue",
    });
  });
});
```

- [ ] Run it, watch it fail on the missing module:
      `npx vitest run tests/core/domains/language/python/resolver/strategies/python-imported-name.test.ts`.

- [ ] Create
      `src/core/domains/language/python/resolver/strategies/python-imported-name.ts`:

```ts
import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import { pickSingleCandidate, type CallContext, type CallRef, type ImportRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { reexportOriginFile } from "../../../kernel/reexport-origin.js";
import type { PythonImportFileMapper } from "../python-import-file-mapper.js";
import type { ResolverConfig } from "./shared.js";

/**
 * Imported-name resolution — the call's receiver, or a bare call's own name, is
 * a name an `import` statement BOUND (bd tea-rags-mcp-9fgdi).
 *
 * `from .models import Device` then `Device.objects`: the next pass down,
 * `importMatch`, matches a receiver against the import's LAST MODULE SEGMENT —
 * `models` — so it never considers `Device` at all, and the call falls to
 * `globalShortName`, which carries no receiver evidence whatsoever. The walker
 * now records what the statement actually bound (walker version 2), so this
 * pass reads the binding instead of guessing at it.
 *
 * CHAIN INDEX 5, after `localBinding` and before `importMatch`, and both halves
 * of that are correctness arguments:
 *
 *   - AFTER `localBinding`: a walker-bound local type is narrower evidence than
 *     an import binding (the variable was assigned in this body), and
 *     `localBinding` is a terminal guard whose DROP must keep preempting
 *     everything downstream. Running before it would resurrect the ugnest
 *     false-positive class the guards exist to kill.
 *   - BEFORE `importMatch`: `importMatch` guesses which name a statement bound
 *     from the module's trailing segment. This pass knows. Ordered the other
 *     way, the guess wins whenever both fire.
 *
 * Three outcomes, no fourth. `resolved` pins a symbol; `DROP` fires when the
 * binding names an EXTERNAL module, because a bare `loads(...)` after
 * `from json import loads` reaches the stdlib and falling through is exactly how
 * a project function of the same short name becomes a fabricated edge;
 * `CONTINUE` everywhere else, including every file walked by walker 1, whose
 * `ImportRef`s carry no binding channels at all.
 *
 * Never `deferred`: this pass either pins a symbol or has nothing to park.
 */
export class PythonImportedNameSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "importedName";

  constructor(
    private readonly cfg: ResolverConfig,
    private readonly mapper: PythonImportFileMapper,
  ) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    // A qualified call is keyed by its receiver's ROOT segment (`np.linalg.norm`
    // is bound through `np`); a bare call by the member itself.
    const localName = call.receiver ? call.receiver.split(".")[0] : call.member;
    const binding = findBinding(ctx.imports, localName);
    if (binding) return this.resolveBinding(binding, call, ctx);
    return this.resolveStarImport(call, ctx);
  }
```

- [ ] Add the binding branch as a private method of the same class:

```ts
  /**
   * The name is bound by an import. Map its module, then find the declaration:
   * in the mapped file, or — when the mapped file is a package `__init__.py`
   * that re-exports rather than declares — through one `reexportOriginFile`
   * hop, the same engine TypeScript uses for barrels.
   */
  private resolveBinding(
    binding: { imp: ImportRef; localName: string; importedName: string },
    call: CallRef,
    ctx: CallContext,
  ): SymbolResolutionOutcome {
    const mapped = this.mapper.mapImportToFile(binding.imp.importText, ctx.callerFile, ctx);
    if (mapped.kind === "external") return DROP;
    if (mapped.kind !== "project") return CONTINUE;

    // A qualified receiver (`Device.objects`) looks up `<importedName>.<member>`
    // and `<importedName>#<member>`; a bare call (`make_thing()`) looks up the
    // imported name itself. Python symbolIds carry no module path, so every
    // lookup is filtered to the mapped file.
    const declaringFile = this.declaringFile(binding.importedName, mapped.relPath, ctx);
    if (!declaringFile) return CONTINUE;

    const wanted = call.receiver
      ? [`${binding.importedName}.${call.member}`, `${binding.importedName}#${call.member}`]
      : [binding.importedName];
    for (const fqName of wanted) {
      const candidates = ctx.symbolTable.lookup(fqName).filter((def) => def.relPath === declaringFile);
      const target = pickSingleCandidate(candidates, this.cfg.mode);
      if (target) return resolved({ targetRelPath: target.relPath, targetSymbolId: target.symbolId });
    }
    return CONTINUE;
  }

  /**
   * Which file DECLARES `importedName`: the mapped file when it declares it
   * itself, otherwise the file it re-exports it from. `reexportOriginFile`
   * declines on an ambiguous or absent declaration, and so do we — an
   * ambiguous barrel beats a coin flip (bd tea-rags-mcp-ex28m).
   */
  private declaringFile(importedName: string, mappedFile: string, ctx: CallContext): string | null {
    const declaredHere = ctx.symbolTable
      .lookupByShortName(importedName)
      .some((def) => def.relPath === mappedFile);
    if (declaredHere) return mappedFile;
    return reexportOriginFile(importedName, mappedFile, ctx, this.cfg.mode);
  }
```

- [ ] Add the star-import branch and the module-level helpers:

```ts
  /**
   * `from .models import *` — netbox alone has 532 star imports and `__all__` in
   * 433 modules. No binding table exists (a star binds no single member), so the
   * question is where the member is DECLARED among what the star could have
   * brought in: the starred file itself, or, when the star targets a package,
   * any file under that package's directory.
   *
   * Unique declaration resolves; several CONTINUE. Guessing which module of a
   * starred package a name came from is what `__all__` would answer, and the
   * walker does not read it — that is a follow-up, not a coin flip.
   */
  private resolveStarImport(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    // Only bare calls: a star import binds names, never a receiver namespace.
    if (call.receiver) return CONTINUE;
    for (const imp of ctx.imports) {
      if (!imp.importedNames?.includes("*")) continue;
      const mapped = this.mapper.mapImportToFile(imp.importText, ctx.callerFile, ctx);
      if (mapped.kind !== "project") continue;
      const scope = packageScopeOf(mapped.relPath);
      const candidates = ctx.symbolTable
        .lookupByShortName(call.member)
        .filter((def) => def.relPath === mapped.relPath || (scope !== null && def.relPath.startsWith(scope)));
      const target = pickSingleCandidate(candidates, this.cfg.mode);
      if (target) return resolved({ targetRelPath: target.relPath, targetSymbolId: target.symbolId });
    }
    return CONTINUE;
  }
}

/**
 * The import that bound `localName`, with the name the MODULE exports it under.
 *
 * `importedBindings` is the authority (it survives aliasing);
 * `importedNames` alone means the statement bound the name unaliased, which is
 * the shape `from a import b` produces when a walker-1 file is mixed in.
 */
function findBinding(
  imports: readonly ImportRef[],
  localName: string,
): { imp: ImportRef; localName: string; importedName: string } | null {
  for (const imp of imports) {
    const importedName = imp.importedBindings?.[localName];
    if (importedName) return { imp, localName, importedName };
  }
  for (const imp of imports) {
    if (imp.importedBindings) continue; // already consulted above; do not re-answer
    if (imp.importedNames?.includes(localName)) return { imp, localName, importedName: localName };
  }
  return null;
}

/**
 * The directory a starred PACKAGE covers, or `null` when the star targeted a
 * plain module. `dcim/models/__init__.py` covers `dcim/models/`; a star on
 * `app/models.py` covers only that file, which the caller already checks.
 */
function packageScopeOf(mappedFile: string): string | null {
  if (!mappedFile.endsWith("/__init__.py")) return null;
  return mappedFile.slice(0, mappedFile.length - "__init__.py".length);
}
```

- [ ] Export it from
      `src/core/domains/language/python/resolver/strategies/index.ts`, in the
      same shape as its siblings:

```ts
export { PythonImportedNameSymbolResolutionStrategy } from "./python-imported-name.js";
```

- [ ] Wire it into the chain in
      `src/core/domains/language/python/resolver/python-resolver.ts`. The
      resolver now owns the mapper instance, because Task 6's `resolveFileEdges`
      and the migrated strategies must all share ONE memo:

```ts
export class PythonCallResolver implements CallResolver {
  readonly language = "python";
  private readonly strategies: SymbolResolutionStrategy[];
  private readonly cone: ConeDispatchResolver;
  private readonly importFileMapper = new PythonImportFileMapper();

  constructor(mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE) {
    const cfg: ResolverConfig = { mode, coneMax: resolveConeMax(process.env.CODEGRAPH_PY_CONE_MAX) };
    this.strategies = [
      new PythonSuperSymbolResolutionStrategy(cfg),
      new PythonSelfFieldSymbolResolutionStrategy(cfg),
      new PythonSelfMemberSymbolResolutionStrategy(cfg),
      new PythonLocalBindingSymbolResolutionStrategy(cfg, this.importFileMapper),
      new PythonImportedNameSymbolResolutionStrategy(cfg, this.importFileMapper),
      new PythonImportMatchSymbolResolutionStrategy(cfg, this.importFileMapper),
      new PythonGlobalShortNameSymbolResolutionStrategy(cfg),
    ];
    this.cone = new ConeDispatchResolver(new PythonConeTypeLocator(cfg), cfg.coneMax ?? CONE_MAX_DEFAULT);
  }
```

The `localBinding` and `importMatch` constructor arguments are Task 6's
migration; add them there, not here, if you are executing tasks strictly in
order. What Task 5 MUST land is the field, the new strategy at index 5, and the
class docblock's pass list:

```ts
 *   1. super (super().X via classExtends — terminal guard)
 *   2. selfField (self.<field>.X via classFieldTypes — terminal guard)
 *   3. selfMember (self.X via enclosing class + classExtends walk — terminal guard)
 *   4. localBinding (var.X via walker-bound type — terminal guard)
 *   5. importedName (receiver / bare callee is an imported binding; one
 *      re-export hop; star imports — bd tea-rags-mcp-9fgdi)
 *   6. importMatch (receiver matches an import's trailing segment)
 *   7. globalShortName (global short-name fallback)
```

- [ ] Teach `PythonExternalVocabulary.isBareCallExternal` (E0's file,
      `python/resolver/python-external-vocabulary.ts`) to consult
      `importedBindings`. Without this the new DROP and the external classifier
      disagree: the call leaves the graph AND stays in the recall denominator,
      which reads as a resolver regression in the oracle when it is the
      opposite.

```ts
  /**
   * A bare call whose name was bound by an import of an EXTERNAL module —
   * `from json import loads` then `loads(x)` (bd tea-rags-mcp-9fgdi).
   *
   * Must agree with `PythonImportedNameSymbolResolutionStrategy`, which DROPS
   * exactly this shape. A drop the vocabulary does not classify is counted as
   * an in-project miss, so the two answers are one decision made twice.
   */
  isBareCallExternal(call: CallRef, ctx: CallContext): boolean {
    if (call.receiver) return false;
    for (const imp of ctx.imports) {
      const bound = imp.importedBindings?.[call.member] ?? (imp.importedNames?.includes(call.member) ? call.member : undefined);
      if (bound === undefined) continue;
      if (this.mapper.mapImportToFile(imp.importText, ctx.callerFile, ctx).kind === "external") return true;
    }
    return false;
  }
```

- [ ] Green, both the new suite and the whole Python resolver suite — the chain
      insertion changes what earlier strategies see:
      `npx vitest run tests/core/domains/language/python`. Two assertions in
      `strategies.test.ts` may now fail; do NOT edit them here. They are Task
      6's, together with the rationale comment.
- [ ] `npx tsc --noEmit` clean.
- [ ] Commit:
      `feat(language): resolve Python calls through imported bindings (9fgdi)`.

---

## Task 6: migrate every consumer onto the mapper, and gate it

**Files**

- Modify
  `src/core/domains/language/python/resolver/strategies/python-import-match.ts`
- Modify
  `src/core/domains/language/python/resolver/strategies/python-local-binding.ts`
  (`resolveTypeFile`)
- Modify `src/core/domains/language/python/resolver/python-resolver.ts`
  (`resolveFileEdges`)
- Modify `src/core/domains/language/python/index.ts` (wire the override)
- Modify
  `tests/core/domains/language/python/resolver/strategies/strategies.test.ts`
  (exactly two assertions)
- Modify `src/core/domains/language/CLAUDE.md`
- Create `src/core/domains/language/python/CLAUDE.md` (if absent)

**Interfaces**

_Changed signatures_ — each gains the shared mapper, so all four consumers read
one memo and cannot disagree:

```ts
class PythonImportMatchSymbolResolutionStrategy {
  constructor(cfg: ResolverConfig, mapper: PythonImportFileMapper);
}
class PythonLocalBindingSymbolResolutionStrategy {
  constructor(cfg: ResolverConfig, mapper: PythonImportFileMapper);
}
export function resolveTypeFile(
  bareType: string,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
): string | null;

class PythonCallResolver {
  resolveFileEdges(
    extraction: FileExtraction,
    ctx: CallContext,
  ): GraphEdges["fileEdges"];
}
```

**Steps**

- [ ] `python-import-match.ts` — replace `mapPythonImportToFile` with the
      mapper, and give the three verdicts their three behaviours. The strategy's
      existing docblock closes with "Revisiting means gating the park on 'the
      mapped file exists in the project', which the `GlobalSymbolTable` contract
      cannot answer today" — it can now, so amend that paragraph rather than
      leaving it stale:

```ts
  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!call.receiver) return CONTINUE;
    const { receiver } = call;
    const match = ctx.imports.find((imp) => pythonImportMatchesReceiver(imp.importText, receiver));
    if (!match) return CONTINUE;

    const mapped = this.mapper.mapImportToFile(match.importText, ctx.callerFile, ctx);
    // EXTERNAL: `re.match(...)` after `import re`. The old code mapped it to the
    // phantom `re.py` and committed a file-only edge there — the measured source
    // of the Django corpus's two wrong moves (bd 86qfb). Continue instead, so
    // `targetsExternalImport` classifies it out of the recall denominator.
    if (mapped.kind === "external") return CONTINUE;
    // UNKNOWN: no verdict, so keep the pre-seam behaviour exactly — including
    // the synthesised path, which is still the best guess available.
    const targetFile =
      mapped.kind === "project" ? mapped.relPath : mapPythonImportToFile(match.importText, ctx.callerFile);
    if (!targetFile) return CONTINUE;

    const candidates = ctx.symbolTable.lookupByShortName(call.member).filter((def) => def.relPath === targetFile);
    const target = pickSingleCandidate(candidates, this.cfg.mode);
    if (target) return resolved({ targetRelPath: target.relPath, targetSymbolId: target.symbolId });
    return resolved({ targetRelPath: targetFile, targetSymbolId: null });
  }
```

- [ ] `resolveTypeFile` in `python-local-binding.ts` — the second and third
      passes both call `mapPythonImportToFile`; route both through the mapper.
      The second pass builds the imported-file set:

```ts
const importedFiles = new Set<string>();
for (const imp of ctx.imports) {
  const mapped = mapper.mapImportToFile(imp.importText, ctx.callerFile, ctx);
  if (mapped.kind === "project") importedFiles.add(mapped.relPath);
}
```

      and the third pass — the one that attributes an out-of-project type to the
      file whose import path ends in the type name — stops inventing a path:

```ts
// Third pass: bare type not in symbol table (defined outside the
// project — e.g. DRF Serializer). Walk imports: if any import path
// ends in the type name and maps to a REAL project file, attribute to it.
// A mapping that is `external` or `unknown` yields nothing: attributing a
// type to a file that does not exist is the phantom this seam removes.
for (const imp of ctx.imports) {
  if (lastSegment(imp.importText) !== bareType) continue;
  const mapped = mapper.mapImportToFile(imp.importText, ctx.callerFile, ctx);
  if (mapped.kind === "project") return mapped.relPath;
}
return null;
```

- [ ] Add `resolveFileEdges` to `PythonCallResolver`. This is the change that
      moves the file graph:

```ts
  /**
   * File→file edges from imports, through the mapper rather than through a
   * synthesised call (bd tea-rags-mcp-9fgdi).
   *
   * `defaultImportFileEdges` pushed a fake `{receiver, member} = lastSegment`
   * call through the whole chain and committed whatever came back — which, for
   * Python, was `importMatch`'s file-only edge on a path
   * `mapPythonImportToFile` invented. Answering the import question directly
   * removes the phantom AND the coupling: a change to call-resolution
   * precedence no longer silently rewrites the file graph.
   *
   * The counts MOVE when this lands. That is the intent — a package import that
   * pointed at `dcim/models.py` now points at `dcim/models/__init__.py`, and a
   * stdlib import that had an edge now has none. The jedi oracle is the gate,
   * not edge-count parity.
   */
  resolveFileEdges(extraction: FileExtraction, ctx: CallContext): GraphEdges["fileEdges"] {
    return resolveImportFileEdges(extraction, this.importFileMapper, ctx);
  }
```

- [ ] Wire the override through the facade in
      `src/core/domains/language/python/index.ts`, the same shape
      `typescript/index.ts` and `ruby/index.ts` use — the `?? []` keeps the
      facade total when the underlying resolver has no override:

```ts
      resolveFileEdges: (extraction: FileExtraction, ctx: CallContext): GraphEdges["fileEdges"] =>
        callResolver.resolveFileEdges?.(extraction, ctx) ?? [],
```

      `GraphEdges` joins the existing `contracts/types/codegraph.js` type import
      block at the top of the file.

- [ ] Update EXACTLY TWO assertions in
      `tests/core/domains/language/python/resolver/strategies/strategies.test.ts`.
      Both pinned a target that is not a file. Nothing else in that file, and no
      other test file, may change.

      First, ~line 127 — `selfField` on an external field type. The old code
      returned `targetRelPath: "ExitStack"`: a bare TYPE NAME in a path slot, by
      design at the time ("records the dependency without fabricating a wrong
      `.py` file"). With the mapper, `contextlib` is answerable as external:

```ts
  it("emits an external best-effort target when the field type is known but the method is external", () => {
    // `ExitStack` is a TYPE NAME in a relPath slot, not a file — the pre-mapper
    // best-effort shape (see the strategy docblock). Kept as the recorded
    // behaviour of `selfField`, which this seam does not migrate; the phantom it
    // used to feed (a file edge on a synthesised path) is gone regardless,
    // because file edges no longer come from the resolver chain.
    // Plan: docs/superpowers/plans/2026-09-08-python-import-file-mapper.md;
    // deferral rationale: docs/superpowers/specs/2026-08-10-deferred-symbol-resolution-design.md
    // §"Measured outcome (Python and Java)".
```

      Second, ~line 246 — `localBinding` file-only attribution on `reaction.py`.
      Add the same two-line citation above the assertion and re-derive the
      expectation from the fixture: `reaction.py` is a REAL file in that table,
      so the expected value only changes if the migrated `resolveTypeFile`
      answers differently. Run the test first, then write down what it does —
      do not guess:

```ts
// Target re-derived after the import-file-mapper migration (bd 9fgdi):
// `resolveTypeFile` now answers from symbol-table membership instead of a
// synthesised path. Plan:
// docs/superpowers/plans/2026-09-08-python-import-file-mapper.md;
// docs/superpowers/specs/2026-08-10-deferred-symbol-resolution-design.md
// §"Measured outcome (Python and Java)".
```

- [ ] If either assertion still passes untouched, delete the comment you were
      going to add and leave the test byte-identical. A comment explaining a
      change that did not happen is worse than no comment.
- [ ] A THIRD failing assertion is a regression, not a stale pin. Stop,
      diagnose, report — do not edit it.

**Gates**

- [ ] Unit: the whole language suite, green.
      `npx vitest run tests/core/domains/language`.
- [ ] No test outside the two named assertions moved:
      `git diff --stat -- tests/` must list ONLY
      `python-import-file-mapper.test.ts`, `python-imported-name.test.ts`,
      `python-import-bindings.test.ts`, `import-file-edges.test.ts` (all new)
      and `strategies.test.ts` (two assertions).
- [ ] No disk in Python resolution:
      `grep -rn "existsSync\|statSync\|readdirSync\|node:fs" src/core/domains/language/python/`
      prints nothing.
- [ ] Chain tally on all five corpora, before and after, recorded in the bead:
      `npx tsx scripts/codegraph-chain-tally.ts --lang python --corpus <name>`.
      `chainDrift` must be 0. `edges` / `fileOnly` / `unresolved` are EXPECTED
      to move — record the deltas, do not treat a change as failure.
- [ ] Jedi oracle, per corpus, before and after:
      `npx tsx scripts/py-codegraph-jedi-oracle.ts --corpus <name>`. Gate:
      `lost` = 0, `phantom` not up, `skippedInProject` not up, `match` up.
      Report per corpus AND per receiverKind. A headline over five corpora
      without its rows is not a result (spec §Measurement policy).
- [ ] The netbox / ugnest package-import numbers are the headline this seam
      exists for: 939 netbox and 233 ugnest first-party absolute imports
      resolving to `__init__.py` instead of a phantom `.py`. Confirm the count
      of file edges whose target ends in `__init__.py` went from ~0 to that
      order of magnitude.
- [ ] TypeScript untouched:
      `npx vitest run tests/core/domains/language/typescript` green and
      `git diff --stat -- tests/core/domains/language/typescript` empty.
- [ ] Perf, per corpus: peak RSS within +20% of baseline (httpx 260 MB, flask
      275 MB, ugnest 352 MB, polar 959 MB, netbox 1,293 MB), wall within +25%
      under equal load. If RSS regresses, the memo is the suspect — check that
      `answers` is not being rebuilt per file because `size()` moves during
      pass 2.
- [ ] `npm run test:coverage` at the end, meeting the configured thresholds. A
      shortfall goes to the `coverage-expander` subagent
      (`subagent_type: "coverage-expander"`, `run_in_background: true`), never
      to a lowered threshold.

**Docs**

- [ ] Add one Mechanics paragraph to `src/core/domains/language/CLAUDE.md`:

```md
- **Import → file is one seam per language.** `ImportFileMapper`
  (`contracts/types/language.ts`) answers `project | external | unknown`, and
  `import-file-edges.ts` turns the `project` answers into file edges. Python's
  `resolveFileEdges` delegates there, so its file graph no longer comes from
  pushing a synthesised call through the resolver chain — a change to call
  precedence cannot silently rewrite the file graph any more. Every Python
  consumer that asks "which file is this import" goes through
  `PythonImportFileMapper`: `importMatch`, `importedName`, `resolveTypeFile`,
  the external vocabulary. The mapper answers from `GlobalSymbolTable.hasFile` /
  `hasFilesUnder`, never from disk, and a PEP 420 namespace package answers
  `unknown` because a directory is not a legal file-edge target. TypeScript
  keeps `ts-path-mapper` for now (it probes disk); migrating it is a follow-up.
  Chain index 5, `importedName`, sits between `localBinding` and `importMatch` —
  it reads the binding the walker recorded, `importMatch` guesses from the
  module's trailing segment, and the knower must run first.
```

- [ ] Create `src/core/domains/language/python/CLAUDE.md` if it does not exist.
      A navigator carries local code-editing knowledge only, links to rules
      rather than restating them, and states each fact once:

```md
# Python vertical — navigator

- **`importText` is a persisted contract, not an internal string.** The walker's
  `collectPythonImports` emits `"a.b"`, `"a"` for `from a import b, c`, `"."`,
  `".a"`. The mapper, the external vocabulary and `importMatch` all parse it.
  Changing its shape is a walker-version bump and a reindex, not a refactor.
- **`import a.b` binds `a`.** Python binds the TOP package unless the statement
  aliases; `importedBindings` records `{ a: "a.b" }`. Getting this backwards
  makes every `os.path.join` look like a call on a module named `path`.
- **Ask membership, never the disk.** `hasFile` / `hasFilesUnder` are the only
  oracle in `resolver/`. Pass 2 runs against a hydrated symbol table whose
  working tree may have moved on, and a per-import `statSync` is a syscall storm
  on a 24k-file corpus.
- **Empty `__init__.py` files are real files with zero symbols.**
  `hasFilesUnder` cannot tell one from a PEP 420 namespace directory, and the
  two get different answers — always ask `hasFile` for the `__init__.py` itself.
- **Chain order is a correctness argument, not a preference.** See the pass list
  in `resolver/python-resolver.ts`; the guards (`super`, `selfField`,
  `selfMember`, `localBinding`) DROP rather than fall through, which is what
  keeps `serializer.is_valid()` off an unrelated class.
- Resolver architecture rules: `.claude/rules/resolver-architecture.md`.
  Cross-language mechanics: `src/core/domains/language/CLAUDE.md`.
```

- [ ] Commit:
      `feat(language): route Python import resolution through the file mapper (9fgdi)`.

---

## Decision-to-task map

Every decision has an owner, and no task depends on a symbol another task has
not yet created.

| Decision                                          | Task                                |
| ------------------------------------------------- | ----------------------------------- |
| 1. `ImportFileTarget` / `ImportFileMapper`        | 1                                   |
| 2. `resolveImportFileEdges` shared engine         | 1 (engine), 6 (Python wiring)       |
| 3. Root inference from the symbol table           | 3                                   |
| 4. `__init__.py` yes, namespace package `unknown` | 3 (mapper), 6 (edge effect)         |
| 5. Four consumers migrate together                | 5 (vocabulary), 6 (the other three) |
| 6. Walker fills names and bindings, walker 2      | 2                                   |
| 7. `reexportOriginFile` relocates                 | 4                                   |
| 8. `importedName` strategy at chain index 5       | 5                                   |
| 9. Two phantom assertions updated                 | 6                                   |

## Follow-up beads to file

- Migrate TypeScript's `ts-path-mapper` onto `ImportFileMapper` (it probes disk
  through a memoized `existsSync`; unifying it is its own risk surface).
- Attribute a PEP 420 namespace-package import to its member files instead of
  answering `unknown` (ugnest `domains/`, 966 imports; flask
  `src/flask/sansio/`; polar `polar/health/`; netbox `extras/ui/`).
- Read manifest-declared source roots from `pyproject.toml` instead of inferring
  every root from symbol-table paths.
- Read `__all__` so a star import into a package resolves past the
  several-candidates decline.
- Module-level `__getattr__` (PEP 562) re-exports: flask 2, netbox 4. Below the
  threshold that justifies a mechanism today; note the count moves with corpora.
- Navigation aliasing for `find_symbol("flask.Flask")` stays bead `m5rc` —
  resolution needs declaration lookup, aliases are a separate index.
