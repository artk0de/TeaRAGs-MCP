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

## Appendix — E0 baseline (2026-09-08)

Oracle: `scripts/py-codegraph-jedi-oracle.ts`, seed 20260908, jedi 0.20.0.
`chainDrift` 0 on every corpus. Rates exclude `oracleDegraded` and `parseFailed`
rows; both are reported separately, because a stale parso grammar is a gap in
the instrument and not a defect in the resolver.

Wall time, one run each, nothing else heavy on the machine: httpx 3.0 s, flask
2.8 s, ugnest 9.0 s, netbox 154.9 s, polar 283.7 s.

**Determinism scope.** httpx, flask and ugnest were each run twice and the two
JSON files compared byte for byte; all three are identical. netbox and polar
were run once each — at 155 s and 284 s a second pass buys less than the flask
evidence below already establishes. The gate found a real defect first: three
flask runs disagreed on one site, which moved between `agreeExternal` and
`bothUnresolved`. The cause was the file → worker assignment, not the reply
order the plan anticipated. `pool.imap(..., chunksize=4)` hands chunks out as
workers free up, and jedi's per-process module cache makes one file's answer
depend on what that process parsed before it. The pool now partitions files by
index into exactly one group per worker and pins one group per process
(`maxtasksperchild=1`), so every process sees the same files in the same order
on every run. Three consecutive flask runs after the fix are byte-identical, and
`tests/scripts/jedi-oracle-spawn.test.ts` pins single-worker/multi-worker
parity. The baseline below is entirely post-fix. Determinism holds at a fixed
`--workers`; the recorded runs all used the default 8.

**Two other harness defects were fixed before the baseline stood.** The
interpreter that runs jedi was derived from the corpus's own `requiresPython`
floor, so httpx (3.9) and flask (3.10) resolved to a Python jedi 0.20.0 refuses
to install on and the run died at the first spawn; the floor is now lifted to
the oracle environment's own `>=3.13` pin, and polar still gets 3.14 because its
floor is higher. And the JSON payload carried no `skippedInProject`,
`parseFailed` or `unlocated` counts — `tallyPyRows` folds the first into
`missed` and drops the second — so three of the five tables below could not be
filled from it. `tallyPyCoverage` now supplies them.

### Ground-truth coverage

| corpus | call sites | with ground truth | coverage | oracleDegraded | parseFailed | unlocated (by shape)     |
| ------ | ---------- | ----------------- | -------- | -------------- | ----------- | ------------------------ |
| httpx  | 2643       | 2394              | 90.6%    | 0              | 0           | 2 (coordinateMiss 2)     |
| flask  | 2172       | 1981              | 91.2%    | 0              | 0           | 41 (coordinateMiss 41)   |
| ugnest | 7158       | 6736              | 94.1%    | 0              | 0           | 0                        |
| netbox | 60731      | 47700             | 78.5%    | 2331           | 0           | 32 (coordinateMiss 32)   |
| polar  | 82554      | 54111             | 65.5%    | 20424          | 0           | 125 (coordinateMiss 125) |

### receiverKind × verdict

#### httpx

`skippedInProject` 0 (folded into `missed`)

|            | sites | oracle | match | fileOnly | wrongFile | missed | mismatch% | ext | phantom | phantom% |
| ---------- | ----- | ------ | ----- | -------- | --------- | ------ | --------- | --- | ------- | -------- |
| bareCall   | 1195  | 455    | 424   | 8        | 0         | 23     | 5.1%      | 738 | 8       | 1.1%     |
| dynamic    | 518   | 47     | 12    | 0        | 0         | 35     | 74.5%     | 386 | 185     | 47.9%    |
| chain      | 334   | 53     | 15    | 0        | 2         | 36     | 71.7%     | 199 | 40      | 20.1%    |
| localVar   | 328   | 116    | 82    | 6        | 8         | 20     | 24.1%     | 137 | 38      | 27.7%    |
| selfMember | 240   | 238    | 156   | 0        | 0         | 82     | 34.5%     | 2   | 0       | 0.0%     |
| index      | 22    | 0      | 0     | 0        | 0         | 0      | 0.0%      | 18  | 0       | 0.0%     |
| constant   | 6     | 0      | 0     | 0        | 0         | 0      | 0.0%      | 5   | 0       | 0.0%     |

#### flask

`skippedInProject` 0 (folded into `missed`)

|            | sites | oracle | match | fileOnly | wrongFile | missed | mismatch% | ext | phantom | phantom% |
| ---------- | ----- | ------ | ----- | -------- | --------- | ------ | --------- | --- | ------- | -------- |
| bareCall   | 905   | 254    | 175   | 12       | 2         | 65     | 26.4%     | 604 | 26      | 4.3%     |
| dynamic    | 449   | 56     | 37    | 0        | 3         | 16     | 33.9%     | 352 | 136     | 38.6%    |
| chain      | 315   | 58     | 26    | 0        | 1         | 31     | 55.2%     | 221 | 23      | 10.4%    |
| selfMember | 298   | 272    | 216   | 0        | 0         | 56     | 20.6%     | 22  | 0       | 0.0%     |
| localVar   | 164   | 48     | 28    | 2        | 10        | 8      | 37.5%     | 74  | 18      | 24.3%    |
| index      | 35    | 2      | 0     | 0        | 0         | 2      | 100.0%    | 12  | 2       | 16.7%    |
| constant   | 6     | 2      | 2     | 0        | 0         | 0      | 0.0%      | 4   | 2       | 50.0%    |

#### ugnest

`skippedInProject` 0 (folded into `missed`)

|            | sites | oracle | match | fileOnly | wrongFile | missed | mismatch% | ext  | phantom | phantom% |
| ---------- | ----- | ------ | ----- | -------- | --------- | ------ | --------- | ---- | ------- | -------- |
| bareCall   | 2546  | 672    | 626   | 0        | 0         | 46     | 6.8%      | 1874 | 0       | 0.0%     |
| dynamic    | 1763  | 21     | 8     | 0        | 0         | 13     | 61.9%     | 1626 | 196     | 12.1%    |
| chain      | 1490  | 14     | 4     | 0        | 0         | 10     | 71.4%     | 1266 | 244     | 19.3%    |
| constant   | 598   | 573    | 196   | 0        | 0         | 377    | 65.8%     | 23   | 3       | 13.0%    |
| localVar   | 534   | 39     | 13    | 0        | 22        | 4      | 66.7%     | 424  | 212     | 50.0%    |
| selfMember | 192   | 156    | 152   | 0        | 0         | 4      | 2.6%      | 30   | 0       | 0.0%     |
| index      | 35    | 0      | 0     | 0        | 0         | 0      | 0.0%      | 18   | 0       | 0.0%     |

#### netbox

`skippedInProject` 23 (folded into `missed`)

|            | sites | oracle | match | fileOnly | wrongFile | missed | mismatch% | ext   | phantom | phantom% |
| ---------- | ----- | ------ | ----- | -------- | --------- | ------ | --------- | ----- | ------- | -------- |
| bareCall   | 24872 | 5270   | 4973  | 4        | 31        | 262    | 5.6%      | 17977 | 245     | 1.4%     |
| dynamic    | 19490 | 1712   | 1118  | 0        | 218       | 376    | 34.7%     | 14048 | 7154    | 50.9%    |
| chain      | 10361 | 372    | 142   | 0        | 1         | 229    | 61.8%     | 3539  | 247     | 7.0%     |
| selfMember | 3318  | 1752   | 1088  | 0        | 1         | 663    | 37.9%     | 295   | 33      | 11.2%    |
| localVar   | 2111  | 193    | 41    | 129      | 9         | 14     | 11.9%     | 907   | 278     | 30.7%    |
| index      | 405   | 1      | 1     | 0        | 0         | 0      | 0.0%      | 38    | 4       | 10.5%    |
| constant   | 174   | 33     | 11    | 0        | 0         | 22     | 66.7%     | 119   | 7       | 5.9%     |

#### polar

`skippedInProject` 6 (folded into `missed`)

|            | sites | oracle | match | fileOnly | wrongFile | missed | mismatch% | ext   | phantom | phantom% |
| ---------- | ----- | ------ | ----- | -------- | --------- | ------ | --------- | ----- | ------- | -------- |
| bareCall   | 32942 | 4865   | 3825  | 25       | 27        | 988    | 20.9%     | 16983 | 213     | 1.3%     |
| dynamic    | 23298 | 964    | 447   | 0        | 26        | 491    | 53.6%     | 9724  | 3025    | 31.1%    |
| chain      | 11115 | 15     | 6     | 0        | 0         | 9      | 60.0%     | 4852  | 138     | 2.8%     |
| localVar   | 7660  | 132    | 74    | 22       | 25        | 11     | 27.3%     | 1458  | 353     | 24.2%    |
| selfMember | 4478  | 2163   | 1640  | 0        | 0         | 523    | 24.2%     | 158   | 4       | 2.5%     |
| constant   | 2648  | 71     | 17    | 0        | 0         | 54     | 76.1%     | 267   | 27      | 10.1%    |
| index      | 413   | 39     | 0     | 0        | 0         | 39     | 100.0%    | 107   | 8       | 7.5%     |

### answeredBy × verdict

#### httpx — by pass

|                 | sites | oracle | match | fileOnly | wrongFile | missed | mismatch% | ext  | phantom | phantom% |
| --------------- | ----- | ------ | ----- | -------- | --------- | ------ | --------- | ---- | ------- | -------- |
| none            | 1632  | 196    | 0     | 0        | 0         | 196    | 100.0%    | 1214 | 0       | 0.0%     |
| globalShortName | 570   | 492    | 484   | 8        | 0         | 0      | 0.0%      | 73   | 73      | 100.0%   |
| localBinding    | 139   | 96     | 82    | 6        | 8         | 0      | 8.3%      | 38   | 38      | 100.0%   |
| importMatch     | 136   | 0      | 0     | 0        | 0         | 0      | 0.0%      | 124  | 124     | 100.0%   |
| selfMember      | 110   | 110    | 110   | 0        | 0         | 0      | 0.0%      | 0    | 0       | 0.0%     |
| selfField       | 48    | 7      | 5     | 0        | 2         | 0      | 28.6%     | 36   | 36      | 100.0%   |
| super           | 8     | 8      | 8     | 0        | 0         | 0      | 0.0%      | 0    | 0       | 0.0%     |

#### flask — by pass

|                 | sites | oracle | match | fileOnly | wrongFile | missed | mismatch% | ext  | phantom | phantom% |
| --------------- | ----- | ------ | ----- | -------- | --------- | ------ | --------- | ---- | ------- | -------- |
| none            | 1402  | 178    | 0     | 0        | 0         | 178    | 100.0%    | 1082 | 0       | 0.0%     |
| globalShortName | 476   | 357    | 343   | 12       | 2         | 0      | 0.6%      | 98   | 98      | 100.0%   |
| selfMember      | 109   | 109    | 109   | 0        | 0         | 0      | 0.0%      | 0    | 0       | 0.0%     |
| importMatch     | 97    | 2      | 0     | 0        | 2         | 0      | 100.0%    | 88   | 88      | 100.0%   |
| localBinding    | 80    | 41     | 29    | 2        | 10        | 0      | 24.4%     | 18   | 18      | 100.0%   |
| selfField       | 4     | 1      | 0     | 0        | 1         | 0      | 100.0%    | 3    | 3       | 100.0%   |
| super           | 4     | 4      | 3     | 0        | 1         | 0      | 25.0%     | 0    | 0       | 0.0%     |

#### ugnest — by pass

|                 | sites | oracle | match | fileOnly | wrongFile | missed | mismatch% | ext  | phantom | phantom% |
| --------------- | ----- | ------ | ----- | -------- | --------- | ------ | --------- | ---- | ------- | -------- |
| none            | 5270  | 454    | 0     | 0        | 0         | 454    | 100.0%    | 4606 | 0       | 0.0%     |
| globalShortName | 1334  | 907    | 907   | 0        | 0         | 0      | 0.0%      | 274  | 274     | 100.0%   |
| localBinding    | 302   | 34     | 12    | 0        | 22        | 0      | 64.7%     | 212  | 212     | 100.0%   |
| importMatch     | 172   | 2      | 2     | 0        | 0         | 0      | 0.0%      | 167  | 167     | 100.0%   |
| selfMember      | 78    | 78     | 78    | 0        | 0         | 0      | 0.0%      | 0    | 0       | 0.0%     |
| selfField       | 2     | 0      | 0     | 0        | 0         | 0      | 0.0%      | 2    | 2       | 100.0%   |

#### netbox — by pass

|                 | sites | oracle | match | fileOnly | wrongFile | missed | mismatch% | ext   | phantom | phantom% |
| --------------- | ----- | ------ | ----- | -------- | --------- | ------ | --------- | ----- | ------- | -------- |
| none            | 41554 | 1566   | 0     | 0        | 0         | 1566   | 100.0%    | 28955 | 0       | 0.0%     |
| globalShortName | 9875  | 6645   | 6608  | 4        | 33        | 0      | 0.5%      | 811   | 811     | 100.0%   |
| importMatch     | 7553  | 217    | 0     | 0        | 217       | 0      | 100.0%    | 6877  | 6877    | 100.0%   |
| selfMember      | 888   | 589    | 589   | 0        | 0         | 0      | 0.0%      | 2     | 2       | 100.0%   |
| localBinding    | 706   | 179    | 41    | 129      | 9         | 0      | 5.0%      | 274   | 274     | 100.0%   |
| super           | 152   | 137    | 136   | 0        | 1         | 0      | 0.7%      | 3     | 3       | 100.0%   |
| selfField       | 3     | 0      | 0     | 0        | 0         | 0      | 0.0%      | 1     | 1       | 100.0%   |

#### polar — by pass

|                 | sites | oracle | match | fileOnly | wrongFile | missed | mismatch% | ext   | phantom | phantom% |
| --------------- | ----- | ------ | ----- | -------- | --------- | ------ | --------- | ----- | ------- | -------- |
| none            | 61930 | 2115   | 0     | 0        | 0         | 2115   | 100.0%    | 29781 | 0       | 0.0%     |
| globalShortName | 14304 | 5105   | 5053  | 25       | 27        | 0      | 0.5%      | 742   | 742     | 100.0%   |
| importMatch     | 3329  | 32     | 6     | 0        | 26        | 0      | 81.3%     | 2636  | 2636    | 100.0%   |
| selfMember      | 1497  | 856    | 856   | 0        | 0         | 0      | 0.0%      | 1     | 1       | 100.0%   |
| localBinding    | 1358  | 121    | 74    | 22       | 25        | 0      | 20.7%     | 352   | 352     | 100.0%   |
| super           | 72    | 17     | 17    | 0        | 0         | 0      | 0.0%      | 8     | 8       | 100.0%   |
| selfField       | 64    | 3      | 3     | 0        | 0         | 0      | 0.0%      | 29    | 29      | 100.0%   |

### Missed-shape category ranking

| rank | category            | oracle answers | mismatch% | missed | wrongFile | corpora it dominates   |
| ---- | ------------------- | -------------- | --------- | ------ | --------- | ---------------------- |
| 1    | `annotationReturn`  | 11068          | 26.7%     | 2829   | 126       | polar 2186, ugnest 329 |
| 2    | `plain`             | 8374           | 15.4%     | 1031   | 257       | netbox 1263, flask 20  |
| 3    | `decoratorProperty` | 1314           | 55.0%     | 717    | 6         | ugnest 379, netbox 231 |
| 4    | `superMro`          | 503            | 69.6%     | 349    | 1         | netbox 271, polar 79   |
| 5    | `annotationParam`   | 464            | 32.1%     | 141    | 8         | httpx 89, flask 43     |
| 6    | `reexport`          | 253            | 22.1%     | 56     | 0         | netbox 32, polar 24    |
| 7    | `unionReceiver`     | 24             | 33.3%     | 8      | 0         | httpx 8                |

### Precision floor

| corpus | external proven | phantom | phantom% | skippedInProject |
| ------ | --------------- | ------- | -------- | ---------------- |
| httpx  | 1485            | 271     | 18.2%    | 0                |
| flask  | 1289            | 207     | 16.1%    | 0                |
| ugnest | 5261            | 655     | 12.5%    | 0                |
| netbox | 36923           | 7968    | 21.6%    | 23               |
| polar  | 33549           | 3768    | 11.2%    | 6                |

### Chain-output reconciliation against `codegraph-chain-tally.ts`

The plan asks whether the oracle scores the same population production resolves.
On httpx and flask it does, exactly. On the other three it does not, and the
difference is in the baseline instrument rather than in the oracle.

| corpus | chain-tally 2026-09-02 (sites · edges / file-only / unresolved) | oracle 2026-09-08            | gap                     |
| ------ | --------------------------------------------------------------- | ---------------------------- | ----------------------- |
| httpx  | 2643 · 1011 / 193 / 1632                                        | 2643 · 1011 / 193 / 1632     | none                    |
| flask  | 2172 · 770 / 148 / 1402                                         | 2172 · 770 / 148 / 1402      | none                    |
| ugnest | 7331 · 1432 / 315 / 5899                                        | 7158 · 1888 / 460 / 5270     | file population + table |
| netbox | 60731 · 21971 / 8190 / 38760                                    | 60731 · 19177 / 8185 / 41554 | symbol table            |
| polar  | 82554 · 21336 / 3976 / 61218                                    | 82554 · 20624 / 4138 / 61930 | symbol table            |

`codegraph-chain-tally.ts` was re-run on 2026-09-02's corpora at this HEAD and
reproduces its recorded numbers exactly (ugnest 1432 / 315 / 5899, netbox 21971
/ 8190 / 38760), so production has not moved. The two harnesses select
differently:

- chain-tally walks only the scored language's extension behind a hand-rolled
  skip list and a test-path regex. It reads no ignore file.
- the oracle applies production's own two exclusion layers and builds ONE symbol
  table over every `CODEGRAPH_LANGUAGES` extension, which is what the codegraph
  provider does.

**ugnest** — chain-tally scores 20 files production never indexes: 19 under
`domains/media`, dropped by the unanchored `media/` entry in the repo's
`.dockerignore` and `.contextignore`, plus a root `conftest.py` the codegraph
test exclusion drops. Holding the scored set at production's 258 files and
adding only those 20 to the SYMBOL TABLE drops the edge count from 1888 to 1415:
224 sites stop resolving, 177 of them on the member `get`. The direction is the
point — extra definitions push a short name past the chain's cone limit and the
pass declines.

**netbox and polar** — the `.py` file sets agree exactly (identical site
counts), and the whole difference is the non-Python half of the symbol table
that production has and chain-tally does not: netbox +56 files / +199 symbols,
polar +1,756 files. Same mechanism, same direction: netbox −2,794 edges, polar
−712.

So the recorded chain-tally numbers overstate production's Python edge count on
netbox and polar and understate it on ugnest. The oracle's are the
production-faithful ones and are what E1 and E2 should be compared against. The
chain-tally baselines stay usable as a drift invariant — they are stable and
reproduce — but they are not a statement about what the pipeline builds.

### Pull order (confirmed 2026-09-08 by the E0 baseline)

The original prediction, kept verbatim because a prediction that was wrong is
evidence about the model:

> 1. `ExternalVocabulary` — denominator (E0)
> 2. `ModuleResolver` + re-exports + star-import + namespace packages
> 3. `TypeSource: annotations` → local / param / return types
> 4. `AncestorLinearizer` C3 + `super`
> 5. `FrameworkModule`: Django Manager / QuerySet + DRF, SQLAlchemy `Mapped[]` /
>    FastAPI `Depends`
> 6. `ReceiverTypePropagation` multi-hop + return-type binding
> 7. Dispatch: union → dynamic / duck → table

The data confirms the head and the tail and reorders the middle.

**The head is confirmed, and by a wider margin than predicted.** Phantoms
outnumber misses on every one of the five corpora — 12,869 against 4,509 in
total, and 5.1:1 on netbox. Python's problem is precision first, recall second,
which is not what a resolve-rate number alone would suggest. Within that,
`importMatch` produces 9,892 of the 12,869 phantoms (77%): netbox 6,877, polar
2,636, ugnest 167, httpx 124, flask 88. Its phantom rate is 91% of everything it
resolves on netbox. `globalShortName` is a distant second at 1,998.

**#1 and #2 collapse into one population.**
`PythonImportMatchSymbolResolutionStrategy` matches an imported short name
against in-project files, so a third-party import becomes an in-project edge.
`ExternalVocabulary` and an honest import → file mapper are two halves of the
same fix, and both are read off the same 9,892 rows. Re-exports as a RECALL
lever are small — `reexport` ranks 6th with 56 losses — so the case for
`ModuleResolver` rests on precision, not on recall.

**#3 holds.** `annotationReturn` carries the largest recall loss (2,955 of the
4,509), 2,186 of it from polar alone, at 26.7% mismatch. Read the width
honestly: the category flags any site whose enclosing function has a return
annotation, and on polar that is 80,619 of 82,554 sites, so it describes the
corpus as much as the lever. `annotationParam` is the narrow half and ranks 5th
with 149 losses, carried by httpx (89) and flask (43).

**#4 and #5 swap, and a new entry lands between them.** `decoratorProperty` —
`@property` / `@cached_property` receivers — is 723 losses at 55% mismatch and
is the only shape-specific category that all three framework corpora carry
(ugnest 379, netbox 231, polar 111). C3 + `super` has the worst RATE of any
ranked category (69.6%) but only 350 losses, almost all netbox (271). Decorator
handling therefore moves ahead of the ancestor linearizer.

**Framework vocabularies cannot be ranked from E0 at all, and that is a
finding.** `managerQuerySet` returns 0 oracle answers on every corpus (netbox
3,447 sites, ugnest 693) and `dependsInjection` 0 on polar's 629 sites. jedi
resolves neither Django's `Manager`/`QuerySet` descriptor protocol nor FastAPI's
`Depends` indirection, so there is no ground truth to score against. Their 4,769
call sites are a lower bound on the lever's size, not a measurement of it, and
E3 will need an oracle these are visible to.

**The tail is confirmed.** `unionReceiver` produces 24 oracle answers across all
five corpora — polar's 605 union sites yield 6 — which is barely above the
20-answer ranking floor. Dispatch stays last.

The order the data supports:

1. `ExternalVocabulary` — 12,869 phantoms, the single largest defect (netbox,
   polar carry it)
2. `ModuleResolver` + re-exports — the same `importMatch` population, 9,892 of
   those phantoms (netbox 6,877)
3. `TypeSource: annotations` — 2,955 recall losses, largest recall lever (polar)
4. decorator / property receivers — 723 losses at 55% (ugnest, netbox, polar) —
   MOVED UP from inside #3/#5
5. `AncestorLinearizer` C3 + `super` — 350 losses at 69.6%, the worst rate
   (netbox) — MOVED DOWN one place
6. `FrameworkModule` — unrankable here; 4,769 call sites with zero oracle
   coverage (netbox, ugnest, polar)
7. `ReceiverTypePropagation` — no category of its own; it is inside the residual
8. Dispatch / unions — 24 oracle answers, last, as predicted

`plain` ranks 2nd by absolute loss (1,288, netbox-carried) and is deliberately
left out of the order: it is the residual bucket for sites carrying no other
shape, so it names no lever.

## Final measurement record (2026-09-09, integration HEAD 30a1d1891)

Seeded, per-file-rooted jedi oracle (E0.9/E0.11/E0.12/E0.13), calls attributed to their innermost chunk (PW.1). JSON
denominators exclude oracle-degraded rows (netbox 2,331; polar 20,424). Chain drift 0 and zero file-only call edges on
every corpus.

| corpus | match | missed | wrongFile | phantom | edges | fabricated+wrongFile / edges | in-project recall |
| ------ | ----- | ------ | --------- | ------- | ----- | ---------------------------- | ----------------- |
| ugnest | 741 | 48 | 0 | 0 | 742 | 0.0% | 0.94 |
| netbox | 7,428 | 463 | 1 | 26 | 8,109 | 0.3% | 0.94 |
| polar | 9,638 | 2,514 | 5 | 115 | 13,886 | 0.9% | 0.79 |
| httpx | 421 | 63 | 0 | 8 | 433 | 1.8% | 0.87 |
| flask | 302 | 60 | 1 | 9 | 330 | 3.0% | 0.83 |

Per receiverKind (n >= 100): bareCall 0.95-0.99, constant 0.99, selfMember 1.0, super 0.96-1.0, dynamic 0.96 (netbox) /
0.78 (polar); chain 0.004-0.008 and localVar 0.21-0.40 remain the static frontier (types of intermediate calls and of
unannotated return values). Results: `~/Dev/Tools/tea-rags-bench/results/python/2026-09-09-final-<corpus>.json`.
