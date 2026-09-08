# Python Codegraph Unification Program — Design

**Status:** approved (brainstorm 2026-09-02/03) **Kind:** program (five epics)
**Related:** `tea-rags-mcp-z6ry9` (Plugin SDK), `tea-rags-mcp-v9k2s` (resolver
substrate migration), `tea-rags-mcp-m99j1` (precision + recall roadmap),
`tea-rags-mcp-q9u85` / `pbwd` / `m5rc` / `873f` (open Python beads)
**Worktree:** `.claude/worktrees/py-codegraph-unification-specs` at main
`d7e942ab9`

## Goal

Not "a Python vertical at Ruby parity". The deliverable is a set of **unified
components reused across codegraph builders and beyond them**: Ruby is the pilot
that grew the richest component set (much of it Ruby-private); Python is the
second consumer that makes each generalization honest — one implementation is
not an abstraction, two are. Every shared component is expressed in the contract
shape the Plugin SDK (`z6ry9`) hands to external authors, so a native language
is a built-in plugin.

Constraints fixed by the user:

- Python 3 only (EOL Python 2 is out; tree-sitter-python is a Python 3 grammar).
- High precision, including the Python analogues of an autoloader.
- Production stays LSP-free (`m99j1`); a Python-side oracle is measurement-only.
- Every increment is measured on real corpora before it is believed.
- Implementation runs in Opus subagents; the parent session orchestrates,
  diagnoses, and validates.

## Ground truth (why the scope is what it is)

### Python today

`src/core/domains/language/python/` is 1,225 LOC: a single-file walker
(`walker/walker.ts`, 570 LOC), a six-strategy chain
(`resolver/python-resolver.ts:68-75`: `super` → `selfField` → `selfMember` →
`localBinding` → `importMatch` → `globalShortName`), one dispatch component (the
shared `ConeDispatchResolver` passed bare, not through
`resolveDispatchViaComponents`), `python-path-mapper.ts` (used by two
strategies, not wired to `resolveFileEdges`), and an inline 11-line
`targetsExternalImport`. Capability tier `moderate`. No `deferred` park site
exists in the chain — deferral was measured and rejected for `localBinding` and
`importMatch` (bd `86qfb`,
`docs/superpowers/specs/2026-08-10-deferred-symbol-resolution-design.md`).

Ruby is 15 strategies + 4 dispatch components (+ enqueue, self-dispatch entry,
fan-out gates, duck vocabulary), a type-fact store with seven ranked sources, a
20-module DSL catalogue gated by the Gemfile, Zeitwerk autoload resolution,
`db/schema.rb` column accessors, and codegraph exclusions — roughly 6,148 LOC of
walker plus 23 strategy files.

### Baseline (`scripts/codegraph-chain-tally.ts --lang python`, chain drift 0)

| corpus          | stack                                            | effective files | call sites | edges | file-only / edges | unresolved | annotated `def`s               |
| --------------- | ------------------------------------------------ | --------------- | ---------- | ----- | ----------------- | ---------- | ------------------------------ |
| ugnest (user's) | Django 6.0 + DRF 3.15                            | 236             | 7,331      | 19.5% | 22.0%             | 80.5%      | 67.7% (Google docstrings ×252) |
| flask           | library                                          | 35              | 2,172      | 35.5% | 19.2%             | 64.5%      | 94.8%                          |
| netbox          | Django 6.0 + DRF 3.17 + rq                       | 1,038           | 60,731     | 36.2% | 37.3%             | 63.8%      | **3.4%**                       |
| polar           | FastAPI + SQLAlchemy 2.0 + pydantic 2 + dramatiq | 1,339           | 82,554     | 25.8% | 18.6%             | 74.2%      | 99.4%                          |
| httpx           | typed library                                    | 23              | 2,643      | 38.3% | 19.1%             | 61.7%      | 100%                           |

Corpora: ugnest at `~/Dev/Collaborate/ugnest`, flask at
`~/Dev/OpenSource/codegraph-test/flask`, the three public ones cloned 2026-09-02
into `~/Dev/Tools/tea-rags-bench/corpora/` (netbox `1fae2d0`, polar `bddb750`,
httpx `b5addb6`). The tally harness excludes virtualenvs and test paths but NOT
`migrations/`.

What the numbers say:

- **The denominator is dirty.** Python has no `ExternalVocabulary`, so every
  Django / DRF / stdlib call whose definition lives in `venv/` sits in
  "unresolved". Most of ugnest's 5,899 unresolved sites are structurally
  external. The first lever is an honest denominator, not recall.
- **Typing is trimodal**: netbox 3.4%, ugnest 67.7%, polar/httpx ≈ 100% — the
  Python analogue of Ruby's untyped-Rails vs YARD-annotated split. The most
  annotated corpus (polar) resolves worst: the chain reads no annotations.
- **Dict-of-callables dispatch is rare** in the strict same-file subscript-call
  form (netbox 1, polar 1, httpx 0, ugnest 0, flask 1) — `pbwd` is deprioritized
  by data. The high-frequency indirection idioms are `super()` (netbox 730,
  polar 619), `getattr(` (389 / 141), `__init__.py` re-exports (44 / 33, ugnest
  31 all with `__all__`, flask `import Y as Y` ×57), star-imports (netbox 532),
  and multi-base classes (netbox 798 = 16.4%).
- polar carries 36 files of Python 3.14 syntax (PEP 758) that CPython 3.13
  rejects and tree-sitter accepts — the oracle for polar must run on 3.14.
- ugnest's registry entry (`code_035da920`) has `codegraphEnabled: false`;
  codegraph has never been built on it.

### Seam inventory (43 seams; full table in the E0 spec appendix)

**(a) Shared engine exists, Python is unplugged:** `ExternalCallClassifier`
(`domains/language/external-classifier.ts:18`), `resolveDispatchViaComponents`
(`resolver-chain.ts:75`), `resolveNarrowedFanout` + six narrowers
(`kernel/dispatch-narrowing.ts`), `assignCallsToInnermostChunks`
(`kernel/assign-calls-to-chunks.ts:72`; Python duplicates it with an O(n·c) line
filter at `walker.ts:76`), `LanguageProvider.codegraphExclusionGlobs`,
`resolveFileEdges` (Python inherits `defaultImportFileEdges` while
`mapPythonImportToFile` already exists).

**(b) Ruby-private but language-neutral in substance — relocation candidates:**
the `resolveChain` fold (`ruby/resolver/type-propagation.ts:185`), `RubyTypeRef`
(already in the neutral contract at `contracts/types/language.ts:630`, consumed
by four non-Ruby files), `RubyTypeFactStore.fromFacts(facts, sourceOrder)`
(`ruby/walker/type-fact-store.ts:87`; only `DEFAULT_SOURCE_ORDER` is Ruby data),
constructor-instance inference
(`ruby/walker/type-sources/ast-inference.ts:61,95` vs Python's
`extractConstructorTypeName` at `walker.ts:465`), prepend-aware C3
`linearizeAncestors` (`ruby/resolver/ancestor-linearization.ts:65`; Python's
`walkClassExtendsForMethod` is a single-parent walk although the walker already
emits multi-base `inheritanceEdges`), the method-signature channel
(`arity/kwargs/visibility/paramNames` — neutral contract, Ruby sole filler),
table dispatch (`ruby-table-dispatch.ts:37` and a TS inline twin at
`typescript/resolver/ts-resolver.ts:619` — two implementations, zero engine),
convention-receiver typing (`ruby-unbound-receiver-types.ts:178`), and the
structured-macro expander registry (`ruby/walker/structured/types.ts:27`).

**(c) Genuinely Ruby-specific, stays Ruby-private:** Zeitwerk (Python imports
are explicit), bare-call detection (Python has an explicit `self.`),
`super`/`zsuper` reverse-consensus over includers, `db/schema.rb` accessors
(Django / SQLAlchemy declare fields in source), AR relation guard and the
enqueue verb map (framework DATA on a neutral seam, not language mechanics).

**Risk files.** `ruby/resolver/type-propagation.ts` is hotspot + 100%
single-owner silo + architectural hub (fanIn 10, transitiveImpact 50, bugFixRate
28, 18 commits); `ruby/walker/type-sources/ast-inference.ts` is silo

- hub (fanIn 6, transitiveImpact 49). Both are touched ONLY by byte-identical
  relocations under the protocol below.

## Decisions

| #   | Question           | Decision                                                                                                                                                                                                                                                                          |
| --- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Measurement oracle | Offline **jedi** oracle + `codegraph-chain-tally`. jedi runs only in the harness; production stays LSP-free.                                                                                                                                                                      |
| 2   | Success bar        | **Precision-gated, ugnest anchor**: oracle-measured fabricated + wrongFile ≤ 2% of edges, `inProjectEdgeRecall` ≥ 0.85 overall and ≥ 0.80 per receiverKind with n ≥ 100. Per increment: `lost` 0, fabricated not up.                                                              |
| 3   | Corpora            | ugnest + flask + **netbox + polar + httpx** — untyped framework / typed framework / typed library.                                                                                                                                                                                |
| 4   | Consumers          | **Native language = built-in plugin.** Shared components take the SDK contract shape (`pass` / `strategy` / `dispatchComponent` / `typeSource` / `vocabulary` / `manifestGate` / `moduleResolver`). Consumers: Ruby / Python / TS builders, the chunker, plugin authors.          |
| 5   | Approach           | **B — Python-first pull with a contract spine** (below). Contract-first (A) rejected: contracts designed from one implementation stay Ruby-shaped (`RubyTypeRef` is the standing example). Parallel verticals (C) rejected: reproduces the duplication `v9k2s` already documents. |
| 6   | Decomposition      | Program E0 → (E1 ⇄ E2) → E3 → E4; E0 Measurement is the first spec and the first plan.                                                                                                                                                                                            |

## Architecture

### Contract spine — component kind → contract → engine

| Kind (SDK primitive)                         | Contract                                                                                                                                           | Shared engine                                                                                        | Ruby today                                          | Python (E2 / E3)                                                                                                               |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `ExtractionPass`                             | **new** `(root, ctx) → Partial<FileExtraction>` (`pss0q`)                                                                                          | pass-runner + `mergeExtraction` (`qns77`), Model A: native monolith, then passes, append-only merge  | monolith                                            | monolith + passes                                                                                                              |
| `TypeRef`                                    | **rename** `RubyTypeRef → TypeRef` (alias kept); `ruby/type-ref.ts` → `kernel/type-ref.ts`                                                         | —                                                                                                    | ✓                                                   | ✓                                                                                                                              |
| `TypeSource` (inline / sidecar) + `TypeFact` | **generalize** `RubyInlineTypeSource` / `RubySidecarTypeSource` / `RubyTypeFact`                                                                   | `TypeFactStore.fromFacts(facts, sourceOrder)` → `kernel/type-fact-store.ts`; ranks are language data | yard › associations › draper › body-last-expr › ast | annotations › `.pyi` stubs › docstring › orm-declared › body-last-expr › ast                                                   |
| `ReceiverTypePropagation`                    | **new** `propagateChain(seed, links, returnTypeOf, maxHops)` — the fold from `type-propagation.ts:185`; seed cases (`@ivar`, `::`, `[]`) stay Ruby | `domains/language/type-propagation.ts`                                                               | ✓                                                   | seeds: `self.x`, `cls`, `Module.attr`, subscript                                                                               |
| `AncestorLinearizer`                         | **new** `linearize(cls, channels) → string[]` — C3 with optional prepend channel                                                                   | `kernel/ancestor-linearization.ts`                                                                   | prepend-aware                                       | plain C3, multi-base                                                                                                           |
| `MethodSignature` filler                     | contract exists; per-language AST read                                                                                                             | narrowers in `kernel/dispatch-narrowing.ts`                                                          | ✓                                                   | `*args` / `**kwargs`, defaults, `_`-prefix visibility                                                                          |
| `DispatchResolverComponent`                  | exists (`language.ts:99`)                                                                                                                          | `resolveDispatchViaComponents` + narrowing                                                           | table → union → cone → dynamic                      | table → union (PEP 604) → cone → dynamic (duck)                                                                                |
| `TableDispatch`                              | **generalize** the Ruby component + TS inline twin                                                                                                 | shared component over `dispatchTables` / `CallRef.dispatch`                                          | ✓                                                   | dict-of-callables (last, by data)                                                                                              |
| `ExternalVocabulary`                         | exists (`language.ts:135`)                                                                                                                         | `ExternalCallClassifier`                                                                             | ✓                                                   | **E0**                                                                                                                         |
| `FrameworkModule<TEntry>` + `ManifestGate`   | **generalize** `RubyFrameworkVocabulary` / `defineFrameworkVocabulary` / `catalogueForGemfile`                                                     | registry fold `composeCatalogue(modules, manifest)`                                                  | 20 modules, Gemfile                                 | Django / DRF / rq / dramatiq / Celery / Flask / FastAPI / SQLAlchemy / pydantic; gate = `pyproject.toml` + `requirements*.txt` |
| `ModuleResolver` (autoload layer 1)          | `resolveFileEdges` exists; **new** `{ resolveImport(importText, fromFile) → RelPath \| external; publicNames(packageFile) → alias map }`           | per-language                                                                                         | Zeitwerk + require                                  | path mapper + `__init__` / `__all__` / `import Y as Y` re-exports + PEP 420 namespace packages + PEP 562 module `__getattr__`  |
| `DeclarationExpander`                        | **generalize** `StructuredMacroExpander` registry                                                                                                  | shared registry                                                                                      | aasm / enum / state_machine                         | `@property` (+ setter, closes `873f`), `@cached_property`, `@dataclass`, `@classmethod` / `@staticmethod`                      |
| `ConventionReceiver`                         | **generalize** `conventionReceiverType(regex, keywords, subtypeGate)`                                                                              | shared                                                                                               | `CONVENTION_RECEIVER`                               | snake_case variable named after a class                                                                                        |
| `ChunkingHook`                               | exists                                                                                                                                             | shared                                                                                               | rspec-scope                                         | pytest-scope — **outside this program** (tests tier; its own bead)                                                             |

Ruby-only mechanisms are not generalized (list (c) above).

### The Python "autoloader" — two layers, one seam

Ruby's Zeitwerk answers "how does a constant name become a file". Python has no
single equivalent; the same question is answered by two layers that both land on
`ModuleResolver` + `FrameworkModule`:

1. **Package namespace** — `__init__.py` re-exports with `__all__`, explicit
   `import Y as Y` re-exports, PEP 420 namespace packages, PEP 562 module-level
   `__getattr__`, `src/` layout and package roots. Owner: `ModuleResolver`.
   Closes `m5rc`.
2. **Framework registries addressed by string** — `apps.get_model("app.Model")`,
   `settings.AUTH_USER_MODEL`, URL routes to `views.x` / `as_view()`, DRF
   `router.register`, `serializer_class` / `queryset`, `SerializerMethodField` →
   `get_<field>`, `@receiver`, Celery / rq / dramatiq enqueue verbs. Owner:
   `FrameworkModule` data, consumed by strategies and dispatch components
   exactly as Ruby's DSL entries are.

### Relocation protocol (one bead per seam)

1. DOES / OWNS / INTERFACE and the SDK kind are written in the bead before code.
2. The shared engine appears **net-new** (TDD, its own tests). Ruby switches to
   it by **relocation**: Ruby business-logic tests are moved, never rewritten
   (`.claude/rules/resolver-architecture.md` §4).
3. Relocation gate, all automatic: (a) Ruby suite + `npm run test:coverage`
   green without test edits; (b) `codegraph-chain-tally.ts --lang ruby` on
   mastodon AND taxdome → `edges` / `fileOnly` / `unresolved` byte-identical;
   (c) `taxdome-codegraph-recall-forensics.ts` parity per receiverKind.
4. Python supplies its collaborator. Python increment gate: jedi oracle `lost`
   0, `fabricated` not up, `match` up; tally drift 0.
5. The two risk files are touched only by step 2 relocations — no incidental
   improvements ride along.

### Epics

| Epic                                 | Scope                                                                                                                                                                                                                                                                     | Class    | Exit                                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **E0 Measurement**                   | jedi oracle harness (TS host + Python side), corpora manifest + provisioning, Python `ExternalVocabulary` + `GlobalSymbolTable.hasFile`, baseline ×5, user-gated ugnest live reconciliation                                                                               | sub-epic | deterministic oracle; per-corpus ground-truth coverage reported; live vs oracle ±2 pp per receiverKind on ugnest; precision floors recorded |
| **E1 Substrate relocations**         | pass-runner `pss0q` + `mergeExtraction` `qns77` first; then `TypeRef`, `TypeFactStore` + `TypeSource`, `propagateChain`, `AncestorLinearizer`, method-signature channel, `TableDispatch`, `ConventionReceiver`, `DeclarationExpander`, `FrameworkModule` + `ManifestGate` | epic     | every relocation passes the triple gate; Ruby numbers byte-identical                                                                        |
| **E2 Python collaborators**          | `ModuleResolver` (both autoload layers), annotation / docstring / AST / body-last-expr type sources, C3 + `super`, signatures + visibility, decorators, dispatch components table / union / cone / dynamic, chain typing, `assignCallsToInnermostChunks`, exclusion globs | epic     | decision 2 thresholds on ugnest; no regression on the other four corpora                                                                    |
| **E3 Python framework vocabularies** | pyproject-gated modules: Django (Manager / QuerySet returns, field → attribute types, signals, urls, `get_model`), DRF, rq / dramatiq / Celery enqueue, Flask proxies, FastAPI `Depends` / routers, SQLAlchemy `Mapped[]` / `relationship`, pydantic                      | epic     | per-framework oracle deltas on the corpus that exercises it                                                                                 |
| **E4 SDK freeze (z6ry9)**            | contracts proven by two consumers → `@tea-rags/plugin-sdk`, builders, conformance test `uxo8l`, loader, augmenting factory                                                                                                                                                | epic     | z6ry9 children closed                                                                                                                       |

Dependency graph: `E0 → (E1 ⇄ E2 interleaved by pull order) → E3 → E4`. E1 and
E2 interleave by design — a seam is relocated when Python pulls on it.

### Predicted pull order

A hypothesis: E0's oracle attribution confirms or reorders it.

1. `ExternalVocabulary` — denominator (E0)
2. `ModuleResolver` + re-exports + star-import + namespace packages
3. `TypeSource: annotations` → local / param / return types (the largest recall
   lever: polar and httpx ≈ 100% annotated, ugnest 68%)
4. `AncestorLinearizer` C3 + `super`
5. `FrameworkModule`: Django Manager / QuerySet + DRF (netbox 3,657
   `.objects.`), SQLAlchemy `Mapped[]` / FastAPI `Depends` (polar) — E3
6. `ReceiverTypePropagation` multi-hop + return-type binding
7. Dispatch: union (polar 10,343 PEP 604 unions) → dynamic / duck → table (last)

## Decision records (seam level, 2026-09-08)

Each seam gets a short record here when its plan is written; the plan carries
the code, this section carries the reasoning that survives the plan.

### E1 seam 0 — extraction pass-runner (`pss0q`, `qns77`, `dppsr`, `vqdw1`)

- `ExtractionPass<T>` and `WalkContext` already exist in
  `contracts/types/language.ts:196–225` with zero consumers; `mergeExtraction` /
  `mergeProvider` do not exist. Ruby's walker is already an orchestrator over 16
  modules, but three collaborators (`file-type-env`, the `siteContextAt` closure
  from `chunk-extractions`, the `type-channels` mutator) are not pass-shaped and
  reach both risk files transitively.
- Decision: Model A literally. Native monoliths are NOT re-sliced. A kernel
  engine (`runExtractionPasses` + `composeExtractionWalker`) runs the native
  walk, then an ordered list of `ExtractionFacetPass`es, merging
  `Partial<FileExtraction>` through a typed rulebook (`mergeExtraction`). With
  zero passes the composed walker returns the native object by identity, so
  wiring Ruby and Python is a relocation. New Python facets arrive ONLY as
  passes. `WalkContext` gains `gemfileContent?`.
- Rulebook: Records union with the base's key kept; arrays concat; set-like
  arrays dedupe; `chunks` merge by `symbolId` (calls concat, `localBindings`
  union re-sorted by line, scalars base-wins with `??` fill); an incoming empty
  channel is a no-op, so a channel the walker left absent is never materialised
  (NDJSON spill parity); a new channel is a compile error via a mapped type over
  `keyof`. Precedence inversions inside a native walker stay there.
- Gate: Ruby parity harness (`scripts/spikes/ruby-walker-composition-parity.ts`,
  JSON-equality over mastodon), Python chain-tally byte-identical on all five
  corpora, peak RSS ≤ +20%, existing walker tests untouched.
- Plan: `docs/superpowers/plans/2026-09-08-extraction-pass-runner.md`.

### E2 seam 1 — Python import file mapper and re-exports (`9fgdi`)

- Evidence: Python file edges come from `defaultImportFileEdges`
  (`resolution-runner.ts:67–84`), which pushes a fake call through the chain;
  `importMatch` commits a file-only edge on a path the string synthesiser made
  up, so 15–62% of first-party absolute imports (package `__init__.py`) land on
  phantom paths that are persisted unfiltered. Every Python file signal (fanIn,
  fanOut, instability, transitiveImpact, isHub) is computed over them today.
  Import root ≠ repo root in netbox (`netbox/`), flask (`src/`), polar
  (`server/`). The walker discards the names of `from X import Y`. Namespace
  packages are real and imported (ugnest `domains/`). TypeScript resolves
  barrels resolver-side (`reexportOriginFile`, hop-agnostic symbol-table
  lookup), not in the walker.
- Decisions: (1) `GlobalSymbolTable` gains `hasFile` and `hasFilesUnder`
  (refcounted directory index, O(1), no disk) — E0 lands them; (2) a shared seam
  `ImportFileMapper.mapImportToFile(importText, fromFile, ctx) → project | external | unknown`
  plus a shared `resolveImportFileEdges`; the Python mapper infers source roots
  from symbol-table paths (manifest-declared roots are a follow-up), resolves
  `.py` vs `/__init__.py` vs namespace directory, memoises per symbol-table
  identity and size; (3) `reexportOriginFile` relocates byte-identically to
  `kernel/reexport-origin.ts` and TypeScript re-imports it; (4) a Python
  `importedName` strategy sits between `localBinding` and `importMatch` and
  covers star imports; (5) the native Python walker fills `importedNames` /
  `importedBindings` (walker version → 2); (6) `importMatch`, `resolveTypeFile`,
  the external vocabulary and the new `resolveFileEdges` override all consume
  the one mapper; (7) the two unit assertions pinning phantom targets are
  updated with rationale.
- Navigation aliasing for `find_symbol("flask.Flask")` (bead `m5rc`'s navigation
  half) stays a separate bead: resolution needs declaration lookup, not alias
  symbols.
- Plan: `docs/superpowers/plans/2026-09-08-python-import-file-mapper.md`
  (pending).

## Measurement policy

- **Oracle** (E0): per call site, the production chain's answer vs jedi's ground
  truth; verdict vocabulary shared with
  `scripts/ts-codegraph-typechecker-oracle.ts`. Ranks the missed-shape
  categories that drive the pull order.
- **Tally** (`codegraph-chain-tally.ts`): blind-spot coverage and A/B `--defer`
  diffs; chain drift must be 0.
- **Live** (user-gated): `tea-rags index-codebase` + `DEBUG=1 tea-rags prime`
  `resolveSuccessRate` per receiverKind; reconciled against the oracle's chain
  output (the TS wave's live-vs-oracle mismatch is what exposed the
  generated-files hole).
- Every rate is reported per corpus AND per receiverKind; a headline over five
  corpora is never quoted without its per-corpus rows.

## Non-goals

- pytest scope chunking (tests tier) — its own bead.
- Any LSP or type checker in the production path.
- Migrating TS / JS / Java / Go onto the relocated engines — `v9k2s` remains the
  follow-up; this program only adds the second consumer.
- Cross-service edges (`fjfj7`).
- Changing Ruby behaviour in any relocation.

## Forecast

Anchor: codegraph foundational (3 weeks, ~100 commits) and the cai0 Ruby
precision program. Program ≈ 80–140 commits; substrate-exists discount ×0.6
(engines, harness patterns, Ruby pilot exist); parallel-work ×1.3 (two live docs
worktrees plus per-epic Opus agents); algorithmic-novelty ×1.2 on C3 and
propagation only. **P25 4 / P50 5 / P75 6.5 calendar weeks.** E0 is the first
burst week.

## Beads

Program epic `tea-rags-mcp-1v12o` with five child epics (parent-child): E0
`mmckn`, E1 `fmcly`, E2 `9fgdi`, E3 `qclv2`, E4 = `z6ry9`. Ordering: E1 and E2
depend on E0, E3 on E2. E0's plan creates its tasks (`plan-beads-sync`).
Existing beads folded in: `pss0q`, `qns77` (E1 first tasks), `q9u85` (unblocked
by `hasFile`), `m5rc` (E2 `ModuleResolver`), `873f` (E2 `DeclarationExpander`),
`pbwd` (E2, last by data), `1nmeb` (JS resolver — sibling consumer after E2, not
in this program).

## Follow-up specs

- `2026-09-03-python-codegraph-e0-measurement-design.md` — E0 (approved with
  this document).
- E1 / E2 / E3 / E4 specs are written when E0's baseline confirms the pull
  order; each gets its own brainstorm → spec → plan cycle.
