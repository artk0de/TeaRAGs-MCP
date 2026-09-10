---
paths:
  - "src/core/domains/language/**"
---

# Language Capability Sync (MANDATORY)

Change a chunker hook, resolver chain, walker, or test detection for a language
under `src/core/domains/language/<lang>/` → change may move that language's
capability tier. You MUST:

1. Re-review `src/core/domains/language/<lang>/capability.ts`; update `ast` /
   `tests` / `codegraph` tier or `tech` text if change altered what language
   actually supports.
2. Bump `versions` in the same descriptor if the change altered what that
   language PRODUCES for an already-indexed project (see below).
3. Run `npm run gen:lang-compat` to regenerate
   `.claude-plugin/tea-rags/rules/language-compatibility.md` and the README
   `<!-- BEGIN/END lang-compat -->` spoiler block from the descriptors.
4. Commit regenerated artifacts alongside your change.

Drift-guard test (`tests/core/domains/language/capability/drift-guard.test.ts`)
fails CI when committed files diverge from descriptors — red drift-guard = step
3 skipped.

## Which `versions` number to bump

Not a formality — the number IS the routing decision, because the reindex hint
reads it to pick the operator's command:

| Change                                          | Bump              | Hint recommends                                    |
| ----------------------------------------------- | ----------------- | -------------------------------------------------- |
| Chunker hook, chunk boundary, symbolId shape    | `chunking`        | `tea-rags index-codebase --force`                  |
| Walker pass, resolver chain, dispatch narrowing | `walker`          | `--force-enrichments codegraph --languages <lang>` |
| Edge kind / edge vocabulary this language emits | `codegraphSchema` | `--force-enrichments codegraph --languages <lang>` |

The dividing line is whether the CHUNK SET moves: point ids hash content and
line range, so a chunking change relocates every id and only a full reindex is
coherent. Bumping `chunking` for a resolver fix costs the operator a full
rebuild they did not need; bumping `walker` for a chunker change hands them a
recompute that repopulates nothing.

The upstream grammar version is NOT declared here — it is read from the
installed `ast.grammarPackage` at runtime, so a `tree-sitter-*` dependency bump
needs no descriptor edit at all.

Leave `versions` alone for a pure refactor, a perf fix, or anything whose output
is byte-identical. Every bump costs somebody a reindex.

Capability descriptor = single source of truth; rule file + README spoiler =
GENERATED views. Never hand-edit generated files — edit descriptor, regenerate.

Measured `resolveSuccessRate` is NOT a capability tier — it is per-index state
owned by `tea-rags prime`. Never bake measured numbers into a descriptor. A
`versions` integer is not a measurement — it is a revision counter, and the one
number in the descriptor that is allowed to move without any tier moving.

Why the versions live here at all: this rule already routes every hook / walker
/ resolver change through this file, so the bump is reviewed where the change is
reviewed. `SchemaDriftMonitor` cannot substitute — it compares payload signal
KEYS, and a grammar or resolver bump moves none of them (bd tea-rags-mcp-frwka;
comparison + hint live in
`src/core/domains/maintenance/language-version-drift-monitor.ts`).

## When the bump lands

The bump is part of the branch, not of a later cleanup: it MUST be on the
worktree branch before the merge into `main`. A `chore(language): declare …`
commit at the end of a wave is fine (python does this); a release cut between
the merge and a bump that never came ships an index every user believes is
current. `tests/core/domains/language/capability/version-pins.test.ts` runs on
the merged result in CI and fails when walker / resolver / chunking sources
changed while neither the version nor the pin moved.

## Relocations and other byte-identical changes

Moving code into the kernel, extracting a helper, or renaming leaves `versions`
alone — but the claim that the output is byte-identical is a claim. Record it:
re-pin with `npm run pin:lang-versions` and put

    Versions: unchanged — <why the output cannot have moved>

in the commit body, the same way `silo-pairing.md` demands a `Why:` line. For
resolver relocations the evidence is the harness delta
(`scripts/codegraph-chain-tally.ts --lang <lang>` before and after, edge count
and resolveSuccessRate equal), not a reading of the diff. Seven ruby relocations
(2026-09-09/10) shipped on the reading alone; D4 of the drift program measures
them after the fact.
