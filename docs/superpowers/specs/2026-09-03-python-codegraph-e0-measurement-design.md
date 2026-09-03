# Python Codegraph E0 — Measurement — Design

**Status:** approved (brainstorm 2026-09-03) **Bead:** `tea-rags-mcp-mmckn`
(child of program `tea-rags-mcp-1v12o`) **Parent spec:**
`2026-09-03-python-codegraph-unification-program-design.md` (epic E0) **Class:**
sub-epic, 6 tasks **Worktree:**
`.claude/worktrees/py-codegraph-unification-specs`

## Goal

Give the Python resolver the same measurement footing TypeScript got from
`scripts/ts-codegraph-typechecker-oracle.ts` (bd `yttre` / `2mvc2`): for every
call site, the production chain's answer diffed against independent ground
truth, bucketed by receiverKind and by the strategy that answered, on five
corpora, deterministic across runs. Plus the one production change the
measurement cannot do without — an honest denominator via a Python
`ExternalVocabulary`.

Everything downstream (E1–E4) is gated on this instrument. Nothing here changes
Ruby.

## Why jedi, and why measurement-only

Python has no in-process type checker the way TypeScript has `ts.Program`. jedi
is a pure-Python static analysis library: in-process, no server, no protocol,
and it resolves through the corpus's own virtualenv so third-party types
(Django, DRF, SQLAlchemy) are ground truth rather than a blind spot. It is
weakest exactly where the resolver is weakest — untyped dynamic code — and that
is reported as `unknown`, not hidden. jedi never enters the production path;
`m99j1`'s LSP-free rule holds.

Precedents reused verbatim: the verdict vocabulary, the corpus-parity walk, the
"pure core unit-tested, harness drives it" split, and the two lessons documented
in the TS oracle header — production-parity corpus selection and random rather
than first-N sampling.

## Components

### A. TS host — `scripts/py-codegraph-jedi-oracle.ts`

**DOES.** Walks a corpus exactly as production selects files, runs the
production Python chain as a black box, asks the Python-side oracle for ground
truth over the same call sites, diffs the two, and tallies.

**OWNS.** `scripts/py-codegraph-jedi-oracle.ts`; pure core in
`scripts/lib/codegraph-oracle-core.ts` (see "Pure core" below); tests in
`tests/scripts/py-codegraph-jedi-oracle.test.ts`.

**INTERFACE.**

```text
npx tsx scripts/py-codegraph-jedi-oracle.ts \
  --corpus <abs path> [--repo-root <abs path>] \
  --python <interpreter running jedi> --environment <corpus venv> \
  [--limit N] [--samples N] [--seed N] [--json out.json] [--quiet]
```

Mechanics, in order:

1. **Corpus parity.** File selection = `BUILTIN_IGNORE_PATTERNS` + the ignore
   files `FileScanner` reads (`.gitignore`, `.contextignore`,
   `.contextignore.local`) + `buildCodegraphExclusionFilter` with the language
   factory — the same three layers the TS oracle applies, and the two excluded
   populations are reported separately. Every `CODEGRAPH_LANGUAGES` extension is
   walked into ONE symbol table (netbox ships JS); only `.py` call sites are
   scored.
2. **Chain as black box.** `LanguageFactory.create("python")` → walker →
   `collectSymbols` → `InMemoryGlobalSymbolTable` → `PythonCallResolver`. The
   runner's order is reproduced verbatim: `resolve` → on `null`,
   `targetsExternalImport` → on `false`, `targetsCoreAmbiguousMember`
   (`resolution-runner.ts:332-348`). `receiverKind` comes from the production
   `classifyReceiverKind(call, localBindings)`
   (`domains/trajectory/codegraph/symbols/receiver-kind.ts:63`).
3. **`answeredBy`.** A harness-local `SymbolResolutionStrategy` wrapper records
   which pass returned `resolved` (precedent: `DeferFileOnlyStrategy` in
   `codegraph-chain-tally.ts`). The chain array is rebuilt from the exported
   strategy classes in production order; every call site cross-checks the
   rebuilt chain against the real `provider.resolver` and a non-zero
   `chainDrift` voids the run. No production file changes for this.
4. **Oracle protocol.** The host writes the scored call sites as NDJSON, one
   record per site (`relPath`, `startLine`, `callText`, `receiver`, `member`,
   `receiverKind`), spawns the Python oracle once per corpus, streams files
   through stdin, reads NDJSON verdict inputs from stdout. The Python side never
   sees the chain's answer.
5. **Verdicts.** Same `OracleVerdict` as TS — `match` / `fileOnly` / `wrongFile`
   / `missed` / `phantom` / `agreeExternal` / `chainOnly` / `bothUnresolved` —
   plus two Python-specific sub-buckets: `skippedInProject` (the classifier
   called the site external, ground truth is in-project — the classifier's
   precision defect) and `parseFailed` (the oracle interpreter could not parse
   the file — polar's PEP 758 files). `OracleOutcome` stays
   `inProject | external | unknown`; `OracleTargetOrigin` becomes
   `project | stdlib | sitePackages | builtin | generatedInRepo | outsideRepo`
   (`generatedInRepo` = `migrations/`).
6. **Missed-shape categories** (the Python analogue of
   `TYPE_FEATURE_CATEGORIES`, several per site): `annotationParam`,
   `annotationReturn`, `reexport`, `starImport`, `superMro`,
   `decoratorProperty`, `managerQuerySet`, `dependsInjection`, `unionReceiver`,
   `plain`. Ranked by count they are the program's pull order.
7. **Tally.** `receiverKind × verdict`, `answeredBy × verdict`, category ×
   verdict, origin distribution, ground-truth coverage (`unknown` share). Sample
   rows per verdict are drawn with a seeded PRNG, never first-N.

**Pure core.** The diff / tally / ranking functions are already exported by
`ts-codegraph-typechecker-oracle.ts` and unit-tested. If importing that module
executes its `main`, the pure core is relocated to
`scripts/lib/codegraph-oracle-core.ts` and the TS oracle re-imports it — a
relocation: its tests move, they are not rewritten. Otherwise the Python host
imports directly and no TS file changes.

### B. Python side — `scripts/py-oracle/jedi_oracle.py`

**DOES.** Locates each call site in the file's own AST, asks jedi where the
callee is defined, classifies the answer. Thin by design — the comparison logic
lives in A.

**OWNS.** `scripts/py-oracle/jedi_oracle.py` (+ `pyproject.toml` declaring
`jedi==0.20.0` for `uv run`), fixture corpus `tests/fixtures/py-oracle/` (six
files covering: annotated param / return, `__init__` re-export with `__all__`,
`import Y as Y`, `super()` on a multi-base class, `@property` / `@staticmethod`,
stdlib and third-party receivers).

**INTERFACE.** stdin NDJSON `{relPath, startLine, callText, receiver, member}`
grouped by file → stdout NDJSON
`{relPath, startLine, outcome: {kind, origin?, targets?: [{relPath, symbolId, defLine, defKind, pinUncertain}]}, unlocated?: shape}`.

Mechanics:

1. `ast.parse` with the interpreter running jedi
   (`uv run --python <version> --with jedi==0.20.0`). Version follows the
   corpus's `requires-python`; polar runs on 3.14. Parse failure → every site in
   the file reports `parseFailed`.
2. Enumerate `ast.Call` nodes and decorator names (the walker emits decorator
   calls via `collectPythonDecoratorCalls`); match each host record by
   `(startLine, member, receiver text)`. `CallRef` carries no column, so the
   match is by line + callee shape; an unmatched record reports `unlocated` with
   a shape (`decoratorBare`, `multiLineCall`, `subscriptCall`, `coordinateMiss`)
   — reported by shape, never as one opaque number.
3. `jedi.Script(code, path=abs).goto(line, col, follow_imports=True, follow_builtin_imports=False)`
   at the callee's end position; on empty, `.infer()`.
   `jedi.Project(root, environment=jedi.create_environment(venv))` so
   third-party resolution runs against the corpus venv while jedi itself lives
   in the `uv` environment.
4. Classify every returned `Name.module_path`: under the corpus root and not a
   venv → `project`; `None` → `builtin`; top-level module in
   `sys.stdlib_module_names` → `stdlib`; under `site-packages` → `sitePackages`;
   under `migrations/` → `generatedInRepo`; else `outsideRepo`. Several targets
   → all reported; A scores `match` when the chain's target is one of them.
5. symbolId composition mirrors `DefaultSymbolIdComposer`: `Class#method` for
   instance methods, `Class.method` when the target `def`'s `decorator_list`
   holds `staticmethod` / `classmethod`, bare `function` at module level,
   `Outer.Inner` for nested classes. When the def node cannot be read back
   (`defLine` outside the file, dynamic target) the record carries
   `pinUncertain: true` and A compares at file granularity only.
6. Performance: one `jedi.Script` per file, `multiprocessing.Pool` across files,
   deterministic ordering of output. polar (82,554 sites) is expected at 15–40
   minutes; `--limit` for smoke runs.

### C. Python `ExternalVocabulary` — production

**DOES.** Tells the runner which unresolved calls leave the project, so they
stop counting as recall misses; tells it which member names are core homonyms
(`get`, `items`, `append` …) so they stop counting either.

**OWNS.**
`src/core/domains/language/python/resolver/python-external-vocabulary.ts`; data
under `src/core/domains/language/python/vocabulary/`: `builtins.ts` (the
`builtins` module's callables), `stdlib-modules.ts` (union of
`sys.stdlib_module_names` for 3.10–3.14, generated by
`scripts/py-oracle/gen-stdlib-modules.py` with the version list in the file
header), `core-members.ts` (dict / list / str / set / bytes / file methods — the
Python `dsl/core-members.ts`).

**INTERFACE.** Implements `ExternalVocabulary`
(`contracts/types/language.ts:135`):

- `isBareCallExternal(member)` — `member ∈ builtins`.
- `isQualifiedReceiverExternal(receiver, ctx, atLine, member)` — the receiver's
  root segment is bound by a non-relative import whose top-level module is in
  the stdlib snapshot, OR whose `mapPythonImportToFile` target is not a project
  file (`ctx.symbolTable.hasFile(relPath) === false`). A receiver with a
  local-binding type at `atLine` is never external here.
- `isCoreAmbiguousMember(member)` — `member ∈ core-members`.
- `isReceiverTyped(receiver, ctx, atLine)` — `resolveLocalBindingType` non-null,
  or `self` / `cls`, or a `classFieldTypes` hit.

`PythonCallResolver` wires
`new ExternalCallClassifier(new PythonExternalVocabulary())` and delegates
`targetsExternalImport` (relocation of the inline body — its existing test
`python-resolver-external-import.test.ts` stays green untouched) and the net-new
`targetsCoreAmbiguousMember`.

**Contract change — `GlobalSymbolTable.hasFile(relPath): boolean`.** Additive.
`contracts/types/codegraph-symbols.ts` exposes
`upsertFile / removeFile / lookup / lookupByShortName / size / hydrate / shortNameDefCounts`
and nothing that answers "does this file have symbols". Both implementations
(`InMemoryGlobalSymbolTable` and the DuckDB-backed table) gain it; TDD per
implementation. This is the query bd `q9u85` identified as the missing piece for
the `importMatch` park gate — E0 adds the query, `q9u85` becomes a measured
follow-up rather than blocked.

### D. Corpora manifest + provisioning

`scripts/lib/codegraph-corpora.json` (the bench directory is not a git
repository, so the manifest is versioned here):

```json
{
  "ugnest": {
    "path": "~/Dev/Collaborate/ugnest",
    "language": "python",
    "requiresPython": ">=3.13",
    "venv": ".venv",
    "roots": ["."],
    "stack": ["django", "djangorestframework"]
  },
  "flask": {
    "path": "~/Dev/OpenSource/codegraph-test/flask",
    "requiresPython": ">=3.10",
    "roots": ["src"]
  },
  "netbox": {
    "path": "~/Dev/Tools/tea-rags-bench/corpora/netbox",
    "sha": "1fae2d01",
    "requiresPython": ">=3.12",
    "roots": ["netbox"]
  },
  "polar": {
    "path": "~/Dev/Tools/tea-rags-bench/corpora/polar",
    "sha": "bddb7508",
    "requiresPython": ">=3.14",
    "roots": ["server"],
    "notes": "36 files PEP 758"
  },
  "httpx": {
    "path": "~/Dev/Tools/tea-rags-bench/corpora/httpx",
    "sha": "b5addb64",
    "requiresPython": ">=3.9",
    "roots": ["httpx"]
  }
}
```

`scripts/py-oracle/provision.sh <corpus>` creates the venv with
`uv venv --python <requiresPython>` and installs dependencies (ugnest: existing
venv; netbox: `requirements.txt`; polar: `uv sync` in `server/`; flask / httpx:
`pip install -e .`). Network + disk → **user-gated**, run once per corpus.

### E. Baseline report

One oracle run per corpus →
`~/Dev/Tools/tea-rags-bench/results/python/<date>-<corpus>.json` (regenerable,
not versioned) + summary tables appended to this spec: `receiverKind × verdict`,
`answeredBy × verdict`, category ranking, ground-truth coverage, and the
precision floor (`phantom` + `skippedInProject` per corpus) that E1 / E2 gates
compare against. Determinism check: two runs, byte-identical JSON.

### F. Live reconciliation on ugnest — user-gated

Registry flip `codegraphEnabled: true` for `ugnest`, then
`DEBUG=1 tea-rags index-codebase --project ugnest --wait-enrichments --json` and
`DEBUG=1 tea-rags prime ~/Dev/Collaborate/ugnest`. `resolveSuccessRate` per
receiverKind must agree with the oracle's chain-output rows within ±2 pp; a
larger gap is a corpus-parity bug in A, not a resolver fact.

## Task order

1. **D** manifest + `provision.sh`; user runs provisioning (network).
2. **B** `jedi_oracle.py` — TDD on the fixture corpus; the TS-side test spawns
   it and is `describe.skipIf` when `uv` is absent (CI is node-only).
3. **A** host harness — pure core unit-tested; smoke on httpx (23 files).
4. **E** baseline ×5; category ranking; the program spec's pull order is
   confirmed or reordered from the data.
5. **C** `hasFile` + `PythonExternalVocabulary` + wiring — TDD; oracle gate
   (`agreeExternal` up, `phantom` and `skippedInProject` flat); re-baseline.
6. **F** live reconciliation (user-gated).

Steps 1–3 are independent of 5; 4 depends on 1–3; 6 depends on 5.

## Testing

- `tests/scripts/py-codegraph-jedi-oracle.test.ts` — pure core (diff, verdict,
  tally, seeded sampling, origin classification, category tagging) with
  in-memory inputs; plus one spawn test against `tests/fixtures/py-oracle/`
  gated on `uv` availability.
- `tests/core/domains/language/python/resolver/python-external-vocabulary.test.ts`
  — every predicate with positive and negative cases; the existing
  `python-resolver-external-import.test.ts` is the relocation regression net.
- `tests/core/domains/trajectory/codegraph/symbols/*symbol-table*.test.ts` —
  `hasFile` on both implementations.
- Fixture corpus assertions name the exact `targetSymbolId` (`ruby/CLAUDE.md`
  invariant: an "an edge exists" test goes green while the graph is wrong).

## Exit criteria

- Oracle deterministic; `chainDrift` 0 on every corpus.
- Per-corpus ground-truth coverage and `parseFailed` reported.
- ugnest live vs oracle within ±2 pp per receiverKind.
- Precision floors recorded; pull order confirmed in the program spec.
- Beads: E0 epic closed with the baseline tables as evidence; `q9u85` re-pointed
  at `hasFile`.

## Risks

- jedi on untyped Django (netbox 3.4% annotated) yields sparse ground truth →
  wide ceiling estimate. Reported as `unknown` share, not hidden.
- parso may not carry a 3.14 grammar → polar's 36 PEP 758 files bucket as
  `parseFailed`; the rest of polar still scores.
- `.objects` on Django models: jedi's descriptor inference is inconsistent
  without `django-stubs`. The `managerQuerySet` category isolates this so a jedi
  blind spot is not read as a resolver miss.
- Runtime on polar (82k sites) — mitigated by per-file `Script` reuse and a
  process pool; `--limit` for smoke.

## Non-goals

- Any Python type-source or strategy beyond `ExternalVocabulary` (E2).
- Changing `CallRef` (no column field) or `SymbolResolutionStrategy`.
- Ruby changes of any kind.
- Indexing netbox / polar / httpx live (offline only in E0).

## Affected files

**New:** `scripts/py-codegraph-jedi-oracle.ts`,
`scripts/lib/codegraph-corpora.json`,
`scripts/py-oracle/{jedi_oracle.py,provision.sh,gen-stdlib-modules.py,pyproject.toml}`,
`src/core/domains/language/python/resolver/python-external-vocabulary.ts`,
`src/core/domains/language/python/vocabulary/{builtins,stdlib-modules,core-members}.ts`,
`tests/scripts/py-codegraph-jedi-oracle.test.ts`, `tests/fixtures/py-oracle/**`,
`tests/core/domains/language/python/resolver/python-external-vocabulary.test.ts`.

**Modified:** `src/core/contracts/types/codegraph-symbols.ts` (+`hasFile`), both
`GlobalSymbolTable` implementations, `python/resolver/python-resolver.ts`
(classifier wiring), possibly `scripts/ts-codegraph-typechecker-oracle.ts`
(pure-core relocation only).

## Appendix — seam inventory (from the 2026-09-02 subagent survey)

S = shared engine exists; R = Ruby-private.

| Seam                                 | Ruby                                                               | Engine                    | Python today                                               |
| ------------------------------------ | ------------------------------------------------------------------ | ------------------------- | ---------------------------------------------------------- |
| extraction pass orchestration        | `walker/walker.ts:88`                                              | R                         | one 570-LOC file, no passes                                |
| call collection                      | `walker/call-collection.ts`                                        | R                         | `collectPythonCalls` + decorator calls                     |
| bare-call detection                  | `walker/bare-call-detection.ts`                                    | R                         | n/a (explicit `self.`)                                     |
| position-aware local bindings        | `walker/local-bindings.ts`                                         | S lookup / R production   | partial: type + line, no `valueKind` / `typeRef`           |
| class hierarchy channels             | `walker/class-hierarchy.ts`                                        | R                         | `classExtends` + `inheritanceEdges` only                   |
| MRO / C3                             | `resolver/ancestor-linearization.ts`                               | R                         | single-parent walk                                         |
| constant refs / imports / file scope | `walker/constant-refs.ts`                                          | R                         | `collectPythonImports`; `fileScope: []`                    |
| macro expansion + structured macros  | `walker/macro-expansion.ts`, `walker/structured/`                  | R                         | none (↔ decorators)                                        |
| association types                    | `walker/association-types.ts`                                      | R                         | none (↔ ORM fields)                                        |
| method signatures + call-site shape  | `walker/method-signatures.ts`                                      | R (neutral channel)       | none                                                       |
| param↔arg half-facts                 | `walker/param-arg-types.ts`                                        | R                         | none                                                       |
| registry / table dispatch            | `walker/registry-dispatch.ts`, `strategies/ruby-table-dispatch.ts` | R (+ TS inline twin)      | none                                                       |
| type-fact store, ranked sources      | `walker/type-fact-store.ts`, `walker/type-sources/*`               | R                         | none                                                       |
| DSL catalogue + Gemfile gating       | `dsl/*`, `gemfile.ts`                                              | R (contract slot neutral) | slot unused                                                |
| Zeitwerk                             | `resolver/zeitwerk.ts`                                             | R                         | n/a; `mapPythonImportToFile` unwired to `resolveFileEdges` |
| receiver type propagation            | `resolver/type-propagation.ts`                                     | R                         | none                                                       |
| return facts / member returns        | `resolver/ruby-*-return-*.ts`                                      | R                         | none                                                       |
| convention receiver                  | `resolver/ruby-unbound-receiver-types.ts`                          | R                         | none                                                       |
| self-dispatch template redirect      | `resolver/template-redirect.ts`                                    | R / S discovery           | slot unused                                                |
| external vocabulary                  | `resolver/ruby-external-vocabulary.ts`                             | S engine                  | **E0**                                                     |
| schema column accessors              | `schema/`                                                          | S plumbing / R parser     | n/a                                                        |
| codegraph exclusions                 | `codegraph-exclusions.ts`                                          | S engine                  | slot unused                                                |
| dispatch narrowing (6 narrowers)     | `kernel/dispatch-narrowing.ts`                                     | S                         | unused (needs signatures)                                  |
| chain composition                    | `resolver-chain.ts`                                                | S                         | ✓                                                          |
| cone dispatch                        | `cone-dispatch.ts`                                                 | S                         | ✓ (bare, not composed)                                     |
| calls → innermost chunk              | `kernel/assign-calls-to-chunks.ts`                                 | S                         | duplicated inline                                          |
