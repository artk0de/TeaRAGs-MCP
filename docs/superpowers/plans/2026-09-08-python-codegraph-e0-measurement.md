# Python Codegraph E0 Measurement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Python resolver the measurement footing TypeScript got from
`scripts/ts-codegraph-typechecker-oracle.ts`: for every Python call site, the
production chain's answer diffed against independent ground truth from jedi,
bucketed by `receiverKind`, by the strategy that answered, and by missed-shape
category, over five corpora, byte-identical across runs. Plus the one production
change the measurement cannot do without — an honest denominator, via a Python
`ExternalVocabulary` and the two `GlobalSymbolTable` queries it needs.
Everything downstream (E1–E4) is gated on this instrument.

**Architecture:** Two processes and one pure core. The TS host
(`scripts/py-codegraph-jedi-oracle.ts`) walks the corpus exactly as production
selects files, runs the production Python chain as a black box, and streams the
scored call sites as NDJSON to a spawned Python child
(`scripts/py-oracle/jedi_oracle.py`) that answers with jedi's ground truth; the
host diffs and tallies. The diff / tally / walk functions the TS oracle already
exports — `diffResolution`, `tallyBy`, `collectSourceFiles`,
`buildCorpusExclusionFilter`, `extractFile`, `buildSymbolDefs`,
`formatOracleTable`, `isScoredSource` — are **imported, not copied and not
relocated**: that module's `main` is guarded by
`import.meta.url === file://argv[1]`, so importing it runs nothing. Python-only
buckets (extended verdicts, target origins, missed-shape categories, degraded
rows, seeded sampling) live in a new pure module `scripts/lib/py-oracle-core.ts`
with its own unit tests. `scripts/ts-codegraph-typechecker-oracle.ts` is NOT
modified by this plan.

**Tech Stack:** TypeScript (NodeNext, `strict`), vitest, tsx, tree-sitter,
`node:child_process` for the oracle subprocess; Python 3.13 / 3.14 driven by
`uv run --no-project --with jedi==0.20.0`, jedi 0.20.0 + parso 0.8.7 on the
Python side, `ast` / `multiprocessing` from the stdlib. Production changes are
confined to `src/core/contracts/types/codegraph-symbols.ts`, the two
`GlobalSymbolTable` implementations, and
`src/core/domains/language/python/{resolver,vocabulary}/`.

**Spec:**
docs/superpowers/specs/2026-09-03-python-codegraph-e0-measurement-design.md
(parent:
docs/superpowers/specs/2026-09-03-python-codegraph-unification-program-design.md)

## Global Constraints

- **Perf gate on every task touching production or the harness.** Per corpus,
  sequentially, nothing else heavy running:
  `/usr/bin/time -l npx tsx scripts/codegraph-chain-tally.ts --corpus <root> --lang python --quiet`.
  Peak RSS ≤ +20% of baseline (httpx 260 MB, flask 275 MB, ugnest 352 MB, polar
  959 MB, netbox 1,293 MB); wall ≤ +25% of baseline (httpx 1.7 s, flask 1.1 s,
  ugnest 2.4 s, polar 14.5 s, netbox 16.2 s under load). `hasFile` /
  `hasFilesUnder` are map lookups and the stdlib snapshot is a module-level
  frozen `Set` — **no filesystem probe may enter production.**
- **Chain-tally baseline is the invariant** (2026-09-02, chain drift 0,
  `edges / fileOnly / unresolved`): ugnest 1432 / 315 / 5899, flask 770 / 148 /
  1402, netbox 21971 / 8190 / 38760, polar 21336 / 3976 / 61218, httpx 1011 /
  193 / 1632. Tasks 1–4 leave every number byte-identical; Task 5b is the only
  task allowed to move them, and only in the direction its gate names.
- **Python 3 only.** No Python 2 syntax, no `2to3` fallback, no `__future__`
  shims. tree-sitter-python is a Python 3 grammar and the corpora are 3.9+.
- **jedi is measurement-only.** Nothing under `src/` may import jedi, spawn the
  oracle, or depend on a venv. `m99j1`'s LSP-free rule holds.
- **Verdict vocabulary is fixed.** `match` / `fileOnly` / `wrongFile` / `missed`
  / `phantom` / `agreeExternal` / `chainOnly` / `bothUnresolved` from the TS
  oracle, plus `skippedInProject` (the classifier called the site external,
  ground truth is in-project) and `parseFailed` (the oracle interpreter's
  `ast.parse` raised on the whole file). `oracleDegraded: true` is a per-row
  FLAG, not a verdict: rows in a file whose parso grammar produced errors are
  tallied in their own row and excluded from the headline `mismatchRate` /
  `phantomRate`, while still counting toward ground-truth coverage.
- **Determinism is a gate.** Two runs of one corpus at one seed produce
  byte-identical JSON. Sampling is seeded mulberry32 over the row index, never
  first-N; every map iterated for output is sorted before it is written.
- **Corpus venvs are already provisioned.** Task 1 RECORDS them. No task in this
  plan creates a venv, installs a package, or touches the network.
- **Commit format.** One commit per task, `type(scope): subject (mmckn)`, header
  ≤ 100 chars, body lines ≤ 100 chars. Scopes: `scripts` for harness, manifest,
  fixtures and the Python side; `contracts` for `hasFile` / `hasFilesUnder`;
  `language` for the vocabulary and resolver wiring. No `BREAKING CHANGE` footer
  is warranted anywhere in this plan.
- **Worktree per task.** Each task runs in a fresh Opus subagent's own git
  worktree. A fresh worktree has no `build/` and the chunker pool forks the
  COMPILED worker, so run `npm ci` then a bare `npm run build` once before the
  first test run — **no `npm link`, no reindex**, ever, in this plan.
- **No Ruby changes.**
  `git diff --stat -- src/core/domains/language/ruby tests/core/domains/language/ruby`
  is empty at the end of every task.
- **Pre-commit runs tests + type-check + prettier.** `npm run type-check` covers
  `src/**` only (`tsconfig.json:18`); `tsconfig.eslint.json` additionally covers
  `tests/**` and `scripts/**/*.ts`, so a type error in a harness or a test fake
  surfaces through eslint, not through `tsc`. Run `npx prettier --write` on
  every file you touch (Markdown and JSON included) before committing.
- **No `Why:` line needed.** None of the touched files is on the deep-silo list
  in `.claude/rules/silo-pairing.md`. Do not add one.
- **Tool-call budget.** Keep every command under ~8 minutes of silence. A full
  polar oracle run is 15–40 minutes: smoke it with `--limit` first, then run the
  unbounded pass in the background with output redirected to a file and poll the
  file — never as one blocking foreground call.
- **Naming.** `.claude/rules/naming.md`: no bare `Result` / `Metadata` /
  `Outcome` / `Strategy`. The names below — `PyOracleRow`, `PyOracleVerdict`,
  `PyTargetOrigin`, `PyMissedCategory`, `PyUnlocatedShape`, `AnsweredByProbe`,
  `PythonExternalVocabulary` — are the ones every task uses. Do not invent
  synonyms between tasks.

---

## File Structure

**Created**

| File                                                                             | Single responsibility                                                                                       |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `scripts/lib/codegraph-corpora.json`                                             | The five corpora: path, sha, `requiresPython`, provisioned venv interpreter, import roots, stack, baseline. |
| `scripts/lib/codegraph-corpora.ts`                                               | Typed loader for that manifest: `~` expansion, per-name lookup, no disk probing.                            |
| `tests/scripts/codegraph-corpora.test.ts`                                        | Loader unit tests: every corpus parses, paths absolute, baselines match the recorded numbers.               |
| `scripts/py-oracle/pyproject.toml`                                               | Pins `jedi==0.20.0` and the interpreter floor for `uv run`.                                                 |
| `scripts/py-oracle/jedi_oracle.py`                                               | The Python side: locate each call site in the file AST, ask jedi, classify origin, emit NDJSON.             |
| `tests/fixtures/py-oracle/**`                                                    | Six-file fixture corpus plus the exact expected oracle NDJSON.                                              |
| `tests/scripts/jedi-oracle-spawn.test.ts`                                        | Spawns `jedi_oracle.py` over the fixture corpus, asserts exact rows. `describe.skipIf(!uvAvailable)`.       |
| `scripts/lib/py-oracle-core.ts`                                                  | Pure core: Python verdicts, origins, categories, degraded handling, seeded sampling, tally extensions.      |
| `tests/scripts/py-oracle-core.test.ts`                                           | Unit tests for every pure-core function, in-memory inputs only.                                             |
| `scripts/py-codegraph-jedi-oracle.ts`                                            | The host: corpus-parity walk, chain black box, `answeredBy` probe, NDJSON protocol, tally, report.          |
| `tests/scripts/py-codegraph-jedi-oracle.test.ts`                                 | Host unit tests: CLI parsing, `AnsweredByProbe`, chain-drift detection, record framing.                     |
| `scripts/py-oracle/gen-stdlib-modules.py`                                        | Generates `stdlib-modules.ts` as the union of `sys.stdlib_module_names` over 3.10–3.14.                     |
| `src/core/domains/language/python/vocabulary/builtins.ts`                        | The `builtins` module's callable names.                                                                     |
| `src/core/domains/language/python/vocabulary/stdlib-modules.ts`                  | Generated stdlib top-level module snapshot, a module-level frozen `Set`.                                    |
| `src/core/domains/language/python/vocabulary/core-members.ts`                    | dict / list / str / set / bytes / file member names — the Python core-homonym set.                          |
| `src/core/domains/language/python/resolver/python-external-vocabulary.ts`        | `PythonExternalVocabulary implements ExternalVocabulary`.                                                   |
| `tests/core/domains/language/python/resolver/python-external-vocabulary.test.ts` | Every predicate, positive and negative.                                                                     |
| `scripts/py-oracle/reconcile-live.ts`                                            | Task 6: diff `prime`'s per-`receiverKind` resolve rates against the oracle's chain-output rows.             |

**Modified**

| File                                                                          | Change                                                                                              |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `src/core/contracts/types/codegraph-symbols.ts`                               | `GlobalSymbolTable` gains required `hasFile` and `hasFilesUnder`.                                   |
| `src/core/domains/trajectory/codegraph/symbols/symbol-table.ts`               | `InMemoryGlobalSymbolTable`: `hasFile` off `byFile`, `hasFilesUnder` off a refcounted dir index.    |
| `src/core/adapters/duckdb/daemon/noop-symbol-table.ts`                        | `NoopGlobalSymbolTable`: both return `false`.                                                       |
| `tests/core/domains/trajectory/codegraph/symbols/symbol-table.test.ts`        | New `describe` blocks for both methods.                                                             |
| `tests/core/adapters/duckdb/daemon/noop-symbol-table.test.ts`                 | Both methods answer `false`.                                                                        |
| `tests/core/domains/language/kernel/fanout-policy.test.ts`                    | The `tableWithCounts` fake gains the two methods (2 lines).                                         |
| `tests/core/contracts/types/codegraph.test.ts`                                | The `_table` conformance literal gains the two methods (2 lines).                                   |
| `src/core/domains/language/python/resolver/python-resolver.ts`                | Constructor wires `ExternalCallClassifier(new PythonExternalVocabulary())`; two delegating methods. |
| `src/core/domains/language/CLAUDE.md`                                         | One Mechanics bullet for the Python external vocabulary (Task 5b).                                  |
| `docs/superpowers/specs/2026-09-03-python-codegraph-e0-measurement-design.md` | Baseline tables appended as an appendix (Task 4); re-baseline delta (Task 5b).                      |

**Deliberately NOT created.** The spec lists `scripts/py-oracle/provision.sh`.
Every corpus venv is already provisioned on this machine, so a provisioning
script would be written, run zero times, and rot. Task 1 records what exists
instead, and its verification step is what would catch a venv going missing.
`scripts/ts-codegraph-typechecker-oracle.ts` is likewise untouched — see the
import probe in the next section.

---

## Context the implementer needs

Read these before Task 1; the plan assumes them.

- **The TS oracle's `main` does not run on import.** Verified in this worktree:
  `npx tsx -e "import('./scripts/ts-codegraph-typechecker-oracle.ts').then(m => console.log(Object.keys(m).length))"`
  prints `27` and nothing else — no oracle output, no non-zero exit. The guard
  sits at `scripts/ts-codegraph-typechecker-oracle.ts:2147`. The 27 exports
  include every function this plan imports. **The spec's fallback — relocating
  the pure core to `scripts/lib/codegraph-oracle-core.ts` — is therefore NOT
  taken, and that file is not modified by any task here.**
- `scripts/codegraph-chain-tally.ts` already rebuilds the Python chain from the
  exported strategy classes in production order (`CHAINS.python.build`, lines
  95–110) and cross-checks it against `factory.create(lang).resolver` per call
  site (`chainDrift`, line 411). `DeferFileOnlyStrategy` (line 131) is the
  wrapper precedent for `AnsweredByProbe`.
- The runner's order is `resolve` → on `null`, `targetsExternalImport` → on
  `false`, `targetsCoreAmbiguousMember`
  (`domains/trajectory/codegraph/symbols/resolution-runner.ts:332-348`);
  `receiverKind` comes from `classifyReceiverKind(call, localBindings)`
  (`receiver-kind.ts:63`). The host reproduces both verbatim.
- `CallRef` carries `callText` / `receiver` / `member` / `startLine` and **no
  column** (`src/core/contracts/types/codegraph-extraction.ts`). Matching a host
  record to an AST node is therefore by `(startLine, member, receiver text)`,
  and an unmatched record is reported by SHAPE, never as one opaque number.
- `GlobalSymbolTable` has exactly **two** implementations —
  `InMemoryGlobalSymbolTable` and `NoopGlobalSymbolTable` — plus two test object
  literals typed against the interface (`fanout-policy.test.ts:19`,
  `codegraph.test.ts:113`). Every other test site is `{} as GlobalSymbolTable` /
  `as unknown as GlobalSymbolTable`, which an added member cannot break. Four
  sites is far under the "make it optional" threshold, so **both methods are
  REQUIRED, not optional.**
- `jedi.Project(root, environment=...)` — the form the spec sketches — raises
  `TypeError` on jedi 0.20.0. The working form is
  `jedi.Project(path=root, environment_path=venv_python)`. Do not re-derive it.
- parso 0.8.7 (jedi's pin) has a stale grammar: PEP 758 `except A, B:`, `match`
  statements and `type X = …` produce error nodes. `grammar.parse()` never
  raises; `grammar.iter_errors()` lists them. polar has 26 + 53 such files
  (~7.6%), netbox 2. That is why `oracleDegraded` is a flag separate from
  `parseFailed`.
- Origin classification order is load-bearing and non-obvious: `site-packages`
  is tested FIRST because ugnest's venv lives inside its own corpus root, and a
  root-prefix-first order misclassified 26 of 30 sampled targets as `project`.

---

## Task 1: corpora manifest + typed loader

**Files**

- Create `scripts/lib/codegraph-corpora.json`
- Create `scripts/lib/codegraph-corpora.ts`
- Create `tests/scripts/codegraph-corpora.test.ts`

**Interfaces**

_Consumes_

```ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
```

_Produces_

```ts
export interface CodegraphCorpusBaseline {
  /** `edges` from `codegraph-chain-tally.ts --lang python`, 2026-09-02. */
  edges: number;
  /** Of those, edges with a null `targetSymbolId` — a SUBSET of `edges`. */
  fileOnly: number;
  unresolved: number;
  /** Peak RSS in MB of that run — the +20% perf gate's denominator. */
  peakRssMb: number;
  /** Wall seconds of the same run — the +25% gate's denominator. */
  wallSeconds: number;
}

export interface CodegraphCorpus {
  name: string;
  /** Absolute corpus root, `~` expanded. */
  path: string;
  language: "python";
  /** Commit the public corpora were cloned at; absent for the two local ones. */
  sha?: string;
  requiresPython: string;
  /** Absolute path to the PROVISIONED interpreter jedi resolves against. */
  venvPython: string;
  venvPythonVersion: string;
  /** Import roots relative to `path`; `["."]` when the repo root is the root. */
  roots: string[];
  stack: string[];
  baseline: CodegraphCorpusBaseline;
  notes?: string;
}

export function expandHome(candidate: string): string;
export function loadCodegraphCorpora(): Record<string, CodegraphCorpus>;
export function loadCodegraphCorpus(name: string): CodegraphCorpus;
```

**Steps**

- [x] Prepare the worktree: `npm ci`, then a bare `npm run build`. No
      `npm link`, no reindex. The build is required because worker-forking specs
      fork the COMPILED worker and a fresh worktree has no `build/`.

- [x] Write the failing test first — `tests/scripts/codegraph-corpora.test.ts`:

```ts
/**
 * The corpora manifest is the E0 harness's single source of truth for WHERE a
 * corpus lives, WHICH interpreter jedi resolves against, and WHAT the chain
 * emitted before any of this landed. It is versioned in this repo and not in
 * `~/Dev/Tools/tea-rags-bench` because that directory is not a git repository:
 * a baseline recorded there has no history and no diff, and the whole point of
 * these numbers is that a later run can be compared against them.
 */
import { isAbsolute } from "node:path";

import { describe, expect, it } from "vitest";

import {
  expandHome,
  loadCodegraphCorpora,
  loadCodegraphCorpus,
} from "../../scripts/lib/codegraph-corpora.js";

const EXPECTED_NAMES = ["flask", "httpx", "netbox", "polar", "ugnest"];

describe("expandHome", () => {
  it("expands a leading ~/ to the home directory", () => {
    expect(isAbsolute(expandHome("~/Dev/x"))).toBe(true);
    expect(expandHome("~/Dev/x").endsWith("/Dev/x")).toBe(true);
  });

  it("leaves an already-absolute path untouched", () => {
    expect(expandHome("/tmp/corpus")).toBe("/tmp/corpus");
  });

  it("does not expand a ~ that is not the leading segment", () => {
    expect(expandHome("/tmp/~notahome")).toBe("/tmp/~notahome");
  });
});

describe("loadCodegraphCorpora", () => {
  it("carries exactly the five E0 corpora", () => {
    expect(Object.keys(loadCodegraphCorpora()).sort()).toEqual(EXPECTED_NAMES);
  });

  it("expands every corpus path and venv interpreter to an absolute path", () => {
    for (const corpus of Object.values(loadCodegraphCorpora())) {
      expect(isAbsolute(corpus.path)).toBe(true);
      expect(isAbsolute(corpus.venvPython)).toBe(true);
      expect(corpus.venvPython.endsWith("/bin/python")).toBe(true);
    }
  });

  it("names each corpus with its own manifest key", () => {
    for (const [key, corpus] of Object.entries(loadCodegraphCorpora())) {
      expect(corpus.name).toBe(key);
    }
  });

  it("declares at least one relative import root per corpus", () => {
    for (const corpus of Object.values(loadCodegraphCorpora())) {
      expect(corpus.roots.length).toBeGreaterThan(0);
      for (const root of corpus.roots) expect(isAbsolute(root)).toBe(false);
    }
  });
});
```

```ts
describe("loadCodegraphCorpus — recorded chain-tally baseline (2026-09-02)", () => {
  it.each([
    ["ugnest", 1432, 315, 5899],
    ["flask", 770, 148, 1402],
    ["netbox", 21971, 8190, 38760],
    ["polar", 21336, 3976, 61218],
    ["httpx", 1011, 193, 1632],
  ])(
    "%s emitted %i edges (%i file-only) and declined %i",
    (name, edges, fileOnly, unresolved) => {
      const { baseline } = loadCodegraphCorpus(String(name));
      expect(baseline.edges).toBe(edges);
      expect(baseline.fileOnly).toBe(fileOnly);
      expect(baseline.unresolved).toBe(unresolved);
    },
  );

  it.each([
    ["httpx", 260, 1.7],
    ["flask", 275, 1.1],
    ["ugnest", 352, 2.4],
    ["polar", 959, 14.5],
    ["netbox", 1293, 16.2],
  ])("%s cost %i MB peak RSS and %f s wall", (name, peakRssMb, wallSeconds) => {
    const { baseline } = loadCodegraphCorpus(String(name));
    expect(baseline.peakRssMb).toBe(peakRssMb);
    expect(baseline.wallSeconds).toBe(wallSeconds);
  });

  it("throws naming the unknown corpus and the known set", () => {
    expect(() => loadCodegraphCorpus("django")).toThrow(
      /unknown corpus 'django'/,
    );
  });
});

describe("loadCodegraphCorpus — provisioned interpreters", () => {
  it("runs polar on the 3.14 interpreter its PEP 758 files need", () => {
    const polar = loadCodegraphCorpus("polar");
    expect(polar.requiresPython).toBe(">=3.14");
    expect(polar.venvPythonVersion.startsWith("3.14")).toBe(true);
  });

  it("keeps ugnest's interpreter inside its own checkout", () => {
    const ugnest = loadCodegraphCorpus("ugnest");
    expect(ugnest.venvPython.startsWith(`${ugnest.path}/`)).toBe(true);
  });
});
```

- [x] Run it and watch it fail on a missing `scripts/lib/codegraph-corpora.js`:
      `npx vitest run tests/scripts/codegraph-corpora.test.ts`.

- [x] Write `scripts/lib/codegraph-corpora.json`. These venvs are ALREADY
      provisioned — this file records them, it does not request them:

```json
{
  "ugnest": {
    "path": "~/Dev/Collaborate/ugnest",
    "language": "python",
    "requiresPython": ">=3.13",
    "venvPython": "~/Dev/Collaborate/ugnest/.venv/bin/python",
    "venvPythonVersion": "3.13.5",
    "roots": ["."],
    "stack": ["django", "djangorestframework"],
    "baseline": {
      "edges": 1432,
      "fileOnly": 315,
      "unresolved": 5899,
      "peakRssMb": 352,
      "wallSeconds": 2.4
    },
    "notes": "The user's own Django 6.0 + DRF project; registry code_035da920 has codegraphEnabled false. The venv lives INSIDE the corpus root, which is why site-packages classification runs before the root-prefix test."
  },
  "flask": {
    "path": "~/Dev/OpenSource/codegraph-test/flask",
    "language": "python",
    "requiresPython": ">=3.10",
    "venvPython": "~/Dev/Tools/tea-rags-bench/venvs/flask/bin/python",
    "venvPythonVersion": "3.13.7",
    "roots": ["src"],
    "stack": ["flask"],
    "baseline": {
      "edges": 770,
      "fileOnly": 148,
      "unresolved": 1402,
      "peakRssMb": 275,
      "wallSeconds": 1.1
    },
    "notes": "Deps are installed but the flask package itself fails at runtime import in this venv. Irrelevant to jedi, which is static and reads site-packages sources."
  },
  "netbox": {
    "path": "~/Dev/Tools/tea-rags-bench/corpora/netbox",
    "language": "python",
    "sha": "1fae2d01",
    "requiresPython": ">=3.12",
    "venvPython": "~/Dev/Tools/tea-rags-bench/venvs/netbox/bin/python",
    "venvPythonVersion": "3.13.7",
    "roots": ["netbox"],
    "stack": ["django", "djangorestframework", "rq"],
    "baseline": {
      "edges": 21971,
      "fileOnly": 8190,
      "unresolved": 38760,
      "peakRssMb": 1293,
      "wallSeconds": 16.2
    },
    "notes": "3.4% annotated defs — the untyped-framework end of the trimodal split. Ships JavaScript, so the symbol table is cross-language while only .py call sites are scored. 2 files carry parso grammar errors."
  },
  "polar": {
    "path": "~/Dev/Tools/tea-rags-bench/corpora/polar",
    "language": "python",
    "sha": "bddb7508",
    "requiresPython": ">=3.14",
    "venvPython": "~/Dev/Tools/tea-rags-bench/venvs/polar/bin/python",
    "venvPythonVersion": "3.14.0rc2",
    "roots": ["server"],
    "stack": ["fastapi", "sqlalchemy", "pydantic", "dramatiq"],
    "baseline": {
      "edges": 21336,
      "fileOnly": 3976,
      "unresolved": 61218,
      "peakRssMb": 959,
      "wallSeconds": 14.5
    },
    "notes": "99.4% annotated and resolves worst — the chain reads no annotations. 26 + 53 files (~7.6%) carry PEP 758 / match / type-alias syntax parso 0.8.7 rejects; their rows are oracleDegraded. 82,554 call sites, 15-40 min unbounded."
  },
  "httpx": {
    "path": "~/Dev/Tools/tea-rags-bench/corpora/httpx",
    "language": "python",
    "sha": "b5addb64",
    "requiresPython": ">=3.9",
    "venvPython": "~/Dev/Tools/tea-rags-bench/venvs/httpx/bin/python",
    "venvPythonVersion": "3.13.7",
    "roots": ["httpx"],
    "stack": ["httpcore", "anyio"],
    "baseline": {
      "edges": 1011,
      "fileOnly": 193,
      "unresolved": 1632,
      "peakRssMb": 260,
      "wallSeconds": 1.7
    },
    "notes": "23 files, 100% annotated — the smoke corpus. Every harness change is validated here first."
  }
}
```

- [x] Write `scripts/lib/codegraph-corpora.ts`:

```ts
/**
 * The E0 corpora manifest, typed (bd tea-rags-mcp-mmckn).
 *
 * Versioned HERE and not in `~/Dev/Tools/tea-rags-bench` because that directory
 * is not a versioned checkout: a baseline recorded there has no history and no
 * diff, and the whole point of the numbers is that a later run can be compared
 * against them. Paths carry `~` in the JSON so the manifest stays readable and
 * machine-independent; every consumer receives them expanded.
 *
 * This module reads the manifest and nothing else. It deliberately does NOT
 * check that a path exists: the loader is unit-tested on machines where the
 * corpora are absent, and a missing corpus must fail at the harness's own walk
 * with a message naming the corpus, not here with an ENOENT during a parse.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface CodegraphCorpusBaseline {
  edges: number;
  fileOnly: number;
  unresolved: number;
  peakRssMb: number;
  wallSeconds: number;
}

export interface CodegraphCorpus {
  name: string;
  path: string;
  language: "python";
  sha?: string;
  requiresPython: string;
  venvPython: string;
  venvPythonVersion: string;
  roots: string[];
  stack: string[];
  baseline: CodegraphCorpusBaseline;
  notes?: string;
}

/** The manifest as it sits on disk — `name` is the key, not a field. */
type CodegraphCorpusEntry = Omit<CodegraphCorpus, "name">;

const MANIFEST_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "codegraph-corpora.json",
);

/**
 * Expand a leading `~/` to the current user's home. ONLY the leading segment:
 * `/tmp/~notahome` is a path a corpus could legitimately live under, and
 * silently rewriting it would be worse than not supporting `~` at all.
 */
export function expandHome(candidate: string): string {
  if (candidate === "~") return homedir();
  if (!candidate.startsWith("~/")) return candidate;
  return resolve(homedir(), candidate.slice(2));
}

let cached: Record<string, CodegraphCorpus> | null = null;

/** Every corpus, keyed by manifest name, paths expanded. Read once per process. */
export function loadCodegraphCorpora(): Record<string, CodegraphCorpus> {
  if (cached !== null) return cached;
  const raw = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Record<
    string,
    CodegraphCorpusEntry
  >;
  const loaded: Record<string, CodegraphCorpus> = {};
  // Sorted so anything iterating the manifest — the baseline runner, the report
  // header — visits the corpora in one fixed order across machines.
  for (const name of Object.keys(raw).sort()) {
    const entry = raw[name];
    if (entry === undefined) continue;
    loaded[name] = {
      ...entry,
      name,
      path: expandHome(entry.path),
      venvPython: expandHome(entry.venvPython),
    };
  }
  cached = loaded;
  return loaded;
}

/** One corpus by name; throws naming the corpus and the known set. */
export function loadCodegraphCorpus(name: string): CodegraphCorpus {
  const corpora = loadCodegraphCorpora();
  const corpus = corpora[name];
  if (corpus === undefined) {
    throw new Error(
      `unknown corpus '${name}' (have: ${Object.keys(corpora).join(", ")})`,
    );
  }
  return corpus;
}
```

- [x] Run the test until green:
      `npx vitest run tests/scripts/codegraph-corpora.test.ts`.

- [x] Confirm the recorded interpreters exist on THIS machine and report the
      recorded versions. A mismatch means the manifest is stale — fix the
      manifest, never soften the assertion:

```bash
for c in flask netbox polar httpx; do
  printf '%s: ' "$c"
  ~/Dev/Tools/tea-rags-bench/venvs/$c/bin/python --version
done
printf 'ugnest: '
~/Dev/Collaborate/ugnest/.venv/bin/python --version
```

- [x] Confirm every corpus root and every declared import root resolves:

```bash
npx tsx -e "
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadCodegraphCorpora } from './scripts/lib/codegraph-corpora.js';
for (const c of Object.values(loadCodegraphCorpora())) {
  const roots = c.roots.map((r) => [r, existsSync(join(c.path, r))]);
  console.log(c.name, existsSync(c.path), existsSync(c.venvPython), JSON.stringify(roots));
}"
```

- [x] Record the chain-tally perf baseline this manifest claims, so later tasks
      compare against a number measured on this machine rather than the one in
      the plan header. Run the five sequentially, nothing else heavy running,
      and paste the `real` / `maximum resident set size` pair into the task's
      commit body:

```bash
/usr/bin/time -l npx tsx scripts/codegraph-chain-tally.ts \
  --corpus ~/Dev/Tools/tea-rags-bench/corpora/httpx --lang python --quiet
```

- [x] Format and commit:

```bash
npx prettier --write scripts/lib/codegraph-corpora.json scripts/lib/codegraph-corpora.ts \
  tests/scripts/codegraph-corpora.test.ts
git add scripts/lib/codegraph-corpora.json scripts/lib/codegraph-corpora.ts \
  tests/scripts/codegraph-corpora.test.ts
git commit -m "feat(scripts): record the five Python codegraph corpora and their venvs (mmckn)"
```

---

## Task 2: the Python side — `jedi_oracle.py`, its pin, and the fixture corpus

**Files**

- Create `scripts/py-oracle/pyproject.toml`
- Create `scripts/py-oracle/jedi_oracle.py`
- Create
  `tests/fixtures/py-oracle/pkg/{__init__,base,models,service,consumer,stdlib_use}.py`
- Create `tests/fixtures/py-oracle/expected-oracle.json`
- Create `tests/scripts/jedi-oracle-spawn.test.ts`

**Interfaces**

_Consumes_ — stdin, NDJSON, one object per line. Line 1 is the config; every
later line is one file's batch, and the host writes them in sorted `relPath`
order:

```jsonc
{ "kind": "config", "corpusRoot": "/abs/corpus", "venvPython": "/abs/venv/bin/python", "workers": 8 }
{ "kind": "file", "relPath": "pkg/service.py", "sites": [
  { "startLine": 12, "callText": "user.rename('x')", "receiver": "user", "member": "rename" }
] }
```

_Produces_ — stdout, NDJSON, exactly one line per input `file` line, in the same
order, each answer in the same order as its `sites`:

```jsonc
{
  "relPath": "pkg/service.py",
  "parseFailed": false,
  "parsoErrors": 0,
  "answers": [
    {
      "startLine": 12,
      "member": "rename",
      "outcome": {
        "kind": "inProject",
        "origin": "project",
        "targets": [
          {
            "relPath": "pkg/models.py",
            "symbolId": "User#rename",
            "defLine": 31,
            "defKind": "function",
            "pinUncertain": false,
          },
        ],
      },
      "siteFacts": {
        "receiverIsAnnotatedParam": true,
        "enclosingHasReturnAnnotation": true,
        "viaReexport": false,
        "viaStarImport": false,
        "isSuperCall": false,
        "targetIsProperty": false,
        "targetIsStaticOrClassMethod": false,
        "receiverIsUnion": false,
        "isDecoratorSite": false,
      },
    },
  ],
}
```

`outcome.kind` is `inProject` | `external` | `unknown` | `parseFailed`; an
unmatched site instead carries
`"unlocated": "decoratorBare" | "multiLineCall" | "subscriptCall" | "coordinateMiss"`
next to `"outcome": {"kind": "unknown"}`. `origin` is `project` |
`generatedInRepo` | `sitePackages` | `stdlib` | `builtin` | `typeshedStub` |
`outsideRepo`.

**Steps**

- [x] Prepare the worktree: `npm ci`, then a bare `npm run build`.

- [x] Confirm the toolchain this task depends on, and STOP if either fails — a
      missing `uv` is a machine problem, not something to work around:

```bash
uv --version
uv run --no-project --python 3.13 --with jedi==0.20.0 python -c \
  "import jedi, parso; print(jedi.__version__, parso.__version__)"
```

- [x] Write `scripts/py-oracle/pyproject.toml`:

```toml
# The oracle's own environment, resolved by `uv run --no-project`. It is NOT the
# corpus's environment: jedi lives here, and the corpus's interpreter is handed
# to `jedi.Project(environment_path=...)` so third-party types come from the
# corpus's own site-packages. Keeping the two apart is what lets one oracle
# build serve five corpora on three interpreter versions.
[project]
name = "tea-rags-py-oracle"
version = "0.1.0"
description = "Offline jedi ground truth for the Python codegraph oracle (bd tea-rags-mcp-mmckn)"
requires-python = ">=3.13"
dependencies = ["jedi==0.20.0"]

[tool.uv]
# jedi pins parso; do not float it. parso 0.8.7's grammar is stale for PEP 758
# and `match`, and the oracle REPORTS that through `parsoErrors` rather than
# papering over it with a newer parso jedi has not been tested against.
package = false
```

- [x] Write the fixture corpus. Six files, one per shape the oracle has to get
      right, and small enough that the expected answers can be read by hand.

`tests/fixtures/py-oracle/pkg/base.py`:

```python
"""Two plain bases, so `models.py` can be genuinely multi-base."""


class Auditable:
    def touch(self) -> None:
        self.touched = True

    def describe(self) -> str:
        return "auditable"


class Named:
    def __init__(self, name: str) -> None:
        self.name = name

    def describe(self) -> str:
        return self.name
```

`tests/fixtures/py-oracle/pkg/models.py`:

```python
"""Multi-base MRO, `super()`, `@property` and `@staticmethod` in one class."""

from .base import Auditable, Named


class User(Auditable, Named):
    def __init__(self, name: str, email: str) -> None:
        super().__init__(name)
        self.email = email

    @property
    def handle(self) -> str:
        return self.name.lower()

    @staticmethod
    def normalise(raw: str) -> str:
        return raw.strip()

    def rename(self, name: str) -> str:
        self.touch()
        return self.describe()
```

`tests/fixtures/py-oracle/pkg/service.py`:

```python
"""Annotated parameter and annotated return — the shape the chain cannot read."""

from .models import User


def promote(user: User) -> str:
    user.touch()
    return user.rename("promoted")


def normalise_all(raw: list[str]) -> list[str]:
    return [User.normalise(item) for item in raw]
```

`tests/fixtures/py-oracle/pkg/__init__.py`:

```python
"""Both re-export idioms in one package root."""

from .base import Auditable as Auditable
from .models import User
from .service import promote

__all__ = ["User", "promote"]
```

`tests/fixtures/py-oracle/pkg/consumer.py`:

```python
"""Calls that arrive through the package root rather than the defining module."""

from . import User, promote


def run(name: str) -> str:
    user = User(name, f"{name}@example.com")
    return promote(user)
```

`tests/fixtures/py-oracle/pkg/stdlib_use.py`:

```python
"""Stdlib, builtin and third-party receivers — the external denominator."""

import json
import os.path

import jedi


def dump(payload: dict[str, str]) -> str:
    return json.dumps(payload)


def join_here(name: str) -> str:
    return os.path.join(os.path.dirname(__file__), name)


def probe(source: str) -> int:
    return len(jedi.Script(source).get_names())
```

- [x] Write `scripts/py-oracle/jedi_oracle.py`. It is one file; the plan shows
      it in two parts only because of length — part 2 is appended verbatim below
      part 1, with nothing between them.

**Part 1 of 2 — protocol types, origin classification, symbolId composition:**

```python
#!/usr/bin/env python3
"""Ground truth for the Python codegraph oracle (bd tea-rags-mcp-mmckn).

Thin by design. This process answers ONE question per call site — "where is the
callee defined?" — and never sees the resolver's answer, so it cannot be tuned
toward agreement. Every comparison lives in the TS host.

Run through `uv`, so jedi's own environment stays separate from the corpus's:

    uv run --no-project --python 3.13 --with jedi==0.20.0 \\
        python scripts/py-oracle/jedi_oracle.py

Two facts about jedi 0.20.0 that cost time to find, recorded so they are not
re-derived:

  * `jedi.Project(root, environment=...)` raises TypeError. The working form is
    `jedi.Project(path=root, environment_path=venv_python)`.
  * parso 0.8.7 (jedi's pin) has a stale grammar. PEP 758 `except A, B:`,
    `match` statements and `type X = ...` produce error nodes rather than an
    exception, so `grammar.parse()` silently succeeds while jedi loses the
    enclosing suite. That is reported per file as `parsoErrors`, and the host
    marks every row of such a file degraded rather than trusting or dropping it.
"""

from __future__ import annotations

import ast
import json
import multiprocessing as mp
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

import jedi
import parso

STDLIB_DIR_RE = re.compile(r"/lib/python3\.\d+/(?!site-packages/)")
JEDI_STUB_MARKERS = ("/jedi/third_party/typeshed/", "/jedi/third_party/django-stubs/")
IN_PROJECT_ORIGINS = frozenset({"project", "generatedInRepo"})


@dataclass(frozen=True)
class CallSite:
    """One AST node the oracle can query, located by the callee's END position."""

    start_line: int
    member: str
    receiver: str | None
    query_line: int
    query_col: int
    shape: str  # "call" | "decoratorBare" | "subscriptCall"
    is_decorator: bool
    receiver_is_annotated_param: bool
    enclosing_has_return_annotation: bool
    is_super_call: bool
    receiver_is_union: bool


_STATE: dict[str, Any] = {}


def classify_origin(module_path: Path | None, corpus_root: Path) -> str:
    """Where a jedi target lives.

    ORDER IS LOAD-BEARING and is not the obvious one. jedi's bundled stubs sit
    UNDER site-packages, so the stub test must precede the site-packages test or
    no target ever reads `typeshedStub`. And both must precede the corpus-root
    prefix test: ugnest keeps its virtualenv INSIDE its own checkout, so a
    root-prefix-first order called Django's own source "project" — 26 of 30
    sampled targets were misclassified that way before this order was fixed.
    """
    if module_path is None:
        return "builtin"
    text = module_path.as_posix()
    if any(marker in text for marker in JEDI_STUB_MARKERS):
        return "typeshedStub"
    if "/site-packages/" in text or "/dist-packages/" in text:
        return "sitePackages"
    if STDLIB_DIR_RE.search(text) is not None:
        return "stdlib"
    if module_path.stem in sys.stdlib_module_names:
        return "stdlib"
    try:
        rel = module_path.resolve().relative_to(corpus_root)
    except ValueError:
        return "outsideRepo"
    return "generatedInRepo" if "migrations" in rel.parts else "project"


def compose_symbol_id(target_path: Path, def_line: int) -> tuple[str | None, str, bool]:
    """`(symbolId, defKind, pinUncertain)` for a definition at `def_line`.

    Mirrors `DefaultSymbolIdComposer`: `Class#method` for an instance method,
    `Class.method` when the def carries `staticmethod` / `classmethod`, a bare
    name at module level, `Outer.Inner` for nesting. When the def node cannot be
    read back — the file is unparseable, or jedi pointed at a line no `def` or
    `class` starts on — the target is `pinUncertain` and the host compares at
    FILE granularity only rather than scoring a mismatch it cannot justify.
    """
    tree = _cached_tree(target_path)
    if tree is None:
        return None, "unknown", True

    stack: list[tuple[ast.AST, list[str]]] = [(tree, [])]
    while stack:
        node, scope = stack.pop()
        for child in ast.iter_child_nodes(node):
            if not isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                continue
            if child.lineno == def_line:
                return _compose_for(child, scope)
            inner = scope + [child.name]
            stack.append((child, inner))
    return None, "unknown", True


def _compose_for(node: ast.AST, scope: list[str]) -> tuple[str, str, bool]:
    if isinstance(node, ast.ClassDef):
        return (".".join(scope + [node.name]), "class", False)
    decorators = {
        d.id for d in getattr(node, "decorator_list", []) if isinstance(d, ast.Name)
    }
    name = getattr(node, "name", "")
    if not scope:
        return (name, "function", False)
    separator = "." if decorators & {"staticmethod", "classmethod"} else "#"
    return (f"{'.'.join(scope)}{separator}{name}", "function", False)
```

**Part 2 of 2 — enumeration, matching, the jedi query, and the run loop:**

```python
_TREE_CACHE: dict[str, ast.Module | None] = {}


def _cached_tree(path: Path) -> ast.Module | None:
    key = path.as_posix()
    if key not in _TREE_CACHE:
        try:
            _TREE_CACHE[key] = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
        except (OSError, SyntaxError, ValueError):
            _TREE_CACHE[key] = None
    return _TREE_CACHE[key]


def _receiver_text(node: ast.AST, code: str) -> str | None:
    segment = ast.get_source_segment(code, node)
    return segment if segment is None else segment.strip()


def enumerate_call_sites(tree: ast.Module, code: str) -> list[CallSite]:
    """Every node the walker could have emitted a `CallRef` for.

    Sorted by `(query_line, query_col)` so a file's sites are enumerated in one
    fixed order regardless of how `ast.walk` happens to traverse. Three
    families, matching the walker: ordinary calls, decorator calls (which ARE
    `ast.Call` and so arrive through the same pass), and BARE decorators
    (`@setupmethod`), which are `Name` / `Attribute` and would otherwise be
    invisible even though `collectPythonDecoratorCalls` emits them.
    """
    annotated_params: set[str] = set()
    union_params: set[str] = set()
    returns_annotated: dict[int, bool] = {}
    decorator_nodes: set[int] = set()
    bare: list[CallSite] = []

    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            returns_annotated[node.lineno] = node.returns is not None
            for arg in [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs]:
                if arg.annotation is None:
                    continue
                annotated_params.add(arg.arg)
                rendered = ast.get_source_segment(code, arg.annotation) or ""
                if "|" in rendered or rendered.startswith(("Union[", "Optional[")):
                    union_params.add(arg.arg)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            for dec in node.decorator_list:
                decorator_nodes.add(id(dec))
                if isinstance(dec, (ast.Name, ast.Attribute)):
                    member = dec.id if isinstance(dec, ast.Name) else dec.attr
                    receiver = None if isinstance(dec, ast.Name) else _receiver_text(dec.value, code)
                    bare.append(
                        CallSite(
                            start_line=dec.lineno,
                            member=member,
                            receiver=receiver,
                            query_line=dec.end_lineno or dec.lineno,
                            query_col=(dec.end_col_offset or 1) - 1,
                            shape="decoratorBare",
                            is_decorator=True,
                            receiver_is_annotated_param=False,
                            enclosing_has_return_annotation=False,
                            is_super_call=False,
                            receiver_is_union=False,
                        )
                    )

    sites: list[CallSite] = list(bare)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Attribute):
            member, receiver_node = func.attr, func.value
            receiver = _receiver_text(receiver_node, code)
            shape = "subscriptCall" if isinstance(receiver_node, ast.Subscript) else "call"
            is_super = isinstance(receiver_node, ast.Call) and isinstance(receiver_node.func, ast.Name) and receiver_node.func.id == "super"
        elif isinstance(func, ast.Name):
            member, receiver, shape, is_super = func.id, None, "call", False
        elif isinstance(func, ast.Subscript):
            continue  # the walker emits these through `dispatch`, which the host skips
        else:
            continue
        root = receiver.split(".")[0] if receiver else ""
        sites.append(
            CallSite(
                start_line=node.lineno,
                member=member,
                receiver=receiver,
                query_line=func.end_lineno or node.lineno,
                query_col=(func.end_col_offset or 1) - 1,
                shape=shape,
                is_decorator=id(node) in decorator_nodes,
                receiver_is_annotated_param=root in annotated_params,
                enclosing_has_return_annotation=any(returns_annotated.values()),
                is_super_call=is_super,
                receiver_is_union=root in union_params,
            )
        )
    sites.sort(key=lambda s: (s.query_line, s.query_col, s.member))
    return sites
```

**Part 2 of 2, continued — matching, the jedi query, and the run loop. The file
is the three blocks concatenated in the order shown, nothing else:**

```python
UNLOCATED_LOOKAHEAD = 10


def match_site(record: dict[str, Any], sites: list[CallSite]) -> tuple[CallSite | None, str | None]:
    """Find the AST node a host record names, or say why it could not be found.

    `CallRef` carries no column, so the match is `(startLine, member)` with the
    receiver text as the tie-break. An unmatched record is reported BY SHAPE and
    never as one opaque number: the TS wave's `nodeNotLocated` bucket hid three
    distinct defects behind a single count until it was decomposed this way.
    """
    line, member = record["startLine"], record["member"]
    receiver = record.get("receiver")
    same_line = [s for s in sites if s.start_line == line and s.member == member]
    if len(same_line) == 1:
        return same_line[0], None
    if same_line:
        exact = [s for s in same_line if s.receiver == receiver]
        return (exact[0] if exact else same_line[0]), None

    if any(s.member == member and s.shape == "decoratorBare" for s in sites):
        return None, "decoratorBare"
    if any(s.member == member and line < s.start_line <= line + UNLOCATED_LOOKAHEAD for s in sites):
        return None, "multiLineCall"
    if any(s.member == member and s.shape == "subscriptCall" for s in sites):
        return None, "subscriptCall"
    return None, "coordinateMiss"


def query_site(script: jedi.Script, site: CallSite, corpus_root: Path) -> dict[str, Any]:
    """jedi's answer for one site: `goto`, then `infer` when `goto` says nothing.

    `follow_builtin_imports=False` keeps a builtin from being followed into C
    source that does not exist as Python — the answer wanted there is "builtin",
    which `module_path is None` already expresses.
    """
    try:
        names = script.goto(
            site.query_line, site.query_col, follow_imports=True, follow_builtin_imports=False
        )
        if not names:
            names = script.infer(site.query_line, site.query_col)
    except Exception:  # jedi raises a wide family on degraded parses; a failure is "unknown"
        return {"kind": "unknown"}
    if not names:
        return {"kind": "unknown"}

    targets: list[dict[str, Any]] = []
    origins: list[str] = []
    for name in names:
        module_path = name.module_path
        origin = classify_origin(module_path, corpus_root)
        origins.append(origin)
        if origin not in IN_PROJECT_ORIGINS or module_path is None:
            continue
        def_line = name.line or 0
        symbol_id, def_kind, uncertain = compose_symbol_id(module_path, def_line)
        targets.append(
            {
                "relPath": module_path.resolve().relative_to(corpus_root).as_posix(),
                "symbolId": symbol_id,
                "defLine": def_line,
                "defKind": name.type or def_kind,
                "pinUncertain": uncertain,
            }
        )
    if targets:
        targets.sort(key=lambda t: (t["relPath"], t["defLine"]))
        in_project = [o for o in origins if o in IN_PROJECT_ORIGINS]
        return {"kind": "inProject", "origin": in_project[0], "targets": targets}
    return {"kind": "external", "origin": origins[0]}
```

**Part 2 of 2, final block — the per-file worker and the run loop:**

```python
def init_worker(corpus_root: str, venv_python: str | None) -> None:
    root = Path(corpus_root).resolve()
    _STATE["corpus_root"] = root
    # `jedi.Project(root, environment=...)` raises TypeError on 0.20.0.
    _STATE["project"] = (
        jedi.Project(path=str(root), environment_path=venv_python)
        if venv_python
        else jedi.Project(path=str(root))
    )
    _STATE["grammar"] = parso.load_grammar()


def answer_file(batch: dict[str, Any]) -> dict[str, Any]:
    """One file: parse, enumerate, one `jedi.Script`, one answer per host record."""
    rel_path = batch["relPath"]
    root: Path = _STATE["corpus_root"]
    absolute = root / rel_path
    try:
        code = absolute.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return {"relPath": rel_path, "parseFailed": True, "parsoErrors": 0, "answers": []}

    # Two independent parses on purpose. `ast.parse` is the ORACLE's own ability
    # to read the file — its failure means there is no ground truth at all.
    # parso is JEDI's parser, and it never raises: it returns error nodes, so the
    # only way to see that jedi is working from a damaged tree is to count them.
    parso_errors = 0
    try:
        parso_errors = len(list(_STATE["grammar"].iter_errors(_STATE["grammar"].parse(code))))
    except Exception:
        parso_errors = 0
    try:
        tree = ast.parse(code)
    except (SyntaxError, ValueError):
        return {
            "relPath": rel_path,
            "parseFailed": True,
            "parsoErrors": parso_errors,
            "answers": [
                {"startLine": r["startLine"], "member": r["member"], "outcome": {"kind": "parseFailed"}}
                for r in batch["sites"]
            ],
        }

    sites = enumerate_call_sites(tree, code)
    script = jedi.Script(code, path=str(absolute), project=_STATE["project"])
    answers: list[dict[str, Any]] = []
    for record in batch["sites"]:
        site, unlocated = match_site(record, sites)
        if site is None:
            answers.append(
                {
                    "startLine": record["startLine"],
                    "member": record["member"],
                    "outcome": {"kind": "unknown"},
                    "unlocated": unlocated,
                }
            )
            continue
        outcome = query_site(script, site, root)
        targets = outcome.get("targets") or []
        answers.append(
            {
                "startLine": record["startLine"],
                "member": record["member"],
                "outcome": outcome,
                "siteFacts": {
                    "receiverIsAnnotatedParam": site.receiver_is_annotated_param,
                    "enclosingHasReturnAnnotation": site.enclosing_has_return_annotation,
                    "viaReexport": any(t["relPath"].endswith("/__init__.py") for t in targets),
                    "viaStarImport": False,
                    "isSuperCall": site.is_super_call,
                    "targetIsProperty": any(t["defKind"] == "property" for t in targets),
                    "targetIsStaticOrClassMethod": any(
                        t["symbolId"] is not None and "." in (t["symbolId"] or "") for t in targets
                    ),
                    "receiverIsUnion": site.receiver_is_union,
                    "isDecoratorSite": site.is_decorator,
                },
            }
        )
    return {"relPath": rel_path, "parseFailed": False, "parsoErrors": parso_errors, "answers": answers}


def read_batches(stream: Any) -> Iterator[dict[str, Any]]:
    for line in stream:
        line = line.strip()
        if line:
            yield json.loads(line)


def main() -> int:
    batches = read_batches(sys.stdin)
    config = next(batches)
    if config.get("kind") != "config":
        sys.stderr.write("first stdin line must be the config record\n")
        return 2
    corpus_root, venv = config["corpusRoot"], config.get("venvPython") or None
    files = [b for b in batches if b.get("kind") == "file"]
    workers = max(1, min(int(config.get("workers", 1)), len(files) or 1))

    if workers == 1:
        init_worker(corpus_root, venv)
        results = (answer_file(batch) for batch in files)
    else:
        # `imap` preserves input order, so the output is deterministic even
        # though the work is not. `fork` inherits the initialised project.
        pool = mp.get_context("fork").Pool(workers, init_worker, (corpus_root, venv))
        results = pool.imap(answer_file, files, chunksize=4)

    for result in results:
        sys.stdout.write(json.dumps(result, sort_keys=True, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [x] Write the spawn test `tests/scripts/jedi-oracle-spawn.test.ts`. It is the
      only test in this plan that starts a Python process, so it is gated on
      `uv` — CI is node-only and must skip it, not fail:

```ts
/**
 * The one end-to-end check of the Python side (bd tea-rags-mcp-mmckn). Every
 * other jedi behaviour is asserted through this fixture, because a unit test of
 * `query_site` would be a test of a mock rather than of jedi.
 *
 * `tests/fixtures/py-oracle/expected-oracle.json` is FROZEN ground truth,
 * reviewed by hand against the fixture sources. When a jedi upgrade moves a
 * row, a human confirms jedi is right and updates the fixture in the same
 * commit — the test is never relaxed to make a new answer pass.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const FIXTURE_ROOT = join(REPO_ROOT, "tests", "fixtures", "py-oracle");
const uvAvailable =
  spawnSync("uv", ["--version"], { encoding: "utf8" }).status === 0;

interface OracleAnswer {
  startLine: number;
  member: string;
  outcome: {
    kind: string;
    origin?: string;
    targets?: { relPath: string; symbolId: string | null }[];
  };
  unlocated?: string;
}

/** Sites the host would emit for the fixture, in the order a walk produces them. */
const SITES: Record<
  string,
  {
    startLine: number;
    callText: string;
    receiver: string | null;
    member: string;
  }[]
> = {
  "pkg/consumer.py": [
    {
      startLine: 7,
      callText: "User(name, ...)",
      receiver: null,
      member: "User",
    },
    {
      startLine: 8,
      callText: "promote(user)",
      receiver: null,
      member: "promote",
    },
  ],
  "pkg/models.py": [
    {
      startLine: 8,
      callText: "super().__init__(name)",
      receiver: "super()",
      member: "__init__",
    },
    {
      startLine: 22,
      callText: "self.touch()",
      receiver: "self",
      member: "touch",
    },
    {
      startLine: 23,
      callText: "self.describe()",
      receiver: "self",
      member: "describe",
    },
  ],
  "pkg/service.py": [
    {
      startLine: 7,
      callText: "user.touch()",
      receiver: "user",
      member: "touch",
    },
    {
      startLine: 8,
      callText: "user.rename('promoted')",
      receiver: "user",
      member: "rename",
    },
    {
      startLine: 12,
      callText: "User.normalise(item)",
      receiver: "User",
      member: "normalise",
    },
  ],
  "pkg/stdlib_use.py": [
    {
      startLine: 10,
      callText: "json.dumps(payload)",
      receiver: "json",
      member: "dumps",
    },
    {
      startLine: 14,
      callText: "os.path.join(...)",
      receiver: "os.path",
      member: "join",
    },
    {
      startLine: 18,
      callText: "jedi.Script(source)",
      receiver: "jedi",
      member: "Script",
    },
  ],
};

function runOracle(): Record<string, OracleAnswer[]> {
  const lines = [
    JSON.stringify({
      kind: "config",
      corpusRoot: FIXTURE_ROOT,
      venvPython: null,
      workers: 1,
    }),
  ];
  for (const relPath of Object.keys(SITES).sort()) {
    lines.push(
      JSON.stringify({ kind: "file", relPath, sites: SITES[relPath] }),
    );
  }
  const child = spawnSync(
    "uv",
    [
      "run",
      "--no-project",
      "--python",
      "3.13",
      "--with",
      "jedi==0.20.0",
      "python",
      join(REPO_ROOT, "scripts", "py-oracle", "jedi_oracle.py"),
    ],
    {
      input: `${lines.join("\n")}\n`,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  expect(child.status, child.stderr).toBe(0);
  const byFile: Record<string, OracleAnswer[]> = {};
  for (const line of child.stdout.trim().split("\n")) {
    const parsed = JSON.parse(line) as {
      relPath: string;
      answers: OracleAnswer[];
      parseFailed: boolean;
      parsoErrors: number;
    };
    expect(parsed.parseFailed).toBe(false);
    expect(parsed.parsoErrors).toBe(0);
    byFile[parsed.relPath] = parsed.answers;
  }
  return byFile;
}
```

- [x] Add the assertions to the same file — the named invariants first, the
      frozen fixture last:

```ts
describe.skipIf(!uvAvailable)("jedi_oracle.py over the fixture corpus", () => {
  const answersFor = (relPath: string, member: string): OracleAnswer => {
    const found = runOracle()[relPath]?.find((a) => a.member === member);
    expect(found, `${relPath} has no answer for ${member}`).toBeDefined();
    return found as OracleAnswer;
  };

  it("resolves an inherited method through the first base in the MRO", () => {
    const answer = answersFor("pkg/service.py", "touch");
    expect(answer.outcome.kind).toBe("inProject");
    expect(answer.outcome.origin).toBe("project");
    expect(answer.outcome.targets?.[0]).toMatchObject({
      relPath: "pkg/base.py",
      symbolId: "Auditable#touch",
    });
  });

  it("pins a staticmethod with a DOT separator, not a hash", () => {
    expect(
      answersFor("pkg/service.py", "normalise").outcome.targets?.[0],
    ).toMatchObject({
      relPath: "pkg/models.py",
      symbolId: "User.normalise",
    });
  });

  it("follows super() to the second base's __init__", () => {
    expect(
      answersFor("pkg/models.py", "__init__").outcome.targets?.[0],
    ).toMatchObject({
      relPath: "pkg/base.py",
      symbolId: "Named#__init__",
    });
  });

  it("follows the package __init__ re-export back to the defining module", () => {
    expect(
      answersFor("pkg/consumer.py", "promote").outcome.targets?.[0],
    ).toMatchObject({
      relPath: "pkg/service.py",
      symbolId: "promote",
    });
  });

  it("calls stdlib receivers external with origin stdlib", () => {
    const answer = answersFor("pkg/stdlib_use.py", "dumps");
    expect(answer.outcome.kind).toBe("external");
    expect(answer.outcome.origin).toBe("stdlib");
  });

  it("calls a third-party receiver external with origin sitePackages", () => {
    const answer = answersFor("pkg/stdlib_use.py", "Script");
    expect(answer.outcome.kind).toBe("external");
    expect(answer.outcome.origin).toBe("sitePackages");
  });

  it("matches the frozen expected output exactly", () => {
    const expected = JSON.parse(
      readFileSync(join(FIXTURE_ROOT, "expected-oracle.json"), "utf8"),
    ) as Record<string, OracleAnswer[]>;
    expect(runOracle()).toEqual(expected);
  });
});
```

- [x] Generate `tests/fixtures/py-oracle/expected-oracle.json` ONCE, then read
      every row against the fixture sources before committing it. A row that
      disagrees with the source is a bug in `jedi_oracle.py`, not a fixture to
      accept:

```bash
npx vitest run tests/scripts/jedi-oracle-spawn.test.ts -t "frozen expected output" 2>&1 | tail -40
```

      Write the file from the six named invariants plus the remaining rows the
      run prints, two-space indent, keys sorted, so a later diff is readable.
      Every row states: the file, the line, the member, `outcome.kind`,
      `outcome.origin`, and for `inProject` the exact `relPath` + `symbolId`
      pair. `describe` at `pkg/models.py:23` resolves through the MRO to
      `Auditable#describe` — the FIRST base wins, and a fixture saying
      `Named#describe` means the MRO order is wrong somewhere.

- [x] Verify the degraded path on a throwaway file rather than trusting polar
      for it. The row must carry `parsoErrors > 0` and still answer:

```bash
printf 'def f(x):\n    match x:\n        case 1:\n            return x\n' > /tmp/pep634.py
printf '{"kind":"config","corpusRoot":"/tmp","venvPython":null,"workers":1}\n{"kind":"file","relPath":"pep634.py","sites":[]}\n' \
  | uv run --no-project --python 3.13 --with jedi==0.20.0 python scripts/py-oracle/jedi_oracle.py
```

- [x] Run the whole file, then confirm it SKIPS cleanly when `uv` is not on the
      path: `npx vitest run tests/scripts/jedi-oracle-spawn.test.ts`, then the
      same command with `PATH=/usr/bin`.

- [x] Format and commit:

```bash
npx prettier --write tests/scripts/jedi-oracle-spawn.test.ts tests/fixtures/py-oracle/expected-oracle.json
git add scripts/py-oracle tests/fixtures/py-oracle tests/scripts/jedi-oracle-spawn.test.ts
git commit -m "feat(scripts): add the jedi ground-truth oracle for Python call sites (mmckn)"
```

---

## Task 3: the pure core and the TS host harness

**Files**

- Create `scripts/lib/py-oracle-core.ts`
- Create `tests/scripts/py-oracle-core.test.ts`
- Create `scripts/py-codegraph-jedi-oracle.ts`
- Create `tests/scripts/py-codegraph-jedi-oracle.test.ts`

**Interfaces**

_Consumes_ — from the TS oracle, by import. That module's `main` is guarded, so
importing it runs nothing (verified: 27 exports, no output):

```ts
import {
  buildCorpusExclusionFilter,
  buildSymbolDefs,
  collectSourceFiles,
  diffResolution,
  extractFile,
  formatOracleTable,
  tallyBy,
  type OracleAnswer,
  type OracleOutcome,
  type OracleRow,
  type OracleTally,
  type OracleVerdict,
} from "./ts-codegraph-typechecker-oracle.js";
```

and from production, for the chain and the classifier:

```ts
import { DEFAULT_AMBIGUOUS_RESOLVE_MODE } from "../src/core/contracts/types/codegraph.js";
import {
  collectSymbols,
  DefaultSymbolIdComposer,
  LanguageFactory,
} from "../src/core/domains/language/index.js";
import {
  CONE_MAX_DEFAULT,
  PythonGlobalShortNameSymbolResolutionStrategy,
  PythonImportMatchSymbolResolutionStrategy,
  PythonLocalBindingSymbolResolutionStrategy,
  PythonSelfFieldSymbolResolutionStrategy,
  PythonSelfMemberSymbolResolutionStrategy,
  PythonSuperSymbolResolutionStrategy,
} from "../src/core/domains/language/python/resolver/strategies/index.js";
import { resolveViaChain } from "../src/core/domains/language/resolver-chain.js";
import { classifyReceiverKind } from "../src/core/domains/trajectory/codegraph/symbols/receiver-kind.js";
import { InMemoryGlobalSymbolTable } from "../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
```

_Produces_ — `scripts/lib/py-oracle-core.ts`:

```ts
/** The TS verdicts plus the two Python-specific ones. */
export type PyOracleVerdict =
  | OracleVerdict
  | "skippedInProject"
  | "parseFailed";

export type PyTargetOrigin =
  | "project"
  | "generatedInRepo"
  | "sitePackages"
  | "stdlib"
  | "builtin"
  | "typeshedStub"
  | "outsideRepo";

export const PY_MISSED_CATEGORIES = [
  "annotationParam",
  "annotationReturn",
  "reexport",
  "starImport",
  "superMro",
  "decoratorProperty",
  "managerQuerySet",
  "dependsInjection",
  "unionReceiver",
  "plain",
] as const;
export type PyMissedCategory = (typeof PY_MISSED_CATEGORIES)[number];

export const PY_UNLOCATED_SHAPES = [
  "decoratorBare",
  "multiLineCall",
  "subscriptCall",
  "coordinateMiss",
] as const;
export type PyUnlocatedShape = (typeof PY_UNLOCATED_SHAPES)[number];

/** Booleans the Python side reports per answered site. */
export interface PySiteFacts {
  receiverIsAnnotatedParam: boolean;
  enclosingHasReturnAnnotation: boolean;
  viaReexport: boolean;
  viaStarImport: boolean;
  isSuperCall: boolean;
  targetIsProperty: boolean;
  targetIsStaticOrClassMethod: boolean;
  receiverIsUnion: boolean;
  isDecoratorSite: boolean;
}

export interface PyOracleRow {
  relPath: string;
  startLine: number;
  callText: string;
  receiver: string | null;
  member: string;
  receiverKind: string;
  categories: PyMissedCategory[];
  verdict: PyOracleVerdict;
  /** Which chain pass returned `resolved`, `"none"` when the chain declined. */
  answeredBy: string;
  chainOutput: "pinned" | "fileOnly" | "none";
  chain?: OracleAnswer;
  origin?: PyTargetOrigin;
  /** The file's parso grammar errors made jedi's tree unreliable for this row. */
  oracleDegraded: boolean;
  unlocatedShape?: PyUnlocatedShape;
}

export function classifyPyVerdict(input: {
  chain: OracleAnswer | null;
  oracle: OracleOutcome;
  parseFailed: boolean;
  classifiedExternal: boolean;
}): PyOracleVerdict;

export function categorizePySite(
  facts: PySiteFacts | undefined,
  row: { receiver: string | null; member: string },
): PyMissedCategory[];

export function tallyPyRows(
  rows: readonly PyOracleRow[],
  labelsOf: (row: PyOracleRow) => readonly string[],
): OracleTally[];

export function samplePyRows(
  rows: readonly PyOracleRow[],
  verdict: PyOracleVerdict,
  count: number,
  seed: number,
): PyOracleRow[];

export function mulberry32(seed: number): () => number;
```

**Steps**

- [ ] Prepare the worktree: `npm ci`, then a bare `npm run build`.

- [ ] Re-confirm the import probe before writing a line of it — the whole task
      assumes it, and it is one command:

```bash
npx tsx -e "import('./scripts/ts-codegraph-typechecker-oracle.ts').then(m => console.log(Object.keys(m).length))"
```

      Expect `27` and no other output. Anything else means `main` now runs on
      import, and the pure core must be relocated to
      `scripts/lib/codegraph-oracle-core.ts` (tests MOVED, not rewritten)
      before continuing.

- [ ] Write the failing pure-core tests first —
      `tests/scripts/py-oracle-core.test.ts`:

```ts
/**
 * The Python oracle's pure core (bd tea-rags-mcp-mmckn). Everything here takes
 * in-memory inputs and returns values: no corpus, no subprocess, no jedi. The
 * comparison rules ARE the measurement, so each one gets a case — a verdict
 * that buckets wrongly does not fail loudly, it just reports a number nobody
 * can act on.
 */
import { describe, expect, it } from "vitest";

import {
  categorizePySite,
  classifyPyVerdict,
  mulberry32,
  samplePyRows,
  tallyPyRows,
  type PyOracleRow,
  type PySiteFacts,
} from "../../scripts/lib/py-oracle-core.js";

const inProject = (relPath: string, symbolId: string | null) =>
  ({
    kind: "inProject",
    answer: { targetRelPath: relPath, targetSymbolId: symbolId },
  }) as const;

const facts = (overrides: Partial<PySiteFacts> = {}): PySiteFacts => ({
  receiverIsAnnotatedParam: false,
  enclosingHasReturnAnnotation: false,
  viaReexport: false,
  viaStarImport: false,
  isSuperCall: false,
  targetIsProperty: false,
  targetIsStaticOrClassMethod: false,
  receiverIsUnion: false,
  isDecoratorSite: false,
  ...overrides,
});

const row = (overrides: Partial<PyOracleRow> = {}): PyOracleRow => ({
  relPath: "pkg/a.py",
  startLine: 1,
  callText: "x.f()",
  receiver: "x",
  member: "f",
  receiverKind: "localVar",
  categories: ["plain"],
  verdict: "match",
  answeredBy: "localBinding",
  chainOutput: "pinned",
  oracleDegraded: false,
  ...overrides,
});

describe("classifyPyVerdict", () => {
  it("defers to the shared diff when nothing Python-specific applies", () => {
    expect(
      classifyPyVerdict({
        chain: { targetRelPath: "pkg/b.py", targetSymbolId: "B#f" },
        oracle: inProject("pkg/b.py", "B#f"),
        parseFailed: false,
        classifiedExternal: false,
      }),
    ).toBe("match");
  });

  it("reports parseFailed ahead of every other rule", () => {
    expect(
      classifyPyVerdict({
        chain: { targetRelPath: "pkg/b.py", targetSymbolId: "B#f" },
        oracle: { kind: "unknown" },
        parseFailed: true,
        classifiedExternal: false,
      }),
    ).toBe("parseFailed");
  });

  it("calls a site skippedInProject when the classifier said external and truth is in-project", () => {
    expect(
      classifyPyVerdict({
        chain: null,
        oracle: inProject("pkg/b.py", "B#f"),
        parseFailed: false,
        classifiedExternal: true,
      }),
    ).toBe("skippedInProject");
  });

  it("leaves an external classification agreeing with external truth as agreeExternal", () => {
    expect(
      classifyPyVerdict({
        chain: null,
        oracle: { kind: "external" },
        parseFailed: false,
        classifiedExternal: true,
      }),
    ).toBe("agreeExternal");
  });

  it("still reports missed when the chain declined WITHOUT calling the site external", () => {
    expect(
      classifyPyVerdict({
        chain: null,
        oracle: inProject("pkg/b.py", "B#f"),
        parseFailed: false,
        classifiedExternal: false,
      }),
    ).toBe("missed");
  });
});
```

- [ ] Add the remaining pure-core cases to the same file:

```ts
describe("categorizePySite", () => {
  it("returns plain when no facts apply", () => {
    expect(categorizePySite(facts(), { receiver: "x", member: "f" })).toEqual([
      "plain",
    ]);
  });

  it("carries several categories at once — the axis overlaps by construction", () => {
    expect(
      categorizePySite(
        facts({
          receiverIsAnnotatedParam: true,
          enclosingHasReturnAnnotation: true,
        }),
        {
          receiver: "user",
          member: "rename",
        },
      ).sort(),
    ).toEqual(["annotationParam", "annotationReturn"]);
  });

  it("tags a Django manager chain from the receiver text alone", () => {
    expect(
      categorizePySite(facts(), { receiver: "Device.objects", member: "all" }),
    ).toContain("managerQuerySet");
  });

  it("tags a FastAPI Depends injection site", () => {
    expect(
      categorizePySite(facts({ isDecoratorSite: true }), {
        receiver: null,
        member: "Depends",
      }),
    ).toContain("dependsInjection");
  });

  it("never returns plain alongside a specific category", () => {
    expect(
      categorizePySite(facts({ isSuperCall: true }), {
        receiver: "super()",
        member: "__init__",
      }),
    ).toEqual(["superMro"]);
  });

  it("treats missing facts as no information rather than as evidence", () => {
    expect(categorizePySite(undefined, { receiver: "x", member: "f" })).toEqual(
      ["plain"],
    );
  });
});

describe("tallyPyRows", () => {
  it("excludes degraded rows from mismatchRate but keeps them in sites", () => {
    const tallies = tallyPyRows(
      [
        row({ verdict: "missed", receiverKind: "localVar" }),
        row({
          verdict: "missed",
          receiverKind: "localVar",
          oracleDegraded: true,
        }),
        row({ verdict: "match", receiverKind: "localVar" }),
      ],
      (r) => [r.receiverKind],
    );
    const localVar = tallies.find((t) => t.label === "localVar");
    expect(localVar?.sites).toBe(3);
    expect(localVar?.oracle).toBe(2);
    expect(localVar?.mismatchRate).toBeCloseTo(0.5, 10);
  });

  it("gives degraded rows their own label so the loss is readable", () => {
    const tallies = tallyPyRows([row({ oracleDegraded: true })], (r) =>
      r.oracleDegraded ? ["oracleDegraded"] : [],
    );
    expect(tallies.find((t) => t.label === "oracleDegraded")?.sites).toBe(1);
  });

  it("sorts by site count descending, then by label", () => {
    const tallies = tallyPyRows(
      [
        row({ receiverKind: "bareCall" }),
        row({ receiverKind: "chain" }),
        row({ receiverKind: "chain" }),
      ],
      (r) => [r.receiverKind],
    );
    expect(tallies.map((t) => t.label)).toEqual(["chain", "bareCall"]);
  });
});

describe("samplePyRows", () => {
  it("is stable for one seed and different for another", () => {
    const rows = Array.from({ length: 200 }, (_, i) =>
      row({ startLine: i, verdict: "missed" }),
    );
    const a = samplePyRows(rows, "missed", 5, 42).map((r) => r.startLine);
    expect(samplePyRows(rows, "missed", 5, 42).map((r) => r.startLine)).toEqual(
      a,
    );
    expect(
      samplePyRows(rows, "missed", 5, 43).map((r) => r.startLine),
    ).not.toEqual(a);
  });

  it("does NOT return the first N — first-N samples the corpus's directory order", () => {
    const rows = Array.from({ length: 200 }, (_, i) =>
      row({ startLine: i, verdict: "missed" }),
    );
    expect(
      samplePyRows(rows, "missed", 5, 7).map((r) => r.startLine),
    ).not.toEqual([0, 1, 2, 3, 4]);
  });

  it("returns every row when the corpus has fewer than requested", () => {
    expect(
      samplePyRows([row({ verdict: "phantom" })], "phantom", 25, 1),
    ).toHaveLength(1);
  });

  it("selects only the asked-for verdict", () => {
    const rows = [row({ verdict: "missed" }), row({ verdict: "match" })];
    expect(
      samplePyRows(rows, "missed", 10, 1).every((r) => r.verdict === "missed"),
    ).toBe(true);
  });
});

describe("mulberry32", () => {
  it("produces the same stream for the same seed", () => {
    const draw = (seed: number) => Array.from({ length: 4 }, mulberry32(seed));
    expect(draw(1)).toEqual(draw(1));
    expect(draw(1)).not.toEqual(draw(2));
  });
});
```

- [ ] Run and watch every case fail:
      `npx vitest run tests/scripts/py-oracle-core.test.ts`.

- [ ] Write `scripts/lib/py-oracle-core.ts`:

```ts
/**
 * Pure core for the Python codegraph oracle (bd tea-rags-mcp-mmckn).
 *
 * The shared verdicts, the diff and the tally come from
 * `ts-codegraph-typechecker-oracle.ts` by IMPORT — its `main` is guarded by
 * `import.meta.url === file://argv[1]`, so importing the module runs nothing and
 * there is no reason to relocate or copy it. What lives here is only what
 * Python adds: two extra verdicts, an origin vocabulary with a venv in it, the
 * missed-shape categories, degraded-row handling, and seeded sampling.
 *
 * Everything is a pure function over in-memory values. The harness owns the
 * corpus, the subprocess and the clock.
 */
import {
  diffResolution,
  tallyBy,
  type OracleAnswer,
  type OracleOutcome,
  type OracleTally,
  type OracleVerdict,
} from "../ts-codegraph-typechecker-oracle.js";

export type PyOracleVerdict =
  | OracleVerdict
  | "skippedInProject"
  | "parseFailed";

export type PyTargetOrigin =
  | "project"
  | "generatedInRepo"
  | "sitePackages"
  | "stdlib"
  | "builtin"
  | "typeshedStub"
  | "outsideRepo";

export const PY_MISSED_CATEGORIES = [
  "annotationParam",
  "annotationReturn",
  "reexport",
  "starImport",
  "superMro",
  "decoratorProperty",
  "managerQuerySet",
  "dependsInjection",
  "unionReceiver",
  "plain",
] as const;
export type PyMissedCategory = (typeof PY_MISSED_CATEGORIES)[number];

export const PY_UNLOCATED_SHAPES = [
  "decoratorBare",
  "multiLineCall",
  "subscriptCall",
  "coordinateMiss",
] as const;
export type PyUnlocatedShape = (typeof PY_UNLOCATED_SHAPES)[number];

export interface PySiteFacts {
  receiverIsAnnotatedParam: boolean;
  enclosingHasReturnAnnotation: boolean;
  viaReexport: boolean;
  viaStarImport: boolean;
  isSuperCall: boolean;
  targetIsProperty: boolean;
  targetIsStaticOrClassMethod: boolean;
  receiverIsUnion: boolean;
  isDecoratorSite: boolean;
}

export interface PyOracleRow {
  relPath: string;
  startLine: number;
  callText: string;
  receiver: string | null;
  member: string;
  receiverKind: string;
  categories: PyMissedCategory[];
  verdict: PyOracleVerdict;
  answeredBy: string;
  chainOutput: "pinned" | "fileOnly" | "none";
  chain?: OracleAnswer;
  origin?: PyTargetOrigin;
  oracleDegraded: boolean;
  unlocatedShape?: PyUnlocatedShape;
}

/**
 * One call site's verdict.
 *
 * `parseFailed` wins outright: with no AST there is no ground truth, and any
 * other bucket would be an opinion about a file nobody read. `skippedInProject`
 * is the classifier's own precision defect — it declared the site external and
 * jedi found the definition inside the project — and it is kept OUT of `missed`
 * because the two point at different fixes: `missed` asks for a strategy,
 * `skippedInProject` asks for a narrower vocabulary.
 */
export function classifyPyVerdict(input: {
  chain: OracleAnswer | null;
  oracle: OracleOutcome;
  parseFailed: boolean;
  classifiedExternal: boolean;
}): PyOracleVerdict {
  if (input.parseFailed) return "parseFailed";
  if (input.classifiedExternal && input.oracle.kind === "inProject")
    return "skippedInProject";
  return diffResolution(input.chain, input.oracle);
}

const MANAGER_RECEIVER_RE = /(^|\.)(objects|_default_manager|query|session)$/;
const QUERYSET_MEMBERS = new Set([
  "all",
  "filter",
  "exclude",
  "get",
  "annotate",
  "values",
  "first",
  "last",
  "count",
]);
const INJECTION_MEMBERS = new Set(["Depends", "Security", "Provide", "inject"]);

/**
 * Which shapes a site exercises. A site can carry several: the axis overlaps by
 * construction — an annotated parameter can also be a union — and forcing a
 * precedence would attribute a site to whichever fact happened to be tested
 * first. `plain` is the residual and never appears beside another category.
 */
export function categorizePySite(
  facts: PySiteFacts | undefined,
  row: { receiver: string | null; member: string },
): PyMissedCategory[] {
  const found = new Set<PyMissedCategory>();
  if (facts?.receiverIsAnnotatedParam === true) found.add("annotationParam");
  if (facts?.enclosingHasReturnAnnotation === true)
    found.add("annotationReturn");
  if (facts?.viaReexport === true) found.add("reexport");
  if (facts?.viaStarImport === true) found.add("starImport");
  if (facts?.isSuperCall === true) found.add("superMro");
  if (
    facts?.targetIsProperty === true ||
    facts?.targetIsStaticOrClassMethod === true
  )
    found.add("decoratorProperty");
  if (facts?.receiverIsUnion === true) found.add("unionReceiver");
  const receiver = row.receiver ?? "";
  if (MANAGER_RECEIVER_RE.test(receiver) && QUERYSET_MEMBERS.has(row.member))
    found.add("managerQuerySet");
  if (INJECTION_MEMBERS.has(row.member)) found.add("dependsInjection");
  return found.size === 0 ? ["plain"] : [...found].sort();
}
```

- [ ] Append the tally and sampling half to the same file:

```ts
/**
 * Aggregate rows under every label they carry.
 *
 * Degraded rows are counted in `sites` and then withheld from the rate
 * denominators. Dropping them would hide how much of a corpus jedi could not
 * read (polar: ~7.6% of files); counting them would let a stale parso grammar
 * masquerade as a resolver defect. Both failures were possible before this
 * split, and the second is the one that would have been believed.
 */
export function tallyPyRows(
  rows: readonly PyOracleRow[],
  labelsOf: (row: PyOracleRow) => readonly string[],
): OracleTally[] {
  const scored = rows.filter(
    (row) => !row.oracleDegraded && row.verdict !== "parseFailed",
  );
  const shared = tallyBy(
    scored.map((row) => ({
      relPath: row.relPath,
      startLine: row.startLine,
      callText: row.callText,
      receiverKind: row.receiverKind,
      categories: [...row.categories],
      // `skippedInProject` is a MISS the classifier caused; it belongs in the
      // recall numerator so a vocabulary that over-claims cannot buy a better
      // rate by moving sites out of `missed`.
      verdict:
        row.verdict === "skippedInProject"
          ? "missed"
          : (row.verdict as OracleVerdict),
      chainOutput: row.chainOutput,
    })),
    (mapped) => labelsOf(rows[scored.indexOf(mapped as never)] ?? rows[0]),
  );

  // Sites the shared tally never saw still need their count, or the report's
  // `sites` column stops summing to the corpus.
  const bySite = new Map(shared.map((tally) => [tally.label, tally]));
  for (const row of rows) {
    if (!row.oracleDegraded && row.verdict !== "parseFailed") continue;
    for (const label of labelsOf(row)) {
      const tally = bySite.get(label);
      if (tally === undefined) continue;
      tally.sites += 1;
    }
  }
  return [...bySite.values()].sort(
    (a, b) => b.sites - a.sites || a.label.localeCompare(b.label),
  );
}

/** Deterministic PRNG — the seed is a CLI flag so a sample can be reproduced. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `count` rows of one verdict, drawn at random rather than taken from the
 * front. First-N samples the corpus's directory order, which on every corpus
 * here means one package answering for the whole repo — the TS oracle's header
 * records the same lesson.
 */
export function samplePyRows(
  rows: readonly PyOracleRow[],
  verdict: PyOracleVerdict,
  count: number,
  seed: number,
): PyOracleRow[] {
  const pool = rows.filter((row) => row.verdict === verdict);
  if (pool.length <= count) return [...pool];
  const random = mulberry32(seed);
  const indexes = pool.map((_, index) => index);
  // Fisher-Yates over the INDEX list, so the draw depends only on the seed and
  // the pool size — not on row contents, which differ between corpora.
  for (let i = indexes.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [indexes[i], indexes[j]] = [indexes[j] as number, indexes[i] as number];
  }
  return indexes
    .slice(0, count)
    .sort((a, b) => a - b)
    .map((index) => pool[index] as PyOracleRow);
}
```

- [ ] Simplify `tallyPyRows` if the `indexOf` bridge above survives review — it
      is O(n²) and exists only to reuse `tallyBy`'s label callback. Prefer
      mapping each row to a `{ row, mapped }` pair and passing
      `(mapped) => labelsOf(pairs.get(mapped)!.row)` with a `WeakMap`. The
      behaviour asserted by the tests is what matters; the bridge is not.

- [ ] Run the pure-core tests until green:
      `npx vitest run tests/scripts/py-oracle-core.test.ts`.

- [ ] Write `scripts/py-codegraph-jedi-oracle.ts`, first half — corpus parity,
      the rebuilt chain, and the `answeredBy` probe:

```ts
/**
 * Python codegraph oracle — the production chain diffed against jedi, call site
 * by call site (bd tea-rags-mcp-mmckn).
 *
 * Same mechanism as `ts-codegraph-typechecker-oracle.ts`, with the ground truth
 * moved out of process: TypeScript has `ts.TypeChecker` in-process, Python has
 * jedi behind `uv`. The walk, the exclusion layers, the diff and the tally are
 * IMPORTED from the TS oracle rather than reimplemented — a second copy of the
 * corpus-selection rules is exactly how the TS harness came to score 1,344
 * generated files it had no business scoring.
 *
 * Usage:
 *   npx tsx scripts/py-codegraph-jedi-oracle.ts --corpus <abs path> \
 *     [--python <interpreter running jedi>] [--environment <corpus venv>] \
 *     [--limit N] [--samples N] [--seed N] [--json out.json] [--quiet]
 *
 * `--corpus` may also be a manifest NAME (`netbox`), in which case the root and
 * the venv interpreter come from `scripts/lib/codegraph-corpora.json`.
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { extname, join, resolve as resolvePath } from "node:path";
import { createInterface } from "node:readline";

import Parser from "tree-sitter";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
} from "../src/core/contracts/types/codegraph.js";
import type {
  SymbolResolutionOutcome,
  SymbolResolutionStrategy,
} from "../src/core/contracts/types/language.js";
import {
  DefaultSymbolIdComposer,
  LanguageFactory,
} from "../src/core/domains/language/index.js";
import {
  CONE_MAX_DEFAULT,
  PythonGlobalShortNameSymbolResolutionStrategy,
  PythonImportMatchSymbolResolutionStrategy,
  PythonLocalBindingSymbolResolutionStrategy,
  PythonSelfFieldSymbolResolutionStrategy,
  PythonSelfMemberSymbolResolutionStrategy,
  PythonSuperSymbolResolutionStrategy,
} from "../src/core/domains/language/python/resolver/strategies/index.js";
import { resolveViaChain } from "../src/core/domains/language/resolver-chain.js";
import { classifyReceiverKind } from "../src/core/domains/trajectory/codegraph/symbols/receiver-kind.js";
import { InMemoryGlobalSymbolTable } from "../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { loadCodegraphCorpora } from "./lib/codegraph-corpora.js";
import {
  categorizePySite,
  classifyPyVerdict,
  samplePyRows,
  tallyPyRows,
  type PyOracleRow,
  type PySiteFacts,
  type PyTargetOrigin,
  type PyUnlocatedShape,
} from "./lib/py-oracle-core.js";
import {
  buildCorpusExclusionFilter,
  buildSymbolDefs,
  collectSourceFiles,
  extractFile,
  formatOracleTable,
} from "./ts-codegraph-typechecker-oracle.js";

/**
 * Wrap one pass so the harness learns WHICH pass answered, without touching
 * production. Precedent: `DeferFileOnlyStrategy` in `codegraph-chain-tally.ts`.
 * Every outcome passes through untouched — the probe only records.
 */
export class AnsweredByProbe implements SymbolResolutionStrategy {
  readonly name: string;
  constructor(
    private readonly inner: SymbolResolutionStrategy,
    private readonly record: { answeredBy: string },
  ) {
    this.name = inner.name;
  }

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const outcome = this.inner.attempt(call, ctx);
    if (outcome.kind === "resolved") this.record.answeredBy = this.inner.name;
    return outcome;
  }
}

/** The Python chain, in `PythonCallResolver`'s order. Mirrors `CHAINS.python`. */
export function buildPythonChain(): SymbolResolutionStrategy[] {
  const cfg = {
    mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE,
    coneMax: CONE_MAX_DEFAULT,
  };
  return [
    new PythonSuperSymbolResolutionStrategy(cfg),
    new PythonSelfFieldSymbolResolutionStrategy(cfg),
    new PythonSelfMemberSymbolResolutionStrategy(cfg),
    new PythonLocalBindingSymbolResolutionStrategy(cfg),
    new PythonImportMatchSymbolResolutionStrategy(cfg),
    new PythonGlobalShortNameSymbolResolutionStrategy(cfg),
  ];
}
```

- [ ] Continue the same file — the two-pass corpus walk and the runner's own
      miss order, reproduced verbatim:

```ts
const SCORED_EXTENSION = ".py";

export interface PyChainSite {
  relPath: string;
  call: CallRef;
  ctx: CallContext;
  receiverKind: string;
  chain: { targetRelPath: string; targetSymbolId: string | null } | null;
  answeredBy: string;
  /**
   * The runner's OWN verdict on a declined call, reproduced in the runner's
   * order (`resolution-runner.ts:518-560`): `dynamicSend` → `targetsExternalImport`
   * → "no in-project definition for this short name" → `targetsCoreAmbiguousMember`.
   * The plain "external" shorthand skips two branches, and skipping them would
   * attribute `noInProjectDef` sites to the vocabulary that did not claim them.
   */
  missBucket:
    | "resolved"
    | "dynamicSend"
    | "external"
    | "noInProjectDef"
    | "coreAmbiguous"
    | "miss";
}

/**
 * Walk the corpus exactly as production selects files, build ONE symbol table
 * over every `CODEGRAPH_LANGUAGES` extension, then resolve only `.py` call
 * sites. netbox ships JavaScript, and leaving it out of the table would make
 * every call into it look like a resolver miss (the TS harness's `.js` blind
 * spot, same shape, other language).
 */
export async function walkCorpus(
  corpusRoot: string,
  limit: number,
  quiet: boolean,
): Promise<{
  sites: PyChainSite[];
  files: number;
  symbolTableOnlyFiles: number;
  parseFailures: number;
  ingestIgnored: number;
  codegraphExcluded: number;
  chainDrift: number;
}> {
  const factory = new LanguageFactory();
  const composer = new DefaultSymbolIdComposer();
  const exclude = await buildCorpusExclusionFilter(corpusRoot, factory);
  const selection = await collectSourceFiles(corpusRoot, corpusRoot, exclude);

  const symbolTable = new InMemoryGlobalSymbolTable();
  const classExtends: Record<string, string> = {};
  const extractions: {
    relPath: string;
    extraction: ReturnType<typeof extractFile>;
  }[] = [];
  let parseFailures = 0;
  let symbolTableOnlyFiles = 0;

  for (const relPath of selection.kept.slice(0, limit)) {
    const extraction = extractFile(corpusRoot, relPath, composer, factory);
    if (extraction === null) {
      parseFailures++;
      continue;
    }
    symbolTable.upsertFile(relPath, buildSymbolDefs(extraction));
    Object.assign(classExtends, extraction.classExtends ?? {});
    if (extname(relPath) === SCORED_EXTENSION)
      extractions.push({ relPath, extraction });
    else symbolTableOnlyFiles++;
  }
  if (!quiet)
    process.stderr.write(
      `pass 1: ${extractions.length} python files, ${symbolTable.size()} symbols\n`,
    );

  const production = factory.create("python").resolver;
  if (!production)
    throw new Error("the python language provider has no resolver");
  const sites: PyChainSite[] = [];
  let chainDrift = 0;

  for (const { relPath, extraction } of extractions) {
    if (extraction === null) continue;
    for (const chunk of extraction.chunks) {
      const ctx: CallContext = {
        callerFile: relPath,
        callerScope: chunk.scope,
        callerSymbolId: chunk.symbolId,
        imports: extraction.imports,
        symbolTable,
        classFieldTypes: extraction.classFieldTypes,
        localBindings: chunk.localBindings,
        classExtends,
      };
      for (const call of chunk.calls ?? []) {
        if (call.dispatch !== undefined) continue; // the runner skips normal resolution here
        const probe = { answeredBy: "none" };
        const chain = resolveViaChain(
          buildPythonChain().map((pass) => new AnsweredByProbe(pass, probe)),
          call,
          ctx,
        );
        const truth = production.resolve(call, ctx);
        const same =
          (chain === null && truth === null) ||
          (chain !== null &&
            truth !== null &&
            chain.targetRelPath === truth.targetRelPath &&
            chain.targetSymbolId === truth.targetSymbolId);
        if (!same) chainDrift++;
        sites.push({
          relPath,
          call,
          ctx,
          receiverKind: classifyReceiverKind(call, chunk.localBindings),
          chain:
            chain === null
              ? null
              : {
                  targetRelPath: chain.targetRelPath,
                  targetSymbolId: chain.targetSymbolId,
                },
          answeredBy: probe.answeredBy,
          missBucket:
            chain !== null
              ? "resolved"
              : call.dynamicSend === true
                ? "dynamicSend"
                : (production.targetsExternalImport?.(call, ctx) ?? false)
                  ? "external"
                  : symbolTable.lookupByShortName(call.member).length === 0
                    ? "noInProjectDef"
                    : (production.targetsCoreAmbiguousMember?.(call, ctx) ??
                        false)
                      ? "coreAmbiguous"
                      : "miss",
        });
      }
    }
  }

  return {
    sites,
    files: extractions.length,
    symbolTableOnlyFiles,
    parseFailures,
    ingestIgnored: selection.ingestIgnored,
    codegraphExcluded: selection.codegraphExcluded,
    chainDrift,
  };
}
```

- [ ] Continue the same file — the subprocess protocol, the row assembly and the
      CLI:

```ts
export interface PyOracleAnswer {
  startLine: number;
  member: string;
  outcome: {
    kind: "inProject" | "external" | "unknown" | "parseFailed";
    origin?: PyTargetOrigin;
    targets?: {
      relPath: string;
      symbolId: string | null;
      pinUncertain: boolean;
    }[];
  };
  siteFacts?: PySiteFacts;
  unlocated?: PyUnlocatedShape;
}

export interface PyOracleFileReply {
  relPath: string;
  parseFailed: boolean;
  parsoErrors: number;
  answers: PyOracleAnswer[];
}

/**
 * Ask the Python side about every site, one spawn per corpus.
 *
 * NDJSON over pipes rather than a temp file: the input for polar is ~30 MB and
 * a temp file would need cleanup on every failure path. The child never sees
 * the chain's answer — only `(relPath, startLine, callText, receiver, member)`
 * — so it cannot be tuned toward agreement.
 */
export async function askOracle(
  sites: readonly PyChainSite[],
  options: {
    corpusRoot: string;
    python: string[];
    venvPython: string | null;
    workers: number;
  },
): Promise<Map<string, PyOracleFileReply>> {
  const byFile = new Map<string, PyChainSite[]>();
  for (const site of sites) {
    const bucket = byFile.get(site.relPath);
    if (bucket) bucket.push(site);
    else byFile.set(site.relPath, [site]);
  }

  const child = spawn(options.python[0] as string, options.python.slice(1), {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const replies = new Map<string, PyOracleFileReply>();
  const reader = createInterface({ input: child.stdout });
  const done = new Promise<void>((resolveDone, rejectDone) => {
    reader.on("line", (line) => {
      if (line.trim() === "") return;
      const reply = JSON.parse(line) as PyOracleFileReply;
      replies.set(reply.relPath, reply);
    });
    child.on("error", rejectDone);
    child.on("close", (code) =>
      code === 0
        ? resolveDone()
        : rejectDone(new Error(`jedi_oracle.py exited ${String(code)}`)),
    );
  });

  child.stdin.write(
    `${JSON.stringify({ kind: "config", corpusRoot: options.corpusRoot, venvPython: options.venvPython, workers: options.workers })}\n`,
  );
  for (const relPath of [...byFile.keys()].sort()) {
    const batch = (byFile.get(relPath) ?? []).map((site) => ({
      startLine: site.call.startLine,
      callText: site.call.callText,
      receiver: site.call.receiver,
      member: site.call.member,
    }));
    child.stdin.write(
      `${JSON.stringify({ kind: "file", relPath, sites: batch })}\n`,
    );
  }
  child.stdin.end();
  await done;
  return replies;
}

/** Join the two answers into scored rows. Pure given its inputs. */
export function buildRows(
  sites: readonly PyChainSite[],
  replies: Map<string, PyOracleFileReply>,
): PyOracleRow[] {
  const rows: PyOracleRow[] = [];
  const cursor = new Map<string, number>();
  for (const site of sites) {
    const reply = replies.get(site.relPath);
    const index = cursor.get(site.relPath) ?? 0;
    cursor.set(site.relPath, index + 1);
    const answer = reply?.answers[index];
    const targets = answer?.outcome.targets ?? [];
    const oracle =
      answer === undefined ||
      answer.outcome.kind === "unknown" ||
      answer.outcome.kind === "parseFailed"
        ? ({ kind: "unknown" } as const)
        : answer.outcome.kind === "external"
          ? ({ kind: "external" } as const)
          : ({
              kind: "inProject",
              answer: {
                targetRelPath: targets[0]?.relPath ?? "",
                // A `pinUncertain` target compares at FILE granularity only —
                // matching a null symbol id here degrades the verdict to
                // `fileOnly` rather than manufacturing a `wrongFile`.
                targetSymbolId:
                  targets[0]?.pinUncertain === true
                    ? (site.chain?.targetSymbolId ?? null)
                    : (targets[0]?.symbolId ?? null),
              },
            } as const);
    rows.push({
      relPath: site.relPath,
      startLine: site.call.startLine,
      callText: site.call.callText,
      receiver: site.call.receiver,
      member: site.call.member,
      receiverKind: site.receiverKind,
      categories: categorizePySite(answer?.siteFacts, {
        receiver: site.call.receiver,
        member: site.call.member,
      }),
      verdict: classifyPyVerdict({
        chain: site.chain,
        oracle,
        parseFailed: reply?.parseFailed === true,
        classifiedExternal:
          site.missBucket === "external" || site.missBucket === "coreAmbiguous",
      }),
      answeredBy: site.answeredBy,
      chainOutput:
        site.chain === null
          ? "none"
          : site.chain.targetSymbolId === null
            ? "fileOnly"
            : "pinned",
      chain: site.chain ?? undefined,
      origin: answer?.outcome.origin,
      oracleDegraded: (reply?.parsoErrors ?? 0) > 0,
      unlocatedShape: answer?.unlocated,
    });
  }
  return rows;
}
```

- [ ] Finish the file with the CLI and the report:

```ts
export interface PyOracleCliOptions {
  corpusRoot: string;
  corpusName: string;
  venvPython: string | null;
  pythonArgv: string[];
  limit: number;
  samples: number;
  seed: number;
  workers: number;
  json: string | null;
  quiet: boolean;
}

export function parseArgs(argv: readonly string[]): PyOracleCliOptions {
  const read = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const corpusArg = read("--corpus") ?? process.cwd();
  const manifest = loadCodegraphCorpora()[corpusArg];
  const interpreter =
    read("--python") ?? manifest?.requiresPython.replace(">=", "") ?? "3.13";
  return {
    corpusRoot: manifest ? manifest.path : resolvePath(corpusArg),
    corpusName: manifest?.name ?? corpusArg,
    venvPython: read("--environment") ?? manifest?.venvPython ?? null,
    // `uv run --no-project` keeps jedi's environment out of the corpus's, which
    // is what lets one oracle build serve three interpreter versions.
    pythonArgv: [
      "uv",
      "run",
      "--no-project",
      "--python",
      interpreter,
      "--with",
      "jedi==0.20.0",
      "python",
      join(import.meta.dirname, "py-oracle", "jedi_oracle.py"),
    ],
    limit: Number(read("--limit") ?? Number.MAX_SAFE_INTEGER),
    samples: Number(read("--samples") ?? 25),
    seed: Number(read("--seed") ?? 20260908),
    workers: Number(read("--workers") ?? 8),
    json: read("--json") ?? null,
    quiet: argv.includes("--quiet"),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const walk = await walkCorpus(
    options.corpusRoot,
    options.limit,
    options.quiet,
  );
  const replies = await askOracle(walk.sites, {
    corpusRoot: options.corpusRoot,
    python: options.pythonArgv,
    venvPython: options.venvPython,
    workers: options.workers,
  });
  const rows = buildRows(walk.sites, replies);

  const byReceiver = tallyPyRows(rows, (row) => [row.receiverKind]);
  const byAnsweredBy = tallyPyRows(rows, (row) => [row.answeredBy]);
  const byCategory = tallyPyRows(rows, (row) => row.categories);
  const degraded = rows.filter((row) => row.oracleDegraded).length;
  const unknown = rows.filter(
    (row) => row.verdict === "chainOnly" || row.verdict === "bothUnresolved",
  ).length;
  const covered = rows.length - unknown;

  const out = [
    "",
    `Python codegraph jedi oracle — ${options.corpusName} @ ${options.corpusRoot}`,
    `files ${walk.files} scored (+${walk.symbolTableOnlyFiles} in the symbol table, parse failures ${walk.parseFailures})`,
    `excluded as production excludes them: ${walk.ingestIgnored} by .gitignore and friends · ${walk.codegraphExcluded} generated/test/non-app`,
    `call sites ${rows.length} · chain drift ${walk.chainDrift}${walk.chainDrift === 0 ? "" : "  <- REBUILD IS STALE, numbers void"}`,
    `ground truth ${covered}/${rows.length} (${((covered / Math.max(rows.length, 1)) * 100).toFixed(1)}%) · oracleDegraded ${degraded} · parseFailed ${rows.filter((r) => r.verdict === "parseFailed").length}`,
    `elapsed ${((Date.now() - started) / 1000).toFixed(1)}s`,
    "",
    formatOracleTable(
      "BY RECEIVER KIND (partition — each call site counted once)",
      byReceiver,
    ),
    "",
    formatOracleTable(
      "BY ANSWERING PASS (partition — 'none' is the declined set)",
      byAnsweredBy,
    ),
    "",
    formatOracleTable(
      "BY MISSED-SHAPE CATEGORY (rows overlap — a site can carry several)",
      byCategory,
    ),
    "",
  ];
  process.stdout.write(out.join("\n"));

  if (options.json !== null) {
    const payload = {
      corpus: options.corpusName,
      corpusRoot: options.corpusRoot,
      seed: options.seed,
      counters: { ...walk, sites: undefined },
      byReceiver,
      byAnsweredBy,
      byCategory,
      samples: Object.fromEntries(
        (["missed", "wrongFile", "phantom", "skippedInProject"] as const).map(
          (verdict) => [
            verdict,
            samplePyRows(rows, verdict, options.samples, options.seed),
          ],
        ),
      ),
    };
    writeFileSync(options.json, `${JSON.stringify(payload, null, 2)}\n`);
    process.stderr.write(`wrote ${options.json}\n`);
  }
  if (walk.chainDrift !== 0) process.exitCode = 1;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`
) {
  main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
```

- [ ] Guard `main` exactly as the TS oracle does, and prove it — the whole
      import-not-relocate decision rests on that pattern, so the new harness
      must not break it for its own importers:

```bash
npx tsx -e "import('./scripts/py-codegraph-jedi-oracle.ts').then(m => console.log(Object.keys(m).length))"
```

- [ ] Write `tests/scripts/py-codegraph-jedi-oracle.test.ts` — the host's own
      units, no corpus and no subprocess:

```ts
/**
 * Host-side units for the Python oracle (bd tea-rags-mcp-mmckn). The corpus
 * walk and the subprocess are exercised by the smoke run on httpx, not here:
 * a mocked jedi would assert the mock.
 */
import { describe, expect, it } from "vitest";

import {
  AnsweredByProbe,
  buildPythonChain,
  buildRows,
  parseArgs,
} from "../../scripts/py-codegraph-jedi-oracle.js";
import type {
  CallContext,
  CallRef,
} from "../../src/core/contracts/types/codegraph.js";
import type {
  SymbolResolutionOutcome,
  SymbolResolutionStrategy,
} from "../../src/core/contracts/types/language.js";

const call = (member: string): CallRef => ({
  callText: `${member}()`,
  receiver: null,
  member,
  startLine: 1,
});
const ctx = {} as CallContext;

class FixedStrategy implements SymbolResolutionStrategy {
  constructor(
    readonly name: string,
    private readonly outcome: SymbolResolutionOutcome,
  ) {}
  attempt(): SymbolResolutionOutcome {
    return this.outcome;
  }
}

describe("buildPythonChain", () => {
  it("mirrors PythonCallResolver's order exactly — drift here voids every number", () => {
    expect(buildPythonChain().map((pass) => pass.name)).toEqual([
      "super",
      "selfField",
      "selfMember",
      "localBinding",
      "importMatch",
      "globalShortName",
    ]);
  });
});

describe("AnsweredByProbe", () => {
  it("records the pass that resolved and returns the outcome untouched", () => {
    const record = { answeredBy: "none" };
    const resolved: SymbolResolutionOutcome = {
      kind: "resolved",
      target: { targetRelPath: "pkg/a.py", targetSymbolId: "A#f" },
    };
    const probe = new AnsweredByProbe(
      new FixedStrategy("localBinding", resolved),
      record,
    );
    expect(probe.attempt(call("f"), ctx)).toBe(resolved);
    expect(record.answeredBy).toBe("localBinding");
  });

  it("leaves the record alone when the pass continues", () => {
    const record = { answeredBy: "none" };
    const probe = new AnsweredByProbe(
      new FixedStrategy("importMatch", { kind: "continue" }),
      record,
    );
    probe.attempt(call("f"), ctx);
    expect(record.answeredBy).toBe("none");
  });

  it("keeps the wrapped pass's own name so the tally labels match production", () => {
    expect(
      new AnsweredByProbe(new FixedStrategy("super", { kind: "continue" }), {
        answeredBy: "none",
      }).name,
    ).toBe("super");
  });
});

describe("parseArgs", () => {
  it("resolves a manifest NAME to its root and its provisioned interpreter", () => {
    const options = parseArgs(["--corpus", "netbox"]);
    expect(options.corpusName).toBe("netbox");
    expect(options.corpusRoot.endsWith("/corpora/netbox")).toBe(true);
    expect(options.venvPython?.endsWith("/venvs/netbox/bin/python")).toBe(true);
  });

  it("treats an unknown --corpus as a path and takes no interpreter from it", () => {
    const options = parseArgs(["--corpus", "/tmp/whatever"]);
    expect(options.corpusRoot).toBe("/tmp/whatever");
    expect(options.venvPython).toBeNull();
  });

  it("lets an explicit --environment win over the manifest", () => {
    expect(
      parseArgs(["--corpus", "polar", "--environment", "/tmp/py"]).venvPython,
    ).toBe("/tmp/py");
  });

  it("defaults the seed so two runs sample identically", () => {
    expect(parseArgs([]).seed).toBe(parseArgs([]).seed);
  });
});

describe("buildRows", () => {
  const site = (overrides: Record<string, unknown> = {}) =>
    ({
      relPath: "pkg/a.py",
      call: call("f"),
      ctx,
      receiverKind: "bareCall",
      chain: null,
      answeredBy: "none",
      missBucket: "miss",
      ...overrides,
    }) as never;

  it("marks every row of a parso-damaged file degraded", () => {
    const rows = buildRows(
      [site()],
      new Map([
        [
          "pkg/a.py",
          {
            relPath: "pkg/a.py",
            parseFailed: false,
            parsoErrors: 3,
            answers: [],
          },
        ],
      ]),
    );
    expect(rows[0]?.oracleDegraded).toBe(true);
  });

  it("scores a classifier-external site with in-project truth as skippedInProject", () => {
    const rows = buildRows(
      [site({ missBucket: "external" })],
      new Map([
        [
          "pkg/a.py",
          {
            relPath: "pkg/a.py",
            parseFailed: false,
            parsoErrors: 0,
            answers: [
              {
                startLine: 1,
                member: "f",
                outcome: {
                  kind: "inProject" as const,
                  origin: "project" as const,
                  targets: [
                    {
                      relPath: "pkg/b.py",
                      symbolId: "B#f",
                      pinUncertain: false,
                    },
                  ],
                },
              },
            ],
          },
        ],
      ]),
    );
    expect(rows[0]?.verdict).toBe("skippedInProject");
  });

  it("gives a site with no reply an unknown verdict rather than inventing one", () => {
    expect(buildRows([site()], new Map())[0]?.verdict).toBe("bothUnresolved");
  });
});
```

- [ ] Smoke the whole harness on httpx — 23 files, seconds, and the only place
      the two processes meet before the baseline run:

```bash
npx tsx scripts/py-codegraph-jedi-oracle.ts --corpus httpx --json /tmp/httpx-oracle.json
```

      Three things must hold before going further, and each has a specific
      failure meaning:

      1. `chain drift 0`. Non-zero means `buildPythonChain` no longer mirrors
         `PythonCallResolver` — fix the rebuild, do not report the numbers.
      2. The chain-output totals in the run agree with the recorded httpx
         baseline (1011 edges, 193 file-only, 1632 unresolved). A gap means the
         corpus-parity walk selected a different file set than
         `codegraph-chain-tally.ts` did, which is a harness bug and not a
         resolver fact.
      3. Ground-truth coverage is reported, not assumed. httpx is 100%
         annotated, so a low coverage number here means the oracle is failing
         to locate nodes, and `unlocatedShape` says which shape.

- [ ] Check determinism before anything downstream reads a number:

```bash
npx tsx scripts/py-codegraph-jedi-oracle.ts --corpus httpx --json /tmp/httpx-1.json --quiet
npx tsx scripts/py-codegraph-jedi-oracle.ts --corpus httpx --json /tmp/httpx-2.json --quiet
diff /tmp/httpx-1.json /tmp/httpx-2.json && echo DETERMINISTIC
```

- [ ] Run the perf gate. The harness must not have slowed the chain down — it
      imports production, it does not change it:

```bash
/usr/bin/time -l npx tsx scripts/codegraph-chain-tally.ts \
  --corpus ~/Dev/Tools/tea-rags-bench/corpora/httpx --lang python --quiet
```

- [ ] Confirm the Ruby tree is untouched:
      `git diff --stat -- src/core/domains/language/ruby tests/core/domains/language/ruby`
      prints nothing.

- [ ] Format and commit:

```bash
npx prettier --write scripts/lib/py-oracle-core.ts scripts/py-codegraph-jedi-oracle.ts \
  tests/scripts/py-oracle-core.test.ts tests/scripts/py-codegraph-jedi-oracle.test.ts
git add scripts/lib/py-oracle-core.ts scripts/py-codegraph-jedi-oracle.ts \
  tests/scripts/py-oracle-core.test.ts tests/scripts/py-codegraph-jedi-oracle.test.ts
git commit -m "feat(scripts): diff the Python chain against jedi per call site (mmckn)"
```

---

## Task 4: the baseline — five corpora, twice each, and the pull order

**Files**

- Create `~/Dev/Tools/tea-rags-bench/results/python/2026-09-08-<corpus>.json`
  (regenerable, NOT versioned in this repo)
- Modify
  `docs/superpowers/specs/2026-09-03-python-codegraph-e0-measurement-design.md`
  (append the baseline appendix)

**Interfaces**

_Consumes_ — `scripts/py-codegraph-jedi-oracle.ts` from Task 3 and the manifest
from Task 1. No new code is written in this task; if a defect surfaces, it is
fixed in the file that owns it and the affected corpora are re-run.

_Produces_ — one JSON per corpus plus five tables appended to the spec:
`receiverKind × verdict`, `answeredBy × verdict`, category ranking, ground-truth
coverage, and the precision floor (`phantom` + `skippedInProject`) that E1 and
E2 gates compare against.

**Steps**

- [ ] Prepare the worktree: `npm ci`, then a bare `npm run build`. Create the
      results directory: `mkdir -p ~/Dev/Tools/tea-rags-bench/results/python`.

- [ ] Run the three fast corpora first, in this order, so a harness defect
      surfaces on the cheap ones. Each is a foreground command of seconds to a
      couple of minutes:

```bash
npx tsx scripts/py-codegraph-jedi-oracle.ts --corpus httpx \
  --json ~/Dev/Tools/tea-rags-bench/results/python/2026-09-08-httpx.json
npx tsx scripts/py-codegraph-jedi-oracle.ts --corpus flask \
  --json ~/Dev/Tools/tea-rags-bench/results/python/2026-09-08-flask.json
npx tsx scripts/py-codegraph-jedi-oracle.ts --corpus ugnest \
  --json ~/Dev/Tools/tea-rags-bench/results/python/2026-09-08-ugnest.json
```

- [ ] Run the two slow ones in the BACKGROUND with output redirected, and poll
      the file. netbox is ~60k sites and polar ~82k; polar is expected at 15–40
      minutes, and a foreground call that long is killed:

```bash
nohup npx tsx scripts/py-codegraph-jedi-oracle.ts --corpus netbox \
  --json ~/Dev/Tools/tea-rags-bench/results/python/2026-09-08-netbox.json \
  > /tmp/netbox-oracle.log 2>&1 &
```

      Poll with `tail -5 /tmp/netbox-oracle.log` until the elapsed line appears,
      then start polar the same way. Run them SEQUENTIALLY: two 8-worker pools
      plus two tree-sitter walks will not fit alongside the perf gate's
      assumptions, and a measurement taken under contention is not a baseline.

- [ ] Check the determinism gate on the two corpora most likely to break it —
      polar because of the degraded rows, netbox because of the JavaScript in
      the symbol table:

```bash
npx tsx scripts/py-codegraph-jedi-oracle.ts --corpus netbox --json /tmp/netbox-a.json --quiet
npx tsx scripts/py-codegraph-jedi-oracle.ts --corpus netbox --json /tmp/netbox-b.json --quiet
diff /tmp/netbox-a.json /tmp/netbox-b.json && echo DETERMINISTIC
```

      A diff here is a real defect, not noise: the likely causes are an
      unsorted map in the report payload and a `multiprocessing` reply arriving
      out of order. Both are fixed in the harness before the baseline stands.

- [ ] Verify `chainDrift` is 0 on ALL FIVE. A non-zero value on any corpus voids
      that corpus's numbers — the run exits 1 for exactly this reason, so check
      the exit codes rather than reading past the warning line.

- [ ] Reconcile each corpus's chain-output totals against the recorded
      chain-tally baseline (ugnest 1432 / 315 / 5899, flask 770 / 148 / 1402,
      netbox 21971 / 8190 / 38760, polar 21336 / 3976 / 61218, httpx 1011 / 193
      / 1632). Equal numbers mean the oracle scores the population production
      resolves. A gap is a corpus-parity bug in the harness — report the gap and
      its cause in the appendix rather than quietly adopting the new number.

- [ ] Append the appendix to
      `docs/superpowers/specs/2026-09-03-python-codegraph-e0-measurement-design.md`,
      under a new `## Appendix — E0 baseline (2026-09-08)` heading placed AFTER
      the existing seam-inventory appendix. Five sections, filled from the JSON,
      no prose beyond what a number needs to be readable:

```markdown
## Appendix — E0 baseline (2026-09-08)

Oracle: `scripts/py-codegraph-jedi-oracle.ts`, seed 20260908, jedi 0.20.0.
`chainDrift` 0 on every corpus. Rates exclude `oracleDegraded` and `parseFailed`
rows; both are reported separately, because a stale parso grammar is a gap in
the instrument and not a defect in the resolver.

### Ground-truth coverage

| corpus | call sites | with ground truth | coverage | oracleDegraded | parseFailed | unlocated (by shape) |
| ------ | ---------- | ----------------- | -------- | -------------- | ----------- | -------------------- |

### receiverKind × verdict

One table per corpus, each row a `receiverKind`, columns `sites` / `oracle` /
`match` / `fileOnly` / `wrongFile` / `missed` / `mismatch%` / `ext` / `phantom`
/ `phantom%` / `skippedInProject`.

### answeredBy × verdict

Same columns, rows are the six pass names plus `none`. The `none` row is the
declined set and is where the recall levers are read.

### Missed-shape category ranking

| rank | category | oracle answers | mismatch% | missed | wrongFile | corpora it dominates |
| ---- | -------- | -------------- | --------- | ------ | --------- | -------------------- |

### Precision floor

| corpus | external proven | phantom | phantom% | skippedInProject |
| ------ | --------------- | ------- | -------- | ---------------- |

These `phantom` and `skippedInProject` numbers are the floors every later
increment is compared against: E1 and E2 may raise `match`, and neither may
raise these.
```

- [ ] Rank the categories across corpora and write the pull order down. The
      program spec predicted: `ExternalVocabulary` → `ModuleResolver` →
      annotations → C3 / `super` → framework vocabularies → propagation →
      dispatch. Confirm it or reorder it FROM THE DATA, and say which corpus
      carried the evidence for each move. A category with fewer than 20 ground
      truth answers does not rank — it is noise, and the TS oracle's
      `PRIORITY_MIN_ORACLE_DEFAULT` exists for exactly this.

- [ ] Update the `### Predicted pull order` section of
      `docs/superpowers/specs/2026-09-03-python-codegraph-unification-program-design.md`
      ONLY if the data reorders it. Change the heading to
      `### Pull order (confirmed 2026-09-08 by the E0 baseline)` either way, and
      keep the original prediction visible beneath any change — a prediction
      that was wrong is evidence about the model, and deleting it destroys that.

- [ ] Report the five headline rows in the commit body, per corpus, never as a
      cross-corpus average: `.claude/rules` and the program spec both require
      per-corpus and per-receiverKind reporting, and an average over corpora
      this different is a number about nothing.

- [ ] Format and commit — the results JSON is NOT added, it lives outside the
      repo by design:

```bash
npx prettier --write docs/superpowers/specs/2026-09-03-python-codegraph-e0-measurement-design.md \
  docs/superpowers/specs/2026-09-03-python-codegraph-unification-program-design.md
git add docs/superpowers/specs
git commit -m "docs(scripts): record the E0 Python oracle baseline over five corpora (mmckn)"
```

---

## Task 5a: `GlobalSymbolTable.hasFile` and `hasFilesUnder`

**Files**

- Modify `src/core/contracts/types/codegraph-symbols.ts`
- Modify `src/core/domains/trajectory/codegraph/symbols/symbol-table.ts`
- Modify `src/core/adapters/duckdb/daemon/noop-symbol-table.ts`
- Modify `tests/core/domains/trajectory/codegraph/symbols/symbol-table.test.ts`
- Modify `tests/core/adapters/duckdb/daemon/noop-symbol-table.test.ts`
- Modify `tests/core/domains/language/kernel/fanout-policy.test.ts`
- Modify `tests/core/contracts/types/codegraph.test.ts`

**Interfaces**

_Consumes_ — nothing new. Both methods answer from state
`InMemoryGlobalSymbolTable` already maintains.

_Produces_ — two required members on `GlobalSymbolTable`:

```ts
/** Does this exact file contribute any symbol to the table? */
hasFile: (relPath: RelPath) => boolean;
/** Does any file UNDER this directory contribute one? `""` means the whole table. */
hasFilesUnder: (dirRelPath: string) => boolean;
```

**Why this is its own task, landing before 5b.** `codegraph-symbols.ts` carries
`transitiveImpact` 149 and `symbol-table.ts` is an architectural hub with
`fanIn` 10. A contract change at that blast radius is not something to bury
inside a vocabulary commit: if it regresses, the bisect should land on a commit
that changes nothing else. `PythonExternalVocabulary` (5b) is the first
consumer, `q9u85`'s `importMatch` park gate is the second, and E2's
`ImportFileMapper` is the third.

**Both methods are REQUIRED, not optional.** The repo has exactly two
implementations — `InMemoryGlobalSymbolTable` and `NoopGlobalSymbolTable` — plus
two test object literals typed against the interface. Every other test site is a
`{} as GlobalSymbolTable` cast, which an added member cannot break. Four call
sites is far below the threshold where "absent → unknown → not external" would
earn its ambiguity, and an optional predicate whose absence silently means "not
external" is exactly the kind of quiet default that makes a precision number
wrong without making a test red.

**Steps**

- [ ] Prepare the worktree: `npm ci`, then a bare `npm run build`.

- [ ] Write the failing tests first, in
      `tests/core/domains/trajectory/codegraph/symbols/symbol-table.test.ts`:

```ts
describe("InMemoryGlobalSymbolTable#hasFile", () => {
  it("answers true for a file that contributed definitions", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("pkg/models.py", [def("User", "pkg/models.py")]);
    expect(table.hasFile("pkg/models.py")).toBe(true);
  });

  it("answers false for a path the table never saw", () => {
    expect(new InMemoryGlobalSymbolTable().hasFile("pkg/models.py")).toBe(
      false,
    );
  });

  it("answers false for a file whose definitions were removed", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("pkg/models.py", [def("User", "pkg/models.py")]);
    table.removeFile("pkg/models.py");
    expect(table.hasFile("pkg/models.py")).toBe(false);
  });

  it("answers false for a file upserted with NO definitions", () => {
    // `upsertFile` returns early on an empty list, so the file never enters
    // `byFile`. "Present but contributing nothing" and "absent" are the same
    // answer to the only question the caller is asking.
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("pkg/empty.py", []);
    expect(table.hasFile("pkg/empty.py")).toBe(false);
  });
});

describe("InMemoryGlobalSymbolTable#hasFilesUnder", () => {
  it("answers true for every ancestor directory of a known file", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("netbox/dcim/models/devices.py", [
      def("Device", "netbox/dcim/models/devices.py"),
    ]);
    expect(table.hasFilesUnder("netbox")).toBe(true);
    expect(table.hasFilesUnder("netbox/dcim")).toBe(true);
    expect(table.hasFilesUnder("netbox/dcim/models")).toBe(true);
  });

  it("answers false for a sibling directory", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("netbox/dcim/models.py", [
      def("Device", "netbox/dcim/models.py"),
    ]);
    expect(table.hasFilesUnder("netbox/ipam")).toBe(false);
  });

  it("does not treat a path PREFIX as a directory", () => {
    // `netbox/dcim_extra` starts with `netbox/dcim`, and a naive
    // `startsWith` index would call the second a parent of the first.
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("netbox/dcim_extra/models.py", [
      def("X", "netbox/dcim_extra/models.py"),
    ]);
    expect(table.hasFilesUnder("netbox/dcim")).toBe(false);
  });

  it("treats the empty string as the whole table", () => {
    const table = new InMemoryGlobalSymbolTable();
    expect(table.hasFilesUnder("")).toBe(false);
    table.upsertFile("a.py", [def("A", "a.py")]);
    expect(table.hasFilesUnder("")).toBe(true);
  });

  it("ignores a trailing slash", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("pkg/a.py", [def("A", "pkg/a.py")]);
    expect(table.hasFilesUnder("pkg/")).toBe(true);
  });

  it("refcounts, so removing ONE of two files leaves the directory populated", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("pkg/a.py", [def("A", "pkg/a.py")]);
    table.upsertFile("pkg/b.py", [def("B", "pkg/b.py")]);
    table.removeFile("pkg/a.py");
    expect(table.hasFilesUnder("pkg")).toBe(true);
    table.removeFile("pkg/b.py");
    expect(table.hasFilesUnder("pkg")).toBe(false);
  });

  it("does not double-count a re-upsert of the same file", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("pkg/a.py", [def("A", "pkg/a.py")]);
    table.upsertFile("pkg/a.py", [def("A2", "pkg/a.py")]);
    table.removeFile("pkg/a.py");
    expect(table.hasFilesUnder("pkg")).toBe(false);
  });

  it("counts files hydrated in bulk", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.hydrate([def("A", "pkg/a.py")]);
    expect(table.hasFilesUnder("pkg")).toBe(true);
    expect(table.hasFile("pkg/a.py")).toBe(true);
  });
});
```

- [ ] Add the daemon-side cases to
      `tests/core/adapters/duckdb/daemon/noop-symbol-table.test.ts`:

```ts
describe("NoopGlobalSymbolTable — file presence", () => {
  it("answers false for hasFile, because it stores nothing", () => {
    const table = new NoopGlobalSymbolTable();
    table.upsertFile("pkg/a.py", [
      {
        symbolId: "A",
        fqName: "A",
        shortName: "A",
        relPath: "pkg/a.py",
        scope: [],
      },
    ]);
    expect(table.hasFile("pkg/a.py")).toBe(false);
  });

  it("answers false for hasFilesUnder, including the whole-table query", () => {
    const table = new NoopGlobalSymbolTable();
    expect(table.hasFilesUnder("pkg")).toBe(false);
    expect(table.hasFilesUnder("")).toBe(false);
  });
});
```

      `false` is the honest answer here, not a placeholder: the daemon never
      resolves, so nothing ever asks it these questions. If something starts to,
      `false` makes every call look external — which is why 5b's vocabulary must
      be built on a table that actually holds the corpus, and why the harness
      uses `InMemoryGlobalSymbolTable` directly.

- [ ] Run both files and watch them fail:
      `npx vitest run tests/core/domains/trajectory/codegraph/symbols/symbol-table.test.ts tests/core/adapters/duckdb/daemon/noop-symbol-table.test.ts`.

- [ ] Add the two members to `GlobalSymbolTable` in
      `src/core/contracts/types/codegraph-symbols.ts`, directly after
      `lookupByShortName` and before `setSchemaColumns`:

```ts
/**
 * Does this exact file contribute any symbol to the table?
 *
 * The question the import mappers could not ask (bd tea-rags-mcp-q9u85):
 * `mapPythonImportToFile` and `mapJavaImportToFile` SYNTHESISE a target path
 * from the import text without probing disk, so `re.py` and
 * `java/util/Objects.java` are perfectly ordinary answers. Without this the
 * only way to tell a real first-party target from a synthesised external one
 * was to hit the filesystem, which the resolver must not do.
 */
hasFile: (relPath: RelPath) => boolean;
/**
 * Does any file UNDER this directory contribute a symbol? `""` asks about the
 * whole table. A trailing slash is ignored; a path PREFIX is not a parent
 * (`pkg/a` is not under `pkg/ab`).
 *
 * Needed because a Python package import resolves to a DIRECTORY as often as
 * to a file — PEP 420 namespace packages have no `__init__.py` at all — so
 * `hasFile` alone cannot tell "this package is ours" from "this package is a
 * dependency". O(1), maintained as an index, never a scan.
 */
hasFilesUnder: (dirRelPath: string) => boolean;
```

- [ ] Implement both in `InMemoryGlobalSymbolTable`. The directory index is
      REFCOUNTED, not a set: two files in one directory and the removal of one
      must leave the directory populated, which a set cannot express:

```ts
  /**
   * Ancestor directory -> number of files under it that hold definitions.
   *
   * Refcounted rather than a Set because `removeFile` is a per-file operation
   * on a directory many files share — a Set would delete `netbox/dcim` the
   * first time any file under it went away. Every ancestor prefix of a file
   * gets one count, so a corpus of 1,300 files at depth 5 holds a few thousand
   * entries: bounded by (files x depth), and no filesystem access at any point.
   */
  private readonly dirRefCounts = new Map<string, number>();

  hasFile(relPath: RelPath): boolean {
    return this.byFile.has(relPath);
  }

  hasFilesUnder(dirRelPath: string): boolean {
    const normalized = dirRelPath.endsWith("/") ? dirRelPath.slice(0, -1) : dirRelPath;
    if (normalized === "") return this.byFile.size > 0;
    return this.dirRefCounts.has(normalized);
  }
```

      and maintain it inside the two existing mutators. `upsertFile` already
      calls `removeFile` first, so a re-upsert cannot double-count:

```ts
// in upsertFile, after `this.byFile.set(relPath, definitions.slice())`:
for (const dir of ancestorDirs(relPath)) {
  this.dirRefCounts.set(dir, (this.dirRefCounts.get(dir) ?? 0) + 1);
}

// in removeFile, after `this.byFile.delete(relPath)`:
for (const dir of ancestorDirs(relPath)) {
  const next = (this.dirRefCounts.get(dir) ?? 0) - 1;
  if (next <= 0) this.dirRefCounts.delete(dir);
  else this.dirRefCounts.set(dir, next);
}
```

      with the helper beside `pushTo` / `removeFrom` at the bottom of the file:

```ts
/** Every ancestor directory of a repo-relative path, shallowest first. */
function ancestorDirs(relPath: RelPath): string[] {
  const segments = relPath.split("/");
  const dirs: string[] = [];
  for (let i = 1; i < segments.length; i++)
    dirs.push(segments.slice(0, i).join("/"));
  return dirs;
}
```

- [ ] Implement both in `NoopGlobalSymbolTable`:

```ts
  hasFile(_relPath: RelPath): boolean {
    return false;
  }

  hasFilesUnder(_dirRelPath: string): boolean {
    return false;
  }
```

- [ ] Update the two test fakes, one line each. In
      `tests/core/domains/language/kernel/fanout-policy.test.ts`, inside
      `tableWithCounts`:

```ts
  hasFile: () => false,
  hasFilesUnder: () => false,
```

      and the same two lines in the `_table` literal in
      `tests/core/contracts/types/codegraph.test.ts`. Note that
      `npm run type-check` covers `src/**` only, so neither of these is caught
      by `tsc` — they surface through eslint's project, and the fanout fake is
      the one that would actually run.

- [ ] Run the full suite and the type check:
      `npx vitest run tests/core/domains/trajectory/codegraph tests/core/adapters/duckdb tests/core/domains/language/kernel tests/core/contracts`
      then `npm run type-check`.

- [ ] Perf gate. These are map lookups, so the expectation is NO measurable
      movement; a rise means the index is being rebuilt somewhere it should not
      be. Run all five sequentially and compare against the recorded baselines:

```bash
/usr/bin/time -l npx tsx scripts/codegraph-chain-tally.ts \
  --corpus ~/Dev/Collaborate/ugnest --lang python --quiet
```

- [ ] Confirm the chain-tally numbers are byte-identical (ugnest 1432 / 315 /
      5899 and the other four). This task adds a query; it must move nothing.

- [ ] Format and commit:

```bash
npx prettier --write src/core/contracts/types/codegraph-symbols.ts \
  src/core/domains/trajectory/codegraph/symbols/symbol-table.ts \
  src/core/adapters/duckdb/daemon/noop-symbol-table.ts
git commit -am "feat(contracts): let a symbol table answer whether a file or directory is ours (mmckn)"
```

---

## Task 5b: `PythonExternalVocabulary` — the honest denominator

**Files**

- Create `scripts/py-oracle/gen-stdlib-modules.py`
- Create `src/core/domains/language/python/vocabulary/builtins.ts`
- Create `src/core/domains/language/python/vocabulary/stdlib-modules.ts`
- Create `src/core/domains/language/python/vocabulary/core-members.ts`
- Create
  `src/core/domains/language/python/resolver/python-external-vocabulary.ts`
- Create
  `tests/core/domains/language/python/resolver/python-external-vocabulary.test.ts`
- Modify `src/core/domains/language/python/resolver/python-resolver.ts`
- Modify `src/core/domains/language/CLAUDE.md`

**Interfaces**

_Consumes_

```ts
import { resolveLocalBindingType } from "../../../../contracts/types/codegraph-local-binding.js";
import type { CallContext } from "../../../../contracts/types/codegraph.js";
import type { ExternalVocabulary } from "../../../../contracts/types/language.js";
import { ExternalCallClassifier } from "../../external-classifier.js";
import { mapPythonImportToFile } from "./python-path-mapper.js";
```

_Produces_

```ts
export class PythonExternalVocabulary implements ExternalVocabulary {
  isBareCallExternal(member: string): boolean;
  isQualifiedReceiverExternal(
    receiver: string,
    ctx: CallContext,
    atLine?: number,
    member?: string,
  ): boolean;
  isCoreAmbiguousMember(member: string): boolean;
  isReceiverTyped(receiver: string, ctx: CallContext, atLine?: number): boolean;
}
```

and on `PythonCallResolver`, two methods that now DELEGATE:

```ts
targetsExternalImport(call: CallRef, ctx: CallContext): boolean;      // relocated body
targetsCoreAmbiguousMember(call: CallRef, ctx: CallContext): boolean; // net-new
```

**The behaviour that must not change.**
`tests/core/domains/language/python/resolver/python-resolver-external-import.test.ts`
is the regression net and is NOT edited. Its five cases pin the shape of the
current inline classifier, and two of them constrain the new vocabulary
directly:

- a SINGLE-segment receiver (`os` with `import os`) is NOT external. It never
  reaches the classifier unresolved — `importMatch` emits a file-only edge for
  it — so `isQualifiedReceiverExternal` keeps the `receiver.includes(".")` guard
  as its first condition, exactly as the inline body has it.
- a bare call (`helper()`) is NOT external. The new `isBareCallExternal` answers
  `member ∈ builtins`, and `helper` is not a builtin, so the case stays green
  while `len(...)` / `isinstance(...)` become newly recognisable.

**What `hasFile` / `hasFilesUnder` actually buy.** Today the inline body returns
`true` for ANY dotted receiver rooted at a non-relative import — including a
FIRST-PARTY absolute import. netbox imports `netbox.dcim.models`, flask imports
`flask.globals`, polar imports `polar.kit.db`: every one of those is project
code the classifier currently calls external, which does not merely mis-file a
miss, it removes a real recall hole from the denominator. With Task 5a's queries
the predicate can ask whether the mapped target is ours, so an absolute
FIRST-PARTY import stays in the denominator and only genuinely external roots
leave it.

**Steps**

- [x] Prepare the worktree: `npm ci`, then a bare `npm run build`. Task 5a must
      already be merged — `hasFile` / `hasFilesUnder` are required here.

- [x] Write `scripts/py-oracle/gen-stdlib-modules.py`:

```python
#!/usr/bin/env python3
"""Generate `python/vocabulary/stdlib-modules.ts` (bd tea-rags-mcp-mmckn).

The UNION of `sys.stdlib_module_names` across the interpreters the corpora run
on, because the vocabulary is one snapshot serving all five: netbox is 3.12,
polar is 3.14, httpx claims 3.9. A union over-approximates by a handful of
modules removed between versions, and over-approximating the STDLIB is the safe
direction — the alternative is calling a stdlib receiver a project miss.

Run it explicitly when the version list changes; the output is committed, and
nothing in the build regenerates it.

    uv run --no-project --python 3.13 python scripts/py-oracle/gen-stdlib-modules.py \\
        > src/core/domains/language/python/vocabulary/stdlib-modules.ts
"""

from __future__ import annotations

import subprocess
import sys

VERSIONS = ["3.10", "3.11", "3.12", "3.13", "3.14"]


def names_for(version: str) -> set[str]:
    out = subprocess.run(
        ["uv", "run", "--no-project", "--python", version, "python", "-c",
         "import sys, json; print(json.dumps(sorted(sys.stdlib_module_names)))"],
        capture_output=True, text=True, check=True,
    )
    import json

    return set(json.loads(out.stdout))


def main() -> int:
    union: set[str] = set()
    for version in VERSIONS:
        union |= names_for(version)
    union = {name for name in union if not name.startswith("_")}

    body = ",\n  ".join(f'"{name}"' for name in sorted(union))
    sys.stdout.write(
        "/**\n"
        f" * Top-level stdlib module names — the union over CPython {VERSIONS[0]}-{VERSIONS[-1]}.\n"
        " *\n"
        " * GENERATED by `scripts/py-oracle/gen-stdlib-modules.py`. Do not edit by hand;\n"
        " * re-run the generator when the version list in its header changes.\n"
        " *\n"
        " * A frozen module-level Set: the vocabulary is consulted once per unresolved\n"
        " * call on every corpus, so this must be a hash lookup and never a scan, and it\n"
        " * must never touch the filesystem.\n"
        " */\n"
        "export const PYTHON_STDLIB_MODULES: ReadonlySet<string> = new Set([\n"
        f"  {body},\n"
        "]);\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [x] Generate the snapshot and confirm it is a plain `Set` of strings with no
      leading-underscore private modules:

```bash
uv run --no-project --python 3.13 python scripts/py-oracle/gen-stdlib-modules.py \
  > src/core/domains/language/python/vocabulary/stdlib-modules.ts
grep -c '"' src/core/domains/language/python/vocabulary/stdlib-modules.ts
```

- [x] Write `src/core/domains/language/python/vocabulary/builtins.ts`:

```ts
/**
 * The `builtins` module's callable names (bd tea-rags-mcp-mmckn).
 *
 * A bare call to one of these has zero project definitions by construction: the
 * name is bound by the interpreter before any module runs, and shadowing one is
 * rare enough that treating a shadowed `list` as external costs a single edge
 * while treating `len` as a recall hole costs thousands.
 *
 * Kept as data rather than derived at runtime: production must not import a
 * Python interpreter, and `dir(builtins)` on the DEVELOPER's machine is not the
 * corpus's interpreter anyway.
 */
export const PYTHON_BUILTINS: ReadonlySet<string> = new Set([
  "abs",
  "aiter",
  "anext",
  "all",
  "any",
  "ascii",
  "bin",
  "bool",
  "breakpoint",
  "bytearray",
  "bytes",
  "callable",
  "chr",
  "classmethod",
  "compile",
  "complex",
  "delattr",
  "dict",
  "dir",
  "divmod",
  "enumerate",
  "eval",
  "exec",
  "filter",
  "float",
  "format",
  "frozenset",
  "getattr",
  "globals",
  "hasattr",
  "hash",
  "help",
  "hex",
  "id",
  "input",
  "int",
  "isinstance",
  "issubclass",
  "iter",
  "len",
  "list",
  "locals",
  "map",
  "max",
  "memoryview",
  "min",
  "next",
  "object",
  "oct",
  "open",
  "ord",
  "pow",
  "print",
  "property",
  "range",
  "repr",
  "reversed",
  "round",
  "set",
  "setattr",
  "slice",
  "sorted",
  "staticmethod",
  "str",
  "sum",
  "super",
  "tuple",
  "type",
  "vars",
  "zip",
]);
```

- [x] Write `src/core/domains/language/python/vocabulary/core-members.ts`:

```ts
/**
 * Core-homonym members — the Python twin of Ruby's `each` / `to_s` / `first`
 * (bd tea-rags-mcp-83cl7, applied to Python by mmckn).
 *
 * These names are defined on dict / list / str / set / bytes / file objects, so
 * `row.get(key)` on an UNTYPED receiver almost never means the project class
 * that also happens to define `get`. The classifier consults this only after a
 * call failed resolution AND the receiver was proven untyped, so a typed
 * receiver whose class genuinely defines `get` stays a real miss.
 *
 * Precision runs in REVERSE here: every name added hides a possible recall
 * hole, so add one only when the corpus shows it dominating. `save`, `create`
 * and `delete` are deliberately ABSENT — they are Django model methods, which
 * E3's framework vocabulary owns, and putting them here would silently excuse
 * the exact misses that epic exists to fix.
 */
export const PYTHON_CORE_MEMBERS: ReadonlySet<string> = new Set([
  "append",
  "clear",
  "copy",
  "count",
  "extend",
  "get",
  "index",
  "insert",
  "items",
  "join",
  "keys",
  "pop",
  "read",
  "remove",
  "replace",
  "reverse",
  "setdefault",
  "sort",
  "split",
  "startswith",
  "endswith",
  "strip",
  "lstrip",
  "rstrip",
  "update",
  "upper",
  "lower",
  "values",
  "write",
  "close",
  "format",
  "encode",
  "decode",
  "add",
  "discard",
]);
```

      `update` is here as the dict method and is ALSO a Django model method.
      That is a judgement the baseline checks: if Task 4's ranking shows
      `update` sites dominated by `managerQuerySet`, drop it here and let E3
      own it. Record which way the data went in the commit body.

- [x] Write the failing tests —
      `tests/core/domains/language/python/resolver/python-external-vocabulary.test.ts`:

```ts
/**
 * The Python external vocabulary (bd tea-rags-mcp-mmckn). Every predicate gets
 * a positive AND a negative case, because both directions are load-bearing: a
 * false positive removes a real recall hole from the denominator, and a false
 * negative leaves a stdlib call sitting in it.
 */
import { describe, expect, it } from "vitest";

import type { CallContext } from "../../../../../../src/core/contracts/types/codegraph.js";
import { PythonExternalVocabulary } from "../../../../../../src/core/domains/language/python/resolver/python-external-vocabulary.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const vocab = new PythonExternalVocabulary();

function ctxWith(
  imports: { importText: string; startLine: number }[],
  files: Record<string, string[]> = {},
  overrides: Partial<CallContext> = {},
): CallContext {
  const symbolTable = new InMemoryGlobalSymbolTable();
  for (const [relPath, names] of Object.entries(files)) {
    symbolTable.upsertFile(
      relPath,
      names.map((name) => ({
        symbolId: name,
        fqName: name,
        shortName: name,
        relPath,
        scope: [],
      })),
    );
  }
  return {
    callerFile: "pkg/main.py",
    callerScope: [],
    imports,
    symbolTable,
    ...overrides,
  };
}

describe("isBareCallExternal", () => {
  it("claims a builtin", () => {
    expect(vocab.isBareCallExternal("len")).toBe(true);
    expect(vocab.isBareCallExternal("isinstance")).toBe(true);
  });

  it("leaves a project free function alone", () => {
    expect(vocab.isBareCallExternal("helper")).toBe(false);
    expect(vocab.isBareCallExternal("promote")).toBe(false);
  });
});

describe("isQualifiedReceiverExternal", () => {
  it("claims a dotted stdlib receiver rooted at a non-relative import", () => {
    expect(
      vocab.isQualifiedReceiverExternal(
        "os.path",
        ctxWith([{ importText: "os", startLine: 1 }]),
        3,
      ),
    ).toBe(true);
  });

  it("claims a dotted third-party receiver whose mapped file is not ours", () => {
    expect(
      vocab.isQualifiedReceiverExternal(
        "numpy.linalg",
        ctxWith([{ importText: "numpy", startLine: 1 }]),
        3,
      ),
    ).toBe(true);
  });

  it("does NOT claim a single-segment receiver — importMatch already answered it", () => {
    expect(
      vocab.isQualifiedReceiverExternal(
        "os",
        ctxWith([{ importText: "os", startLine: 1 }]),
        3,
      ),
    ).toBe(false);
  });

  it("does NOT claim a receiver rooted at a relative import", () => {
    expect(
      vocab.isQualifiedReceiverExternal(
        "sub.mod",
        ctxWith([{ importText: ".sub", startLine: 1 }]),
        3,
      ),
    ).toBe(false);
  });

  it("does NOT claim a FIRST-PARTY absolute import whose file is in the table", () => {
    // netbox / flask / polar all import their own packages absolutely. The
    // inline classifier called every one of these external.
    const ctx = ctxWith([{ importText: "netbox.dcim.models", startLine: 1 }], {
      "netbox/dcim/models.py": ["Device"],
    });
    expect(vocab.isQualifiedReceiverExternal("netbox.dcim", ctx, 3)).toBe(
      false,
    );
  });

  it("does NOT claim a first-party PACKAGE directory with no module file of its own", () => {
    // PEP 420 namespace package: no `__init__.py`, so `hasFile` says no and
    // only `hasFilesUnder` can tell that the package is ours.
    const ctx = ctxWith([{ importText: "domains.billing", startLine: 1 }], {
      "domains/billing/invoice.py": ["Invoice"],
    });
    expect(vocab.isQualifiedReceiverExternal("domains.billing", ctx, 3)).toBe(
      false,
    );
  });

  it("does NOT claim a receiver whose local binding gives it a type at that line", () => {
    const ctx = ctxWith(
      [{ importText: "os", startLine: 1 }],
      {},
      {
        localBindings: { os: [{ name: "os", type: "FakeOs", line: 2 }] },
      },
    );
    expect(vocab.isQualifiedReceiverExternal("os.path", ctx, 3)).toBe(false);
  });
});
```

- [x] Add the two remaining predicates' cases to the same test file:

```ts
describe("isCoreAmbiguousMember", () => {
  it("claims a dict / list / str member", () => {
    expect(vocab.isCoreAmbiguousMember("get")).toBe(true);
    expect(vocab.isCoreAmbiguousMember("append")).toBe(true);
  });

  it("leaves a Django model method to E3's framework vocabulary", () => {
    expect(vocab.isCoreAmbiguousMember("save")).toBe(false);
    expect(vocab.isCoreAmbiguousMember("delete")).toBe(false);
  });

  it("leaves an ordinary project method alone", () => {
    expect(vocab.isCoreAmbiguousMember("rename")).toBe(false);
  });
});

describe("isReceiverTyped", () => {
  it("calls self and cls typed — their type is the enclosing class", () => {
    expect(vocab.isReceiverTyped("self", ctxWith([]), 3)).toBe(true);
    expect(vocab.isReceiverTyped("cls", ctxWith([]), 3)).toBe(true);
  });

  it("calls a locally-bound receiver typed at a line AFTER its binding", () => {
    const ctx = ctxWith(
      [],
      {},
      { localBindings: { user: [{ name: "user", type: "User", line: 2 }] } },
    );
    expect(vocab.isReceiverTyped("user", ctx, 5)).toBe(true);
  });

  it("does NOT call it typed BEFORE the binding line", () => {
    const ctx = ctxWith(
      [],
      {},
      { localBindings: { user: [{ name: "user", type: "User", line: 9 }] } },
    );
    expect(vocab.isReceiverTyped("user", ctx, 5)).toBe(false);
  });

  it("calls a declared class field typed", () => {
    const ctx = ctxWith(
      [],
      {},
      { classFieldTypes: { "User.repo": "Repository" } },
    );
    expect(vocab.isReceiverTyped("self.repo", ctx, 3)).toBe(true);
  });

  it("calls an unbound receiver untyped, which is what admits the coreAmbiguous bucket", () => {
    expect(vocab.isReceiverTyped("row", ctxWith([]), 3)).toBe(false);
  });
});
```

- [x] Run and watch them fail:
      `npx vitest run tests/core/domains/language/python/resolver/python-external-vocabulary.test.ts`.

- [x] Write
      `src/core/domains/language/python/resolver/python-external-vocabulary.ts`:

```ts
/**
 * Python's `ExternalVocabulary` (bd tea-rags-mcp-mmckn, E0 of the unification
 * program). Python's denominator has never been honest: with no vocabulary,
 * every Django / DRF / stdlib call whose definition lives in a virtualenv sat
 * in "unresolved", and most of ugnest's 5,899 unresolved sites are
 * structurally external. The first lever is an honest denominator, not recall.
 *
 * Technique precedent: `ruby/resolver/ruby-external-vocabulary.ts`. The engine
 * (`ExternalCallClassifier`) owns the receiver-shape branch; everything here is
 * a language decision.
 *
 * NO FILESYSTEM ACCESS, on any path. The stdlib snapshot is a frozen
 * module-level Set, the builtins list is data, and "is this file ours" is a
 * symbol-table query (`hasFile` / `hasFilesUnder`, bd q9u85). The vocabulary is
 * consulted once per unresolved call on corpora with 80k of them.
 */
import { resolveLocalBindingType } from "../../../../contracts/types/codegraph-local-binding.js";
import type { CallContext } from "../../../../contracts/types/codegraph.js";
import type { ExternalVocabulary } from "../../../../contracts/types/language.js";
import { PYTHON_BUILTINS } from "../vocabulary/builtins.js";
import { PYTHON_CORE_MEMBERS } from "../vocabulary/core-members.js";
import { PYTHON_STDLIB_MODULES } from "../vocabulary/stdlib-modules.js";
import { mapPythonImportToFile } from "./python-path-mapper.js";

export class PythonExternalVocabulary implements ExternalVocabulary {
  /** A bare call naming a builtin: bound by the interpreter, never a project def. */
  isBareCallExternal(member: string): boolean {
    return PYTHON_BUILTINS.has(member);
  }

  /**
   * A dotted receiver whose ROOT segment is bound by a non-relative import that
   * does not land in this project.
   *
   * Three guards, each holding a case the corpora produce:
   *
   *   - SINGLE-SEGMENT receivers are never claimed. `os.getcwd()` resolves
   *     through `importMatch` as a file-only edge and never arrives here
   *     unresolved; claiming it would double-count. Pinned by
   *     `python-resolver-external-import.test.ts`.
   *   - A RELATIVE import is in-project by construction.
   *   - An ABSOLUTE import that maps into the symbol table is FIRST-PARTY. This
   *     is the branch `hasFile` / `hasFilesUnder` added: netbox, flask and
   *     polar all import their own packages absolutely, and calling those
   *     external removes real recall holes from the denominator.
   */
  isQualifiedReceiverExternal(
    receiver: string,
    ctx: CallContext,
    atLine?: number,
  ): boolean {
    if (!receiver.includes(".")) return false;
    // A receiver with a local type at this line is a VALUE, not a module —
    // whatever the imports say about the name.
    if (
      atLine !== undefined &&
      resolveLocalBindingType(
        ctx.localBindings,
        receiver.split(".")[0] as string,
        atLine,
      ) !== undefined
    ) {
      return false;
    }
    const root = receiver.slice(0, receiver.indexOf("."));
    for (const imp of ctx.imports) {
      if (imp.importText.startsWith(".")) continue; // relative → in-project
      const head = (imp.importText.split(/\s+as\s+/)[0] ?? "").trim();
      if (head.split(".")[0] !== root) continue;
      if (this.importLandsInProject(head, ctx)) return false;
      // A stdlib root is external even when the mapper's synthesised path
      // happens to collide with a project file name (`json.py`, `types.py`).
      return true;
    }
    return false;
  }

  /** Does this import text name a file or a package directory the table holds? */
  private importLandsInProject(importText: string, ctx: CallContext): boolean {
    if (PYTHON_STDLIB_MODULES.has(importText.split(".")[0] as string))
      return false;
    const mapped = mapPythonImportToFile(importText, ctx.callerFile);
    if (mapped === null) return false;
    if (ctx.symbolTable.hasFile(mapped)) return true;
    // PEP 420 namespace packages have no `__init__.py`, so the package is only
    // visible as a DIRECTORY holding files — `hasFile` alone cannot see it.
    return ctx.symbolTable.hasFilesUnder(mapped.replace(/\.py$/, ""));
  }

  /** A dict / list / str / set / bytes / file member name. */
  isCoreAmbiguousMember(member: string): boolean {
    return PYTHON_CORE_MEMBERS.has(member);
  }

  /**
   * Does the receiver have a known static type? `self` / `cls` are
   * structurally self-identifying, a local binding gives a type at a line, and
   * a declared class field gives one by name. Everything else is untyped, which
   * is the only state that admits the `coreAmbiguous` bucket.
   */
  isReceiverTyped(
    receiver: string,
    ctx: CallContext,
    atLine?: number,
  ): boolean {
    if (receiver === "self" || receiver === "cls") return true;
    if (
      atLine !== undefined &&
      resolveLocalBindingType(ctx.localBindings, receiver, atLine) !== undefined
    )
      return true;
    if (ctx.classFieldTypes === undefined) return false;
    const field = receiver.startsWith("self.")
      ? receiver.slice("self.".length)
      : receiver;
    return Object.keys(ctx.classFieldTypes).some(
      (key) => key === field || key.endsWith(`.${field}`),
    );
  }
}
```

- [x] Wire it into `PythonCallResolver`. The constructor gains one field, and
      the inline `targetsExternalImport` body is REPLACED by a delegation — the
      body is relocated into the vocabulary, not rewritten there:

```ts
  private readonly external: ExternalCallClassifier;

  constructor(mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE) {
    // ... existing cfg / strategies / cone ...
    this.external = new ExternalCallClassifier(new PythonExternalVocabulary());
  }

  /**
   * tea-rags-mcp-ykj7, relocated to the shared engine by mmckn. The decision
   * now lives in `PythonExternalVocabulary`; the shape branch (bare vs
   * qualified) is the engine's. Behaviour is preserved for every case
   * `python-resolver-external-import.test.ts` pins, and extended in one
   * direction only: a first-party ABSOLUTE import is no longer called external.
   */
  targetsExternalImport(call: CallRef, ctx: CallContext): boolean {
    return this.external.targetsExternal(call, ctx);
  }

  /**
   * tea-rags-mcp-83cl7 for Python. A core-named member on an UNTYPED receiver
   * (`row.get(key)`) whose real callee is the dict / list / str runtime, not the
   * project class that happens to define the same short name. Consulted only
   * for calls the chain declined and that the external arm did not claim.
   */
  targetsCoreAmbiguousMember(call: CallRef, ctx: CallContext): boolean {
    return this.external.targetsCoreAmbiguousMember(call, ctx);
  }
```

- [x] Run the regression net FIRST, unmodified. Five cases, all must pass with
      `git diff` on that file empty:

```bash
npx vitest run tests/core/domains/language/python/resolver/python-resolver-external-import.test.ts
git diff --stat -- tests/core/domains/language/python/resolver/python-resolver-external-import.test.ts
```

- [x] Run the whole Python and language suite plus the type check:
      `npx vitest run tests/core/domains/language` then `npm run type-check`.

- [x] Re-run the chain tally on all five corpora. This task is ALLOWED to move
      numbers, in one direction: `edges` / `fileOnly` / `unresolved` must be
      byte-identical (the vocabulary classifies MISSES, it does not resolve),
      while the runner's `externalSkipped` and `coreAmbiguous` buckets grow. A
      change in `edges` means something reached the resolve path that should not
      have — stop and diagnose, do not adopt the number:

```bash
npx tsx scripts/codegraph-chain-tally.ts --corpus ~/Dev/Collaborate/ugnest --lang python
```

- [x] Perf gate on all five, sequentially, against the recorded baselines. The
      predicates are set lookups plus one path map, so expect no movement; a
      rise means something is scanning.

      Measured BEFORE/AFTER back-to-back on ugnest and netbox (the two the task
      brief scoped): ugnest 2.70 s / 418.3 MB → 2.69 s / 400.0 MB; netbox
      14.52 s / 2,001.9 MB → 14.65 s / 2,224.2 MB. The netbox RSS delta is
      measurement noise, not the vocabulary: a repeat of each side lands at
      14.45 s / 2,317.6 MB (after) and 13.78 s / 2,280.5 MB (before, unchanged
      code), so run-to-run RSS spans ~280 MB on both sides. Chain-tally never
      consults the classifier, so the only added cost is three module-level Sets.
      flask, polar and httpx ran the tally unmetered — identical output.

- [ ] DEFERRED — parent runs the oracle A/B in E0.4.
      `scripts/py-codegraph-jedi-oracle.ts` is Task 3's deliverable and was
      absent from this worktree, so nothing was stubbed and no gate was claimed.
      Re-run the oracle on all five and diff against Task 4's baseline. The
      gate, stated so it cannot be read charitably:

      - `agreeExternal` UP — the vocabulary is claiming genuinely external calls.
      - `phantom` NOT UP — no in-project edge was fabricated.
      - `skippedInProject` NOT UP — the vocabulary did not over-claim. This is
        the number that catches an over-broad builtins or core-members list, and
        it is the reason `skippedInProject` exists as its own verdict.
      - `missed` may fall only by the amount `agreeExternal` rose.

```bash
npx tsx scripts/py-codegraph-jedi-oracle.ts --corpus ugnest \
  --json ~/Dev/Tools/tea-rags-bench/results/python/2026-09-08-ugnest-vocab.json
```

- [ ] DEFERRED with the step above — the appendix table needs oracle numbers.
      Append the re-baseline delta to the spec's appendix as a sixth table:
      `corpus | agreeExternal before/after | phantom before/after |     skippedInProject before/after | missed before/after`.

- [x] Add ONE Mechanics bullet to `src/core/domains/language/CLAUDE.md` naming
      the vocabulary, its no-filesystem rule, and the fact that the
      first-party-absolute-import branch depends on `hasFilesUnder`. Link the
      path-scoped rule rather than restating it.

- [x] Format and commit:

```bash
npx prettier --write src/core/domains/language/python src/core/domains/language/CLAUDE.md \
  tests/core/domains/language/python
git add src/core/domains/language/python scripts/py-oracle/gen-stdlib-modules.py \
  src/core/domains/language/CLAUDE.md tests/core/domains/language/python
git commit -m "feat(language): give Python an external vocabulary and an honest denominator (mmckn)"
```

---

## Task 6: ugnest live reconciliation — PARENT-GATED

**Files**

- Create `scripts/py-oracle/reconcile-live.ts`
- Create `tests/scripts/reconcile-live.test.ts`
- Modify
  `docs/superpowers/specs/2026-09-03-python-codegraph-e0-measurement-design.md`
  (reconciliation result)

**This task does NOT run the index.** The subagent writes the reconciliation
script, unit-tests its parser, and prepares the exact commands. The parent
session runs the registry flip and the index — reindex is user-gated without
exception, and a `--wait-enrichments` run on ugnest is minutes of shared Qdrant
and ollama time. The subagent's deliverable is the script plus a handoff block
naming the commands verbatim.

**Why reconcile at all.** The oracle scores an offline walk; `prime` reports
what the live pipeline persisted. The TS wave found its generated-files hole
exactly here — the oracle read `localVar` at 864 mismatches of 1,014 while
`prime` reported 38 of 543, and the gap was `.gitignore`d files the harness
scored and production never indexed. A gap over ±2 pp is a corpus-parity bug in
the harness, NOT a resolver fact, and it invalidates the baseline until
explained.

**Interfaces**

_Consumes_ — `prime`'s `## Codegraph resolve` block on stdout, one line per
receiver kind in the shape `bareCall 0.93 7816/15114`, and an oracle JSON from
Task 3's `--json`.

_Produces_

```ts
export interface LiveResolveRate {
  receiverKind: string;
  rate: number;
  resolved: number;
  attempted: number;
}

/** Parse the `## Codegraph resolve` block out of a `prime` run's stdout. */
export function parsePrimeResolveRates(stdout: string): LiveResolveRate[];

export interface ReconciliationRow {
  receiverKind: string;
  liveRate: number;
  oracleRate: number;
  /** `oracleRate - liveRate`, in PERCENTAGE POINTS. */
  deltaPp: number;
  withinTolerance: boolean;
}

export function reconcile(
  live: readonly LiveResolveRate[],
  oracleByReceiver: readonly {
    label: string;
    sites: number;
    chainOutputEdges: number;
  }[],
  tolerancePp: number,
): ReconciliationRow[];
```

**Steps**

- [ ] Prepare the worktree: `npm ci`, then a bare `npm run build`.

- [ ] Write the failing parser tests — `tests/scripts/reconcile-live.test.ts`:

```ts
/**
 * The live-vs-oracle reconciliation (bd tea-rags-mcp-mmckn, spec component F).
 * Parser-level only: the live half comes from a `prime` run the parent session
 * performs, and a test that mocked it would assert the mock.
 */
import { describe, expect, it } from "vitest";

import {
  parsePrimeResolveRates,
  reconcile,
} from "../../scripts/py-oracle/reconcile-live.js";

const PRIME_OUTPUT = `
# ugnest

## Codegraph resolve

bareCall 0.93 7816/15114
localVar 0.07 38/543
selfMember 0.71 900/1268
chain 0.12 44/366

## Something else
`;

describe("parsePrimeResolveRates", () => {
  it("reads one row per receiver kind", () => {
    expect(parsePrimeResolveRates(PRIME_OUTPUT)).toEqual([
      {
        receiverKind: "bareCall",
        rate: 0.93,
        resolved: 7816,
        attempted: 15114,
      },
      { receiverKind: "localVar", rate: 0.07, resolved: 38, attempted: 543 },
      {
        receiverKind: "selfMember",
        rate: 0.71,
        resolved: 900,
        attempted: 1268,
      },
      { receiverKind: "chain", rate: 0.12, resolved: 44, attempted: 366 },
    ]);
  });

  it("stops at the next heading rather than swallowing the rest of the report", () => {
    expect(
      parsePrimeResolveRates(`${PRIME_OUTPUT}\nnotAKind 1.0 1/1\n`).map(
        (r) => r.receiverKind,
      ),
    ).not.toContain("notAKind");
  });

  it("returns an empty list when the block is absent, rather than throwing", () => {
    // An index run that persisted no cg_run_stats prints no block. That is a
    // "run the index first" message, not a crash.
    expect(parsePrimeResolveRates("# ugnest\n\nnothing here\n")).toEqual([]);
  });
});

describe("reconcile", () => {
  const oracle = [
    { label: "bareCall", sites: 15114, chainOutputEdges: 14000 },
    { label: "localVar", sites: 543, chainOutputEdges: 40 },
  ];

  it("flags a kind inside the tolerance", () => {
    const rows = reconcile(
      [{ receiverKind: "localVar", rate: 0.07, resolved: 38, attempted: 543 }],
      oracle,
      2,
    );
    expect(rows[0]?.withinTolerance).toBe(true);
    expect(rows[0]?.deltaPp).toBeCloseTo(0.37, 1);
  });

  it("flags a kind outside it — the generated-files shape", () => {
    const rows = reconcile(
      [
        {
          receiverKind: "bareCall",
          rate: 0.5,
          resolved: 7557,
          attempted: 15114,
        },
      ],
      oracle,
      2,
    );
    expect(rows[0]?.withinTolerance).toBe(false);
  });

  it("reports a kind the live run never saw rather than dropping it", () => {
    const rows = reconcile([], oracle, 2);
    expect(rows.map((r) => r.receiverKind)).toContain("bareCall");
    expect(rows[0]?.withinTolerance).toBe(false);
  });
});
```

- [ ] Write `scripts/py-oracle/reconcile-live.ts`:

```ts
/**
 * Reconcile the live resolve rates against the oracle's chain output
 * (bd tea-rags-mcp-mmckn, spec component F).
 *
 * The oracle scores an OFFLINE walk; `prime` reports what the pipeline actually
 * persisted. When the two disagree by more than a couple of points, the harness
 * is scoring a corpus production does not index — that is precisely how the TS
 * wave found its generated-files hole, where the oracle read `localVar` at 864
 * of 1,014 and `prime` at 38 of 543.
 *
 * Usage:
 *   DEBUG=1 tea-rags prime ~/Dev/Collaborate/ugnest > /tmp/ugnest-prime.txt
 *   npx tsx scripts/py-oracle/reconcile-live.ts \
 *     --prime /tmp/ugnest-prime.txt --oracle <oracle json> [--tolerance 2]
 */
import { readFileSync } from "node:fs";

export interface LiveResolveRate {
  receiverKind: string;
  rate: number;
  resolved: number;
  attempted: number;
}

const RESOLVE_HEADING = "## Codegraph resolve";
const RATE_LINE = /^([A-Za-z][A-Za-z0-9]*)\s+([0-9.]+)\s+(\d+)\/(\d+)\s*$/;

/**
 * Read the `## Codegraph resolve` block. `prime` is the ONLY supported reader of
 * the persisted per-receiverKind rates — the `--json` index result does not
 * carry them and the MCP status formatter drops them — so this parser is the
 * whole live half of the reconciliation.
 */
export function parsePrimeResolveRates(stdout: string): LiveResolveRate[] {
  const lines = stdout.split("\n");
  const start = lines.findIndex((line) => line.trim() === RESOLVE_HEADING);
  if (start < 0) return [];
  const rates: LiveResolveRate[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("#")) break;
    const match = RATE_LINE.exec(line.trim());
    if (match === null) continue;
    rates.push({
      receiverKind: match[1] as string,
      rate: Number(match[2]),
      resolved: Number(match[3]),
      attempted: Number(match[4]),
    });
  }
  return rates;
}

export interface ReconciliationRow {
  receiverKind: string;
  liveRate: number;
  oracleRate: number;
  deltaPp: number;
  withinTolerance: boolean;
}

/**
 * Compare per kind. The oracle side is CHAIN OUTPUT — edges the chain emitted
 * over sites it scored — not a verdict rate: `prime` counts what the resolver
 * produced, and comparing it to a rate computed against jedi would diff two
 * different questions.
 *
 * A kind present in the oracle and absent from the live run is reported as OUT
 * of tolerance rather than skipped. That asymmetry is the point: a kind the
 * live pipeline never saw is the strongest possible parity signal.
 */
export function reconcile(
  live: readonly LiveResolveRate[],
  oracleByReceiver: readonly {
    label: string;
    sites: number;
    chainOutputEdges: number;
  }[],
  tolerancePp: number,
): ReconciliationRow[] {
  const liveByKind = new Map(live.map((rate) => [rate.receiverKind, rate]));
  return oracleByReceiver
    .map((oracle) => {
      const oracleRate =
        oracle.sites === 0 ? 0 : oracle.chainOutputEdges / oracle.sites;
      const seen = liveByKind.get(oracle.label);
      const liveRate = seen?.rate ?? 0;
      const deltaPp = (oracleRate - liveRate) * 100;
      return {
        receiverKind: oracle.label,
        liveRate,
        oracleRate,
        deltaPp,
        withinTolerance: seen !== undefined && Math.abs(deltaPp) <= tolerancePp,
      };
    })
    .sort(
      (a, b) =>
        Math.abs(b.deltaPp) - Math.abs(a.deltaPp) ||
        a.receiverKind.localeCompare(b.receiverKind),
    );
}

function main(): void {
  const read = (flag: string): string | undefined => {
    const index = process.argv.indexOf(flag);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  const primePath = read("--prime");
  const oraclePath = read("--oracle");
  if (primePath === undefined || oraclePath === undefined) {
    process.stderr.write(
      "usage: reconcile-live.ts --prime <prime stdout> --oracle <oracle json>\n",
    );
    process.exitCode = 2;
    return;
  }
  const live = parsePrimeResolveRates(readFileSync(primePath, "utf8"));
  if (live.length === 0) {
    process.stderr.write(
      "no '## Codegraph resolve' block — run the index first, then prime\n",
    );
    process.exitCode = 2;
    return;
  }
  const oracle = JSON.parse(readFileSync(oraclePath, "utf8")) as {
    byReceiver: {
      label: string;
      sites: number;
      match: number;
      fileOnly: number;
      wrongFile: number;
    }[];
  };
  const rows = reconcile(
    live,
    oracle.byReceiver.map((tally) => ({
      label: tally.label,
      sites: tally.sites,
      chainOutputEdges: tally.match + tally.fileOnly + tally.wrongFile,
    })),
    Number(read("--tolerance") ?? 2),
  );
  for (const row of rows) {
    process.stdout.write(
      `${row.receiverKind.padEnd(12)} live ${(row.liveRate * 100).toFixed(1)}%  oracle ${(row.oracleRate * 100).toFixed(1)}%  ` +
        `delta ${row.deltaPp >= 0 ? "+" : ""}${row.deltaPp.toFixed(1)}pp  ${row.withinTolerance ? "ok" : "OUT OF TOLERANCE"}\n`,
    );
  }
  if (rows.some((row) => !row.withinTolerance)) process.exitCode = 1;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`
)
  main();
```

- [ ] Run the parser tests until green:
      `npx vitest run tests/scripts/reconcile-live.test.ts`.

- [ ] Do NOT run the index. Write the handoff block below into the task's final
      report, verbatim, for the parent session to execute:

```bash
# 1. Flip ugnest's registry entry — it has codegraphEnabled false and has never
#    had a codegraph built. Confirm the alias first.
tea-rags projects list
# then set codegraphEnabled true for the ugnest entry (code_035da920)

# 2. Index with enrichments, synchronously, machine-readable.
DEBUG=1 tea-rags index-codebase --project ugnest --wait-enrichments --json

# 3. prime is the ONLY reader of the persisted per-receiverKind rates.
DEBUG=1 tea-rags prime ~/Dev/Collaborate/ugnest > /tmp/ugnest-prime.txt

# 4. Reconcile against the post-vocabulary oracle run from Task 5b.
npx tsx scripts/py-oracle/reconcile-live.ts \
  --prime /tmp/ugnest-prime.txt \
  --oracle ~/Dev/Tools/tea-rags-bench/results/python/2026-09-08-ugnest-vocab.json \
  --tolerance 2
```

- [ ] After the parent reports the output, append the result to the spec's
      appendix as `### Live reconciliation (ugnest)`: one row per receiverKind
      with live rate, oracle rate and delta in pp. If any kind is outside ±2 pp,
      the finding is a harness parity bug — name the suspected population (the
      TS analogue was `.gitignore`d generated files) and open a bead. Do NOT
      adjust the tolerance to make the table pass.

- [ ] Format and commit the script and the appendix:

```bash
npx prettier --write scripts/py-oracle/reconcile-live.ts tests/scripts/reconcile-live.test.ts \
  docs/superpowers/specs/2026-09-03-python-codegraph-e0-measurement-design.md
git add scripts/py-oracle/reconcile-live.ts tests/scripts/reconcile-live.test.ts docs/superpowers/specs
git commit -m "feat(scripts): reconcile live Python resolve rates against the oracle (mmckn)"
```

---

## Done when

- [ ] Oracle runs deterministically on all five corpora, `chainDrift` 0
      everywhere, two runs byte-identical.
- [ ] Per-corpus ground-truth coverage, `oracleDegraded` and `parseFailed`
      counts are in the spec appendix.
- [ ] Precision floors (`phantom` + `skippedInProject` per corpus) recorded, and
      the post-vocabulary run shows `agreeExternal` up with neither floor up.
- [ ] Chain-tally `edges` / `fileOnly` / `unresolved` unchanged on all five.
- [ ] Perf gate met per corpus: peak RSS ≤ +20%, wall ≤ +25%.
- [ ] ugnest live vs oracle within ±2 pp per receiverKind, or the gap explained
      and beaded.
- [ ] Pull order confirmed or reordered in the program spec, with the corpus
      that carried the evidence named.
- [ ] Ruby untouched:
      `git diff --stat main -- src/core/domains/language/ruby tests/core/domains/language/ruby`
      is empty.
- [ ] Beads: E0 epic `mmckn` closed with the baseline tables as evidence;
      `q9u85` re-pointed at `hasFile` / `hasFilesUnder`.
