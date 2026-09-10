# Python Frontier E6 — Build Performance and Memory Parity Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Settle the user's E6 requirement — "building the Python codegraph must
be comparable in speed and memory consumption to Ruby/TS" — with a normalized,
reproducible measurement rather than an impression, and fix whatever the
measurement says is out of band. The pass criterion is **Python within ±25 % of
BOTH the Ruby and the TypeScript figure on each normalized metric**; a metric
outside that band gets a CPU/heap profile, a named cause, and a fix whose gate
is byte-identical resolver output on every language.

The requirement is a comparison of THREE languages, and today it cannot be run
at all: `scripts/codegraph-chain-tally.ts` — the one harness that walks a corpus
and drives the production resolver over it — has chain specs for `python` and
`java` only (`CHAINS`, `scripts/codegraph-chain-tally.ts:123-151`). There is no
Ruby leg and no TypeScript leg in it, and the harness prints neither wall time
nor RSS. E6.0a builds the missing measuring instrument; E6.0b and E6.0c run it;
E6.1 fixes what it finds. Nothing in E6.0 may change a resolver answer.

**Architecture:** Four moves, all of them in `scripts/`, none in `src/`.

1. **`--time-only` in the tally.** `run()` already builds the production
   resolver for EVERY language — `factory.create(lang).resolver`
   (`codegraph-chain-tally.ts:433`) — and only the defer A/B needs
   `CHAINS[lang].build()`. A mode that skips the rebuilt chain, skips
   `chainDrift`, and resolves through `production.resolve` alone therefore works
   for `ruby` and `typescript` with **zero new chain rebuilds**. Scored
   extensions come from `CODEGRAPH_LANGUAGES` (`provider.ts:196`) by inverting
   its extension→language map, so no per-language hand-list is added either.
   This is deliberately NOT "add a TypeScript ChainSpec": `TSCallResolver`'s
   strategy array is private and its Program-cache wiring is 90 lines of
   ordering commentary (`ts-resolver.ts:355-430`), so a rebuilt copy would drift
   the first time anyone reorders it, and a drifted rebuild voids the numbers by
   the harness's own rule.
2. **A `--timing` block the harness prints itself.** `pass1Ms` (walk + extract +
   symbol table), `pass2Ms` (resolve), `totalMs`, `peakRssMb` sampled
   in-process, plus `files`, `sites`, `loc`. Printed by the harness rather than
   read off `/usr/bin/time` because the external wall includes ~0.5 s of `tsx`
   transpile startup that has nothing to do with either language, and because
   the walk/resolve split is the whole diagnostic value: a Python outlier in
   pass 1 is a walker problem and in pass 2 a resolver problem.
3. **An RSS tree sampler** (`scripts/spikes/rss-tree-sampler.sh`) for the LIVE
   leg only. The offline harness is single-process, so `/usr/bin/time -l`'s
   parent figure IS its peak; the live pipeline forks a 4-thread enrichment pool
   plus a DuckDB daemon, and the parent's RSS misses all of it.
4. **Two matrices and a verdict table.** Offline (3 languages × comparable
   corpora) and live (`--force-enrichments codegraph --languages <lang>`), each
   reduced to the same four normalized columns.

**Tech Stack:** TypeScript (NodeNext, `strict`), `tsx` for the harnesses, POSIX
`sh` + `ps` for the sampler, `/usr/bin/time -l` (macOS: reports
`maximum resident set size` in **bytes**, not the KB a Linux `time -v` reports).
No new dependency, no schema change, no `src/` change in E6.0.

**Spec:**
`docs/superpowers/specs/2026-09-03-python-codegraph-unification-program-design.md`
— the program spec E6 closes against. Format and gate protocol are inherited
verbatim from
`docs/superpowers/plans/2026-09-10-python-e4-1-dispatch-fanout.md`. The
measurement precedent is
`docs/superpowers/plans/2026-09-08-python-codegraph-e0-measurement.md` — E0
already established
`/usr/bin/time -l npx tsx scripts/codegraph-chain-tally.ts --corpus <root> --lang python --quiet`
as the producer and froze its output into `scripts/lib/codegraph-corpora.json`
as `baseline.peakRssMb` / `baseline.wallSeconds`. E6 extends that producer to
three languages; it does not invent a second one.

---

## Decision record

### 1 — What exists per language, verified 2026-09-11 on `worktree-py-frontier-e4` @ `7d80ae741`

| language       | offline walk+resolve harness                                      | reports wall? | reports RSS? | usable for E6 as-is |
| -------------- | ----------------------------------------------------------------- | ------------- | ------------ | ------------------- |
| **Python**     | `scripts/codegraph-chain-tally.ts --lang python`                  | no            | no           | via `/usr/bin/time` |
| **Java**       | `scripts/codegraph-chain-tally.ts --lang java`                    | no            | no           | out of E6 scope     |
| **Ruby**       | `scripts/spikes/ruby-resolver-parity.ts` — **two resolvers**      | no            | no           | **no**              |
| **TypeScript** | none of tally shape; `scripts/ts-codegraph-typechecker-oracle.ts` | no            | no           | **no**              |

**Ruby.** `ruby-resolver-parity.ts` resolves every call site TWICE — this tree's
`RubyCallResolver` and `--before-root`'s, and without `--before-root` both sides
are this tree (`scripts/spikes/ruby-resolver-parity.ts:20-26`). Its wall is
therefore ~2× a single resolve pass plus a `drift` cross-check, which is a
parity gate's cost, not a build's. The task brief proposed adding `--time-only`
/ `--after-only` there. **Rejected:** it would leave three harnesses with three
walk implementations to keep normalized, when all three already share
`collectSourceFiles` / `extractFile` / `buildSymbolDefs` exported from
`ts-codegraph-typechecker-oracle.ts`. One `--time-only` in the tally covers
Ruby, TypeScript and Python from ONE walk implementation, which is what makes
the three numbers comparable at all.

**TypeScript.** `ts-codegraph-typechecker-oracle.ts` (2,200 lines) is a
CORRECTNESS oracle: it builds its own `ts.Program` to obtain ground truth, so
timing it measures the oracle's checker, not the build.
`scripts/spikes/ ts-live-resolve-harness.ts` IS a real timing/profiling
instrument — production `resourceLimits` mirrored in a `worker_threads` isolate,
CPU profile, `stats.json` — and despite its name and its docblock it is
re-pointable: the corpus root is `process.env.TAXDOME_ROOT ?? ~/Dev/Job/taxdome`
(`scripts/spikes/ts-live-resolve-worker.ts:87`). It is the right tool for E6.1
PROFILING of a TypeScript outlier and the wrong tool for E6.0b's matrix, because
it measures resolve only, inside a worker, under a profiler.

### 2 — The corpora, and why these three

Sizes below are `find` counts of source files and `cat | wc -l` of their lines,
taken 2026-09-11. They are UPPER BOUNDS on what a run walks: the harness applies
`.gitignore` + the codegraph exclusion filter (`buildCorpusExclusionFilter`), so
`scored files` is always smaller. Scored-file and call-site counts marked
"measured" come from the E4.0.4 walk record
(`docs/superpowers/plans/2026-09-10-python-e4-0-measurement.md:707-716`).

| corpus       | lang       | path                                          | src files | LOC     | scored files | call sites   |
| ------------ | ---------- | --------------------------------------------- | --------- | ------- | ------------ | ------------ |
| **polar**    | python     | `~/Dev/Tools/tea-rags-bench/corpora/polar`    | 1,894     | 505,938 | 1,339 meas.  | **56,710**   |
| **netbox**   | python     | `~/Dev/Tools/tea-rags-bench/corpora/netbox`   | 1,221     | 364,431 | 1,038 meas.  | **44,126**   |
| **mastodon** | ruby       | `~/Dev/Tools/tea-rags-bench/corpora/mastodon` | 3,197     | 183,059 | E6.0b counts | ~42,057 †    |
| **tea-rags** | typescript | this repo's `src/`                            | 976       | 127,678 | E6.0b counts | E6.0b counts |
| flask        | python     | `~/Dev/OpenSource/codegraph-test/flask`       | —         | —       | 35 meas.     | 1,346        |

† 42,057 is the figure the E6 brief carries; nothing in this repo records it, so
E6.0b's own run is what establishes it. flask is listed because it is the
30-second smoke corpus, not a matrix row.

**Ruby's largest corpus is mastodon and TypeScript's is this repo.** The bench
tree holds exactly five corpora — `graphql-ruby`, `httpx`, `mastodon`, `netbox`,
`polar` — and `~/Dev/OpenSource/codegraph-test/` holds `commons-lang`,
`express`, `gin`, `flask`, `huginn`, `octokit.rb`, `ripgrep`, `sinatra`. None of
them is a large TypeScript project. The only large TS corpora on this machine
are this repo (976 files / 128k LOC) and **taxdome** (36,593 `.ts`/`.tsx`
outside `node_modules`), and taxdome is the user's work repo: it is measured
ONLY if the orchestrator confirms it. E6.0b's TypeScript row is therefore
**tea-rags itself**, which is defensible for a per-site normalized comparison
and is stated as a limitation in the verdict, not hidden: 128k LOC against
polar's 506k means the absolute walls are not comparable and only the normalized
columns are.

**mastodon is 3,197 Ruby files against polar's 1,894 Python files but only 36 %
of polar's lines.** That is the exact reason per-corpus absolute wall answers
nothing and decision 3 exists.

### 3 — Normalization: per call site is the fair one, per 10k LOC is the honest second

Four normalized columns, and every raw input to them is produced by the same
`--time-only` run:

| normalized metric      | formula                         | what it isolates                       |
| ---------------------- | ------------------------------- | -------------------------------------- |
| **s / 1k sites**       | `totalMs / 1000 / (sites/1000)` | resolver cost per unit of work         |
| **sites / s**          | `sites / (totalMs/1000)`        | the same number inverted, for reading  |
| **s / 10k LOC**        | `totalMs / 1000 / (loc/10000)`  | walker + parse cost per unit of source |
| **peak MB / 1k files** | `peakRssMb / (files/1000)`      | retained per-file state                |

**Per call site is the primary, and the reason is measurable in this table.**
polar carries 56,710 sites over 505,938 lines (112 sites per 1k LOC); mastodon
carries ~42,057 over 183,059 (230 per 1k LOC) — Ruby's call-site density is
roughly **2× Python's** on these corpora. A per-LOC-only comparison therefore
charges Ruby double for a language property and would declare Python "faster"
while it resolves half as many sites. A per-site-only comparison has the mirror
flaw: it hides a walker that is slow per byte, because the walk cost lands in a
denominator it does not scale with. **Both are reported for every row; the ±25 %
verdict is taken on per-site, and a per-LOC breach with a per-site pass is
recorded as a WALKER finding rather than a resolver one.** `pass1Ms` / `pass2Ms`
is what tells the two apart, which is why the harness splits them.

Peak RSS is normalized **per 1k files, not per site**: what a run retains is the
symbol table plus the run-global type channels, and both scale with declarations
(files), not with call sites. Absolute peak RSS is also reported — a 3 GB peak
is a problem whatever it divides by.

### 4 — Fairness controls, each with the reason it is not optional

- **`env -u NODE_OPTIONS` on every run, no exceptions.** This machine carries a
  fish universal `NODE_OPTIONS --max_old_space_size=8192`
  (`~/.config/fish/fish_variables:3`, confirmed live in this session). A
  process-wide `--max_old_space_size` silently OVERRIDES per-worker
  `resourceLimits`, which is the machine-level gotcha that cost the 6aytq epic
  real time (`memory/project_6aytq_ts_codegraph_5min_delivered.md:61-66`). Left
  set, the live legs measure a heap ceiling that is not production's, and the
  three languages get different effective ceilings depending on which of them
  actually approaches 8 GB. Then set ONE explicit ceiling for all three:
  `NODE_OPTIONS=--max-old-space-size=8192` passed per-command.
- **`CODEGRAPH_TS_TYPECHECKER` is recorded in BOTH states for TypeScript.** It
  defaults to ON (`ts-resolver.ts:277-286`), and it is the pass that builds a
  `ts.Program` — the single largest memory consumer in any of the three
  resolvers (`memory/project_ts_program_memory_cost_taxdome.md`: a real Program
  build drove this machine to 92 % swap). A Python-vs-TypeScript memory verdict
  taken only against `=1` compares a type-checked build to a tree-sitter build.
  Report `=0` (structural parity — the config Python and Ruby actually are) as
  the **verdict row**, and `=1` (production default) as a second row labelled as
  such. Do not average them.
- **Identical worker counts.** Offline is single-process for all three, so this
  binds the live leg only: `INGEST_TUNE_ENRICHMENT_POOL_SIZE=4` explicitly on
  every live command. 4 is the default (`src/bootstrap/config/schemas.ts:97`),
  but a default is not a control — an operator override in a shell profile would
  silently give one language more threads.
- **The dispatch layer ON for all three, `--no-dispatch` recorded for Python
  only.** Production consults it first (`resolution-runner.ts:557`), so ON is
  the honest configuration. The extra `--no-dispatch` Python row exists to
  attribute a Python-only regression to E4.0.3's layer rather than to the chain.
- **Warm cache: first run discarded, min of the next 3 reported.** Min, not mean
  — the minimum is the run least polluted by background work, and this machine
  is not a quiet lab. Machine otherwise idle: no parallel corpus run, no
  reindex, no `npm test`.
- **The pyright/jedi oracles are NOT involved.** They are correctness tooling
  that reads site-packages through a Python interpreter; nothing in the build
  path calls them, and their cost is not the build's cost.

### 5 — The live legs, and the Ruby one is registered but stale

`node build/cli/index.js projects list` on 2026-09-11 (read-only) — the rows E6
can use:

| alias            | path                                          | chunks | last indexed | index ver |
| ---------------- | --------------------------------------------- | ------ | ------------ | --------- |
| `ugnest`         | `~/Dev/Collaborate/ugnest`                    | 3.1k   | 1d ago       | 1.40.0    |
| `tea-rags`       | `~/Dev/Tools/tea-rags-mcp`                    | 21.7k  | 12h ago      | 1.40.0    |
| `bench-mastodon` | `~/Dev/Tools/tea-rags-bench/corpora/mastodon` | 9.0k   | 32d ago      | 1.38.1 ⚠  |
| `taxdome`        | `~/Dev/Job/taxdome`                           | 134.2k | 1d ago       | 1.40.0    |

Also registered and NOT used by E6: `bench-graphql-ruby` (3.4k, 70d, 1.33.0),
`octokit` (1.5k, 72d), `huginn-sd-val` (2.0k, 70d), `gin-go`, `ripgrep-rust`,
`commons-lang-java`, `taxdome-marketplace`, plus ~30 unnamed fixture rows under
`~/.claude/jobs/`. The bench Python corpora — polar, netbox, httpx — are NOT
registered at all; only flask is, unnamed and at 1.31.0.

**A Ruby live leg does not need a new registration.** The brief anticipated
proposing mastodon as a new bench alias; it is already `bench-mastodon`. What it
needs instead is a **version bump from 1.38.1 to 1.40.0**, and that is the
user-gated part: whether a `--force-enrichments codegraph --languages ruby` run
over a 1.38.1 index is coherent, or whether it needs a `--force` first, depends
on whether the payload schema moved between those versions. E6.0c Step 1 asks
that question with `get_index_status` BEFORE proposing any run, and the run
itself is gated on the user's "запускай" per
`memory/feedback_reindex_authorization_single_use.md` — one authorization, one
run, and a failed run does not carry the authorization forward.

**The Python live leg has a precondition of its own.**
`scripts/lib/codegraph-corpora.json:17` records that ugnest's registry entry
(`code_035da920`) has **`codegraphEnabled false`**. If that is still true, a
`--force-enrichments codegraph` run over ugnest produces no codegraph phase at
all and the leg silently measures nothing. E6.0c Step 1 verifies it first.

**taxdome is not in the matrix.** It is the user's work repo and the brief bars
it without orchestrator confirmation. Its recorded live figure — 164.7 s for
TS-only codegraph force-resolve over ~10,580 TS files
(`memory/project_6aytq_ts_codegraph_5min_delivered.md`) — is quoted in the
verdict as a REFERENCE POINT for what a large TS live run costs, never as a
matrix row, because it was measured on a different build at a different time.

### 6 — RSS of the process tree: `ps`-sampling, and why not the alternatives

The live pipeline is a parent CLI process plus a `WorkerPoolEnrichmentExecutor`
of 4 threads plus a DuckDB daemon process. Three ways to get its peak:

1. **`/usr/bin/time -l` on the parent.** Rejected for the live leg. Worker
   THREADS share the parent's RSS so they are counted, but the DuckDB daemon is
   a separate PROCESS and is not — and the daemon is the write path
   (`memory/project_codegraph_daemon.md`), so its resident set is part of what
   the build costs. Kept for the OFFLINE leg, where there is exactly one process
   and the parent figure is exact.
2. **The pipeline's own debug log.** Rejected: `DEBUG=1` gives per-phase
   DURATIONS (`phaseTimings.record("pass1", …)`,
   `codegraph/symbols/provider.ts:1695`) but no per-worker memory. There is a
   heap-ceiling reporter at worker boot
   (`enrichment/infra/heap-ceiling-enforcement.ts`) and it reports the CEILING,
   not the usage.
3. **A `ps`-sampling loop over the process tree at 250 ms.** **Chosen.** It is
   the only one that sees the daemon, it needs no code change in `src/`, and 250
   ms over a 60–300 s run is 240–1,200 samples — enough that a peak lasting
   longer than a quarter second cannot hide, and cheap enough that the sampler
   is not itself a load. Its known blind spot is a spike shorter than the
   interval, which is recorded as a limitation rather than papered over.

The sampler sums RSS across the tree at each tick and keeps the max of the sums,
not the sum of the per-process maxes: the question is how much memory the
machine holds at once, and the per-process maxima do not have to co-occur.

---

## Global Constraints

- **`env -u NODE_OPTIONS` prefixes EVERY measurement command in this plan**, and
  the intended ceiling is then passed explicitly. A run whose transcript does
  not show it is void and is re-run.
- **No `src/` change in E6.0.** E6.0a touches `scripts/` only. If a task finds
  itself editing a resolver to make a measurement possible, it stops and
  reports.
- **No resolver behaviour change anywhere in E6 without an A/B.** Any E6.1 fix
  gates on `codegraph-chain-tally.ts --defer`-style byte-identical output:
  Python's five corpora AND Ruby's `ruby-resolver-parity.ts` mismatch count AND
  the TypeScript oracle's verdict table must be **unchanged, parity 0**. A
  performance fix that moves one edge is not a performance fix.
- **No reindex, no `--force`, no `--force-enrichments` without explicit user
  authorization**, per `.claude/CLAUDE.md` "Never auto-build / auto-reindex".
  One authorization covers ONE run.
- **Machine otherwise idle for every timed run.** No parallel corpus job, no
  test suite, no other agent's build. A run that overlapped one is discarded,
  not corrected.
- **Min of 3 after a discarded warm-up run**, per corpus per configuration.
- Tool calls ≤ 8 minutes. Writes ≤ 120 lines per call. Reads ≤ 300-line slices,
  ≤ 3 files per turn.
- Commits: `type(scope): … (e6)`, trailer
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` only.
- Each task runs in a FRESH Opus executor in its own agent worktree, whose Step
  0 ff-merges the integration branch.

---

## File Structure

```text
scripts/
  codegraph-chain-tally.ts          MODIFIED — --time-only, --timing block, repoRoot
  spikes/
    rss-tree-sampler.sh             NEW — ps-sampling peak RSS over a process tree
  lib/
    codegraph-corpora.json          MODIFIED (E6.0b) — e6 baseline block per corpus
tests/
  scripts/
    codegraph-chain-tally.time-only.test.ts   NEW — the mode's unit gate
docs/superpowers/
  plans/2026-09-11-python-e6-perf-parity.md   this plan — matrices filled in place
  specs/2026-09-03-python-codegraph-unification-program-design.md  MODIFIED (E6-close)
```

## Context the implementer needs

**The tally's shape, read off `scripts/codegraph-chain-tally.ts` @
`7d80ae741`.** `run(root, lang, deferPass, limit, quiet, dispatch)` at `:414`
does, in order: `collectSourceFiles` (`:592`) → a per-file loop calling
`extractFile` + `symbolTable.upsertFile` + `absorbTypeChannels` (`:600-616`) →
build `MapHierarchyView` at the pass-1/pass-2 barrier (`:634`) → a per-call-site
loop calling `resolveViaChain(baselineChain, …)`, `production.resolve(…)` for
the drift check, and `scoreFan` (`:636-660`). The two loops ARE pass 1 and pass
2; nothing between them needs a new seam to time them.

**`CHAINS` is the only per-language thing in the file** (`:123-151`) and it is
consulted at exactly three places: `spec.build()` for the baseline chain
(`:435`), the same for the variant (`:437`), and `spec.extensions.includes(…)`
to decide which files are SCORED (`:613`). `--time-only` bypasses the first two
and replaces the third; it touches nothing else.

**Extensions invert cleanly.** `CODEGRAPH_LANGUAGES`
(`src/core/domains/trajectory/codegraph/symbols/provider.ts:196`) maps
`".ts" → { language: "typescript" }`, `".tsx" → typescript`, `".py" → python`,
`".rb" → ruby`, and so on, so
`Object.entries(CODEGRAPH_LANGUAGES).filter(([, c]) => c.language === lang)`
yields the scored set for any language the engine walks. `.tsx` is why a
hand-written list is the wrong move.

**The TypeScript resolver needs the corpus root.** `TSCallResolver`'s `repoRoot`
defaults to `process.cwd()` (`ts-resolver.ts:325-328`) and the tally constructs
`new LanguageFactory()` with no options (`:432`), so a TypeScript run would
resolve every path against the tea-rags checkout instead of the corpus — the
exact class of bug `memory/project_codegraph_repo_root_field_collision.md`
records. `LanguageFactory`'s constructor already takes it
(`src/core/domains/language/factory.ts:100-102`).

**The smoke baseline, measured 2026-09-11 in this session** (flask, python,
`/usr/bin/time -l npx tsx … --quiet`): 35 scored files, 449 symbols, 1,346 call
sites, edges 345, `chain drift 0`, **1.57 s real, 335,544,320 B peak RSS = 320
MB**. E0's frozen figures for the same corpus are 1.1 s / 275 MB
(`scripts/lib/codegraph-corpora.json`), and the difference is partly `tsx`
startup and partly five epics of new passes — which is itself a datum E6.0b's
`--timing` block resolves by excluding startup.

**`peak memory footprint` is NOT peak RSS.** `/usr/bin/time -l` prints both; the
flask run showed `maximum resident set size 335544320` and
`peak memory footprint 51026880`. The first is the one E0 recorded and the one
E6 uses. On macOS both are BYTES.

---

## Task E6.0a — the measuring instrument

**Files:**

- `scripts/codegraph-chain-tally.ts` — MODIFY
- `scripts/spikes/rss-tree-sampler.sh` — NEW
- `tests/scripts/codegraph-chain-tally.time-only.test.ts` — NEW

**Interfaces:**

```ts
/** Wall/heap accounting for one tally run. Present only under `--timing`. */
export interface ChainTallyTiming {
  /** Walk + extract + symbol table + type channels, ms. */
  pass1Ms: number;
  /** Resolve every call site, ms. Excludes the LOC count and the report. */
  pass2Ms: number;
  /** pass1Ms + pass2Ms. NOT the process wall — `tsx` startup is excluded. */
  totalMs: number;
  /** Max `process.memoryUsage().rss` seen by a 250 ms in-process sampler, MB. */
  peakRssMb: number;
  /** Lines in the SCORED files, counted after pass 2 so it cannot pollute either. */
  loc: number;
}
```

```ts
export function scoredExtensionsFor(lang: string): readonly string[];
```

**Steps:**

- [ ] **Step 0 — worktree.** `EnterWorktree` a fresh agent worktree, then
      `git fetch && git merge --ff-only worktree-py-frontier-e4` so the base is
      the integration branch, not `origin/main`
      (`memory/project_enterworktree_stale_base.md`). Then `npm run build` once
      — a fresh worktree has no `build/` and the chunker pool forks the compiled
      worker, so pre-commit fails until it exists. Do NOT `npm link`.

- [ ] **Step 1 — RED: the extension inversion.** New file
      `tests/scripts/codegraph-chain-tally.time-only.test.ts`:

  ```ts
  import { describe, expect, it } from "vitest";

  import { scoredExtensionsFor } from "../../scripts/codegraph-chain-tally.js";

  describe("scoredExtensionsFor", () => {
    it("gives TypeScript both grammars", () => {
      expect([...scoredExtensionsFor("typescript")].sort()).toEqual([
        ".ts",
        ".tsx",
      ]);
    });

    it("gives Ruby and Python their single extension", () => {
      expect(scoredExtensionsFor("ruby")).toEqual([".rb"]);
      expect(scoredExtensionsFor("python")).toEqual([".py"]);
    });

    it("agrees with the hand-written CHAINS entries it replaces", () => {
      expect(scoredExtensionsFor("python")).toEqual([".py"]);
      expect(scoredExtensionsFor("java")).toEqual([".java"]);
    });

    it("throws rather than scoring nothing for an unwalked language", () => {
      expect(() => scoredExtensionsFor("cobol")).toThrow(/cobol/);
    });
  });
  ```

  Run `npx vitest run tests/scripts/codegraph-chain-tally.time-only.test.ts`. It
  MUST fail on the missing export. Record the failure text in the commit.

- [ ] **Step 2 — GREEN: implement it** in `scripts/codegraph-chain-tally.ts`,
      next to `CHAINS`:

  ```ts
  /**
   * Extensions whose call sites this language's resolver owns, inverted out of
   * the engine's own extension→language map rather than hand-listed. `.tsx` is
   * why: a hand-list that forgets it silently scores half a TypeScript corpus
   * and reports the wall as if it walked all of it.
   */
  export function scoredExtensionsFor(lang: string): readonly string[] {
    const exts = Object.entries(CODEGRAPH_LANGUAGES)
      .filter(([, cfg]) => cfg.language === lang)
      .map(([ext]) => ext);
    if (exts.length === 0)
      throw new Error(`language '${lang}' has no walkable extension`);
    return exts;
  }
  ```

  Then replace the `spec.extensions.includes(...)` test at `:613` with a
  `scoredExts` computed once before the loop: under `--time-only` it comes from
  `scoredExtensionsFor(lang)`, otherwise from `spec.extensions` (unchanged, so
  the existing python/java runs are byte-identical). Test goes GREEN.

- [ ] **Step 3 — the in-process RSS sampler.** Above `run()`:

  ```ts
  /**
   * Peak `rss` over the run, sampled rather than read at the end: V8 releases
   * pages back before a run finishes, so a single end-of-run reading under-
   * reports the peak by the whole symbol table on a large corpus. 250 ms is the
   * same interval the live sampler uses, so the two levels' numbers mean the
   * same thing. `unref` so the timer cannot hold the process open.
   */
  function startRssSampler(): { stop: () => number } {
    let peak = process.memoryUsage().rss;
    const timer = setInterval(() => {
      const rss = process.memoryUsage().rss;
      if (rss > peak) peak = rss;
    }, 250);
    timer.unref();
    return {
      stop: () => {
        clearInterval(timer);
        const rss = process.memoryUsage().rss;
        return Math.round(Math.max(peak, rss) / 1024 / 1024);
      },
    };
  }
  ```

- [ ] **Step 4 — `--time-only` and `--timing` in `parseArgs`.** Add to the
      returned object, keeping every existing key:

  ```ts
    timeOnly: argv.includes("--time-only"),
    timing: argv.includes("--timing") || argv.includes("--time-only"),
  ```

  `--time-only` implies `--timing`: a mode whose only purpose is the numbers
  should not need a second flag to print them. `--timing` alone stays legal so a
  python `--defer` run can also be timed.

- [ ] **Step 5 — wire both through `run()`.** Widen the signature to an options
      object OR append two parameters — the executor picks, but `run()` already
      takes six positionals and a seventh and eighth are a readability problem.
      Recommended: `run(root, lang, deferPass, limit, quiet, dispatch, opts?)`
      with `opts?: { timeOnly?: boolean; timing?: boolean }`. Inside:

  ```ts
  const spec = CHAINS[lang];
  const timeOnly = opts?.timeOnly === true;
  // The chain rebuild is what needs a spec; the production resolver does not.
  if (!spec && !timeOnly) {
    throw new Error(
      `no chain spec for language '${lang}' (have: ${Object.keys(CHAINS).join(", ")}); ` +
        `--time-only measures any language the engine walks`,
    );
  }
  if (timeOnly && deferPass)
    throw new Error("--defer needs a rebuilt chain; drop --time-only");
  ```

  Guard the three chain uses:

  ```ts
  const baselineChain = timeOnly ? null : spec!.build();
  const variantChain = deferPass
    ? spec!.build().map(/* … unchanged … */)
    : null;
  ```

  and in the call-site loop:

  ```ts
  // --time-only asks production directly. There is no rebuilt chain to drift
  // FROM, so `chainDrift` stays 0 and the report says the check did not run —
  // it must never read as "0 drift, verified".
  const baseline = timeOnly
    ? production.resolve(call, ctx)
    : resolveViaChain(baselineChain!, call, ctx);
  if (!timeOnly && !sameTarget(baseline, production.resolve(call, ctx)))
    chainDrift++;
  ```

  Add `timeOnly` to `RunResult` so the reporter can say so.

- [ ] **Step 6 — time the two passes and count LOC.** Wrap the existing loops;
      do not move them.

  ```ts
  const sampler = opts?.timing === true ? startRssSampler() : null;
  const pass1Start = performance.now();
  // … the existing collectSourceFiles + per-file extraction loop …
  const pass1Ms = performance.now() - pass1Start;

  const pass2Start = performance.now();
  // … the existing hierarchy build + per-call-site loop …
  const pass2Ms = performance.now() - pass2Start;

  // AFTER pass 2, so this second read pollutes neither number. Counted over the
  // SCORED files only: the normalization is "this language's seconds per this
  // language's lines", and a polyglot corpus's other files are symbol-table
  // input, not the walked source under test.
  let loc = 0;
  if (opts?.timing === true) {
    for (const extraction of scored) {
      const text = readFileSync(resolvePath(root, extraction.relPath), "utf8");
      loc += text.length === 0 ? 0 : text.split("\n").length;
    }
  }
  const timing: ChainTallyTiming | undefined =
    sampler === null
      ? undefined
      : {
          pass1Ms,
          pass2Ms,
          totalMs: pass1Ms + pass2Ms,
          peakRssMb: sampler.stop(),
          loc,
        };
  ```

  `readFileSync` is NOT imported today — the file imports `writeFileSync` only
  (`scripts/codegraph-chain-tally.ts:44`). Add it.

- [ ] **Step 7 — give TypeScript the corpus root.** One line at `:432`:

  ```ts
  // TSCallResolver resolves every candidate path against repoRoot, defaulting
  // to process.cwd() — which for a harness run is the tea-rags checkout, not
  // the corpus. Left unset, a TypeScript run finds no files and declines every
  // call while still LOOKING like a valid walk (the f4wcm class of defect).
  const factory = new LanguageFactory({ repoRoot: root });
  ```

  This changes nothing for python/java: neither resolver reads `repoRoot`.
  Confirm that claim in Step 10 — the flask python smoke must still print
  `edges 345` and `chain drift 0` exactly.

- [ ] **Step 8 — print the block.** In `main()`, after the CHAIN OUTPUT lines:

  ```ts
  if (result.timing) {
    const t = result.timing;
    const secs = t.totalMs / 1000;
    const perKSites = (secs / (result.rows.length / 1000)).toFixed(3);
    const per10kLoc = (secs / (t.loc / 10000)).toFixed(3);
    const mbPerKFiles = (t.peakRssMb / (result.files / 1000)).toFixed(0);
    out.push(
      "",
      "TIMING (harness-internal; excludes tsx startup)",
      `  pass1 ${(t.pass1Ms / 1000).toFixed(2)}s · pass2 ${(t.pass2Ms / 1000).toFixed(2)}s` +
        ` · total ${secs.toFixed(2)}s · peak RSS ${t.peakRssMb} MB`,
      `  ${result.files} scored files · ${result.rows.length} sites · ${t.loc} LOC`,
      `  normalized: ${perKSites} s/1k sites · ${(result.rows.length / secs).toFixed(0)} sites/s` +
        ` · ${per10kLoc} s/10k LOC · ${mbPerKFiles} MB/1k files`,
    );
    if (result.timeOnly)
      out.push(
        "  --time-only: production resolver only, chain-drift check NOT run",
      );
  }
  ```

  The `--json` payload already spreads `result`, so `timing` and `timeOnly` ride
  along with no further change.

- [ ] **Step 9 — the RSS tree sampler.** NEW
      `scripts/spikes/rss-tree-sampler.sh`, `chmod +x`. It exists because
      `/usr/bin/time -l` on the CLI parent misses the DuckDB daemon, which is a
      separate process and part of the build's cost (decision 6).

  ```sh
  #!/bin/sh
  # Peak resident set of a process tree, sampled at 250 ms.
  #
  #   scripts/spikes/rss-tree-sampler.sh <label> <command …>
  #
  # Runs <command> in the background, then every 250 ms sums the RSS of every
  # process whose session includes it — the CLI, its worker threads (which share
  # the parent's RSS and are therefore already counted) and the DuckDB daemon,
  # which is NOT. Keeps the max of the per-tick SUMS, not the sum of per-process
  # maxima: the question is how much the machine holds AT ONCE, and the maxima
  # need not co-occur.
  #
  # Known blind spot: a spike shorter than 250 ms is invisible. Report the
  # interval alongside the number rather than pretending otherwise.
  set -eu

  label="$1"
  shift

  "$@" &
  pid=$!

  peak=0
  while kill -0 "$pid" 2>/dev/null; do
    # ps rss is KILOBYTES on macOS. pgrep -P is one generation; -d '' recursion
    # is not worth it here because the daemon is a direct child.
    kids=$(pgrep -P "$pid" 2>/dev/null | tr '\n' ' ')
    sum=$(ps -o rss= -p "$pid" $kids 2>/dev/null | awk '{s+=$1} END {print s+0}')
    [ "$sum" -gt "$peak" ] && peak=$sum
    sleep 0.25
  done

  wait "$pid" || status=$?
  printf '%s peak-tree-rss-mb %s (250ms sampling)\n' "$label" "$((peak / 1024))" >&2
  exit "${status:-0}"
  ```

  **Verify the sampler before trusting it**, in the same step: run it around a
  process with a known footprint —
  `scripts/spikes/rss-tree-sampler.sh smoke node -e "const b=Buffer.alloc(600*1024*1024,1); setTimeout(()=>console.log(b[0]),3000)"`
  must report ≳ 600 MB. A sampler that reports 40 MB there is wired wrong and
  every live number taken with it is void.

- [ ] **Step 10 — verify the instrument on three languages, small.** No corpus-
      scale run in this task. All four commands under `env -u NODE_OPTIONS`:

  ```bash
  # python — must reproduce the pre-change numbers exactly
  env -u NODE_OPTIONS npx tsx scripts/codegraph-chain-tally.ts \
    --corpus ~/Dev/OpenSource/codegraph-test/flask --lang python --quiet --timing
  # expect: 35 scored files · 1346 sites · edges 345 · chain drift 0

  # ruby — a language with no ChainSpec, small corpus
  env -u NODE_OPTIONS npx tsx scripts/codegraph-chain-tally.ts \
    --corpus ~/Dev/OpenSource/codegraph-test/sinatra --lang ruby --quiet --time-only

  # typescript — capped, only to prove the leg runs and repoRoot lands
  env -u NODE_OPTIONS npx tsx scripts/codegraph-chain-tally.ts \
    --corpus "$PWD" --lang typescript --limit 200 --quiet --time-only

  # the refusal path
  env -u NODE_OPTIONS npx tsx scripts/codegraph-chain-tally.ts \
    --corpus ~/Dev/OpenSource/codegraph-test/sinatra --lang ruby --quiet
  # expect: throws "no chain spec for language 'ruby'", naming --time-only
  ```

  Gate: the python line is UNCHANGED from the pre-change run, ruby and
  typescript both report non-zero `sites` and non-zero `edges`. A TypeScript run
  that reports `edges 0` means Step 7 did not land — do not proceed.

- [ ] **Step 11 — full gate + commit.** `npx tsc --noEmit`,
      `npm run test:coverage`, `npx prettier --write` on the touched files.
      Commit:

  ```text
  feat(scripts): time-only tally mode and per-pass timing for three languages (e6)

  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  ```

**Task E6.0a is done when** the four Step 10 commands behave as stated, the
sampler passes its 600 MB self-check, and `git diff --stat` shows changes in
`scripts/` and `tests/` only — zero lines under `src/`.

---

## Task E6.0b — the offline matrix

**Files:**

- `docs/superpowers/plans/2026-09-11-python-e6-perf-parity.md` — the tables
  below, filled in place
- `scripts/lib/codegraph-corpora.json` — an `e6` block per Python corpus

**Interfaces:** none. This task runs commands and records numbers.

**Steps:**

- [ ] **Step 0 — worktree**, as E6.0a Step 0, ff-merging the branch that carries
      E6.0a.

- [ ] **Step 1 — declare the machine quiet.** `ps aux | sort -nrk 3 | head -5`
      and confirm nothing above a few percent CPU. No parallel agent build, no
      reindex, no test suite. Record the check in the commit body — a run whose
      transcript cannot show it was quiet is not evidence.

- [ ] **Step 2 — the run function.** Every row is produced by exactly this, four
      times (one discarded warm-up, then three), min reported:

  ```bash
  env -u NODE_OPTIONS NODE_OPTIONS=--max-old-space-size=8192 \
    npx tsx scripts/codegraph-chain-tally.ts \
      --corpus <CORPUS> --lang <LANG> --quiet --time-only \
      --json ~/.claude/jobs/<job>/tmp/e6/<lang>-<corpus>-<run>.json
  ```

  `env -u NODE_OPTIONS` then a fresh `NODE_OPTIONS=` in the SAME command is
  deliberate and not redundant: the `-u` drops fish's universal
  `--max_old_space_size=8192` and the assignment sets the one ceiling all three
  languages then share. Setting it without unsetting first leaves fish's value
  in some shells and yours in others.

- [ ] **Step 3 — the six rows.** Python twice (the two large corpora), Ruby
      once, TypeScript twice (checker off = the verdict row, checker on = the
      production row), plus the Python `--no-dispatch` attribution row.

  | #   | lang       | corpus          | extra flags / env            |
  | --- | ---------- | --------------- | ---------------------------- |
  | 1   | python     | polar           | —                            |
  | 2   | python     | netbox          | —                            |
  | 3   | python     | netbox          | `--no-dispatch`              |
  | 4   | ruby       | mastodon        | —                            |
  | 5   | typescript | tea-rags `src/` | `CODEGRAPH_TS_TYPECHECKER=0` |
  | 6   | typescript | tea-rags `src/` | `CODEGRAPH_TS_TYPECHECKER=1` |

  Run them SEQUENTIALLY. Two corpora in parallel invalidate both.

  **Budget check before starting row 1.** polar's E0 baseline is 14.5 s / 959 MB
  and netbox's 16.2 s / 1,293 MB, so rows 1–3 are minutes. Row 4 (mastodon,
  3,197 Ruby files) and rows 5–6 are unmeasured; cap each with `--limit` only if
  a run exceeds 10 minutes, and if you do, the cap goes in the table and that
  row is compared per-site against a same-capped run of the others, never
  against an uncapped one.

- [ ] **Step 4 — fill the raw table.** Every cell from the `--timing` block:

  | #   | lang | corpus | pass1 s | pass2 s | total s | peak MB | files | sites | LOC |
  | --- | ---- | ------ | ------- | ------- | ------- | ------- | ----- | ----- | --- |
  |     |      |        |         |         |         |         |       |       |     |

- [ ] **Step 5 — fill the normalized table and take the verdict.**

  | #   | lang | corpus | s/1k sites | sites/s | s/10k LOC | MB/1k files |
  | --- | ---- | ------ | ---------- | ------- | --------- | ----------- |
  |     |      |        |            |         |           |             |

  Then, per metric, Python's figure against the Ruby and the TypeScript one.
  Python's row is the MEAN of rows 1 and 2 (polar and netbox), because a
  single-corpus Python figure would be compared against a single-corpus Ruby
  figure and neither would carry its own spread:

  | metric      | python | ruby | ts (checker off) | vs ruby | vs ts | verdict       |
  | ----------- | ------ | ---- | ---------------- | ------- | ----- | ------------- |
  | s/1k sites  |        |      |                  | ±x %    | ±x %  | PASS / BREACH |
  | s/10k LOC   |        |      |                  |         |       |               |
  | MB/1k files |        |      |                  |         |       |               |
  | peak MB abs |        |      |                  |         |       |               |

  A metric is a **PASS** at |Python − other| / other ≤ 0.25 against BOTH. A
  per-site PASS with a per-LOC BREACH is recorded as a **WALKER finding** and
  attributed via `pass1Ms`; the reverse is a **RESOLVER finding** via `pass2Ms`.
  Row 3 minus row 2 attributes any Python-only regression to the E4.0.3 dispatch
  layer. Rows 5 vs 6 quantify what the `ts.Program` costs, which is context for
  the memory verdict, not part of it.

- [ ] **Step 6 — freeze the Python numbers.** Add an `e6` block beside each
      Python corpus's existing `baseline` in
      `scripts/lib/codegraph-corpora.json` —
      `{ "wallSeconds": …, "peakRssMb": …, "sites": …, "loc": …, "files": … }` —
      and extend the existing baseline test (the one at
      `2026-09-08-python-codegraph-e0-measurement.md:357`) with the new fields
      so a later change that moves them fails a test rather than going
      unnoticed. Do NOT overwrite `baseline`: E0's figures are the historical
      anchor, and flask's 275 MB → 320 MB drift between E0 and today is exactly
      the kind of movement a second block preserves and an overwrite erases.

- [ ] **Step 7 — commit.**

  ```text
  docs(plans): record the E6 offline performance matrix (e6)

  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  ```

**Task E6.0b is done when** all six rows carry min-of-3 numbers, both tables are
filled with no placeholder, and the verdict table names PASS or BREACH per
metric with the percentage that decided it.

---

## Task E6.0c — the live matrix (USER-GATED)

**Files:** this plan (tables filled in place). No source change.

**Interfaces:** none.

**This task runs a reindex-class command and therefore cannot start without an
explicit "запускай" / "reindex" from the user.** One authorization covers ONE
run (`memory/feedback_reindex_authorization_single_use.md`); a failed run needs
a new one. Steps 1–2 are read-only and may run first — they are what the
authorization request is built from.

**Steps:**

- [ ] **Step 0 — worktree**, ff-merging the branch carrying E6.0a and E6.0b.
      Then `npm run build`. Do NOT `npm link` — this task drives the CLI from
      `build/cli/index.js` in THIS worktree, which needs no global pointer, and
      relinking would yank the link out from under a parallel session.

- [ ] **Step 1 — read-only preconditions.** Three questions, three answers
      recorded in the plan before anything is proposed to the user:

  ```bash
  node build/cli/index.js projects list
  ```

  1. **Is codegraph enabled on `ugnest`?**
     `scripts/lib/codegraph-corpora.json:17` records `codegraphEnabled false` on
     registry entry `code_035da920`. If it is still false, the Python live leg
     measures nothing. Check via
     `mcp__tea-rags__get_index_status project=ugnest` and, if disabled, STOP and
     report — enabling it is a registry change the user decides, not a step
     here.
  2. **Is `bench-mastodon` at 1.38.1 recomputable?** `get_index_status` on it,
     and read whether the schema-drift guard reports drift against 1.40.0. Drift
     means `--force-enrichments` alone will not produce a coherent index, and
     the Ruby live leg needs a `--force` — which is hours and a separate
     authorization. Report the answer; do not pick for the user.
  3. **Does `tea-rags` (self-index, 21.7k chunks, 12h old) still match this
     worktree's payload schema?** It was indexed from the main checkout; the E4
     branch has walker deltas, so expect a drift warning and record what it
     names.

- [ ] **Step 2 — write the authorization request.** One message, naming exactly
      the commands, the corpora, and the expected wall from the closest anchor:
      tea-rags TS codegraph-only recompute finished 906 files in **53 s**
      (`.claude/rules/epic-completion-gate.md`, 2026-08-11), and taxdome's TS
      leg is **164.7 s** for ~10,580 files
      (`memory/project_6aytq_ts_codegraph_5min_delivered.md`) — quoted as scale,
      not as a matrix row. ONE question, per
      `memory/feedback_interview_style.md`.

- [ ] **Step 3 — the three live runs**, after authorization, sequentially, each
      wrapped in the sampler:

  ```bash
  # Python
  env -u NODE_OPTIONS NODE_OPTIONS=--max-old-space-size=8192 \
    INGEST_TUNE_ENRICHMENT_POOL_SIZE=4 DEBUG=1 \
    scripts/spikes/rss-tree-sampler.sh py-live \
      node build/cli/index.js index-codebase --project ugnest \
        --force-enrichments codegraph --languages python --json

  # Ruby — only if Step 1 question 2 said the recompute is coherent
  env -u NODE_OPTIONS NODE_OPTIONS=--max-old-space-size=8192 \
    INGEST_TUNE_ENRICHMENT_POOL_SIZE=4 DEBUG=1 \
    scripts/spikes/rss-tree-sampler.sh rb-live \
      node build/cli/index.js index-codebase --project bench-mastodon \
        --force-enrichments codegraph --languages ruby --json

  # TypeScript — the self-index
  env -u NODE_OPTIONS NODE_OPTIONS=--max-old-space-size=8192 \
    INGEST_TUNE_ENRICHMENT_POOL_SIZE=4 DEBUG=1 \
    scripts/spikes/rss-tree-sampler.sh ts-live \
      node build/cli/index.js index-codebase --project tea-rags \
        --force-enrichments codegraph --languages typescript --json
  ```

  `--languages <lang>` is mandatory, not a convenience: `cg_run_stats` is
  replaced PER LANGUAGE, so an unrestricted run destroys the other two
  languages' persisted rates and with them any later `prime` reading
  (`.claude/rules/epic-completion-gate.md`).

  **Do not pipe a `--json` run through `head`/`tail`.** stdout and the DEBUG
  diagnostics share the stream and truncation silently drops half of what this
  task is for.

- [ ] **Step 4 — min of 3 is NOT required here, and say so.** A live recompute
      rewrites shared index state; running each three times is three times the
      risk on the user's real indices for a second decimal place. Each live row
      is a SINGLE run, explicitly labelled `n=1`, and the live matrix is
      therefore corroborating evidence for the offline verdict rather than an
      independent verdict of its own. If a live row contradicts its offline
      counterpart by more than 2×, that contradiction is itself the finding and
      gets its own investigation — it means the pipeline, not the resolver, owns
      the cost.

- [ ] **Step 5 — fill the live table.** Per-phase durations from the DEBUG log
      (`phaseTimings`, `codegraph/symbols/provider.ts:1695`), peak from the
      sampler's stderr line, DuckDB delta from `du -m` on the collection's
      `.duckdb` file before and after — and resolve the PHYSICAL file name, not
      the alias, or you will measure the wrong file
      (`memory/project_codegraph_collection_name_split.md`).

  | lang | project | files | pass1 s | pass2 s | wall s | peak tree MB | DuckDB Δ MB |
  | ---- | ------- | ----- | ------- | ------- | ------ | ------------ | ----------- |
  |      |         |       |         |         |        |              |             |

  | lang | s/1k files | peak MB/1k files | vs python |
  | ---- | ---------- | ---------------- | --------- |
  |      |            |                  |           |

  Normalized per FILE here, not per site: the live pipeline reports files, and
  call sites are not in its `--json`.

- [ ] **Step 6 — record the resolve rates alongside**, so a performance number
      is never read without the correctness number it was bought at:
      `DEBUG=1 node build/cli/index.js prime <path>` → the
      `## Codegraph resolve` block. It is the ONLY supported read path for the
      persisted per-receiverKind rates; `--json` does not carry them and neither
      does the MCP status formatter.

- [ ] **Step 7 — commit.**

  ```text
  docs(plans): record the E6 live performance matrix (e6)

  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  ```

**Task E6.0c is done when** the live table is filled for every leg that was
authorized and runnable, every leg that was NOT runnable carries the reason
(codegraph disabled, schema drift, authorization withheld) instead of a blank,
and Step 6's resolve rates sit next to the timings.

---

## Task E6.1 — profile and fix one confirmed outlier

**One task per BREACH E6.0b recorded.** If E6.0b's verdict table is all PASS,
this task does not run and E6-close says so. Each instance names its metric in
the title: `E6.1-<metric>`, e.g. `E6.1-mb-per-1k-files`.

**Files:** determined by the profile. Whatever they are, the A/B gate below is
not negotiable.

**Interfaces:** none new. A performance fix that changes a public signature is
not a performance fix.

**Steps:**

- [ ] **Step 0 — worktree**, ff-merging the branch carrying E6.0b.

- [ ] **Step 1 — profile the breaching leg, offline, single process.**

  ```bash
  # CPU: which frames own the wall
  env -u NODE_OPTIONS node --cpu-prof --cpu-prof-dir ~/.claude/jobs/<job>/tmp/e6-prof \
    ./node_modules/.bin/tsx scripts/codegraph-chain-tally.ts \
      --corpus <breaching corpus> --lang <lang> --quiet --time-only

  # Heap: which allocation sites own the peak
  env -u NODE_OPTIONS node --heap-prof --heap-prof-dir ~/.claude/jobs/<job>/tmp/e6-prof \
    ./node_modules/.bin/tsx scripts/codegraph-chain-tally.ts \
      --corpus <breaching corpus> --lang <lang> --quiet --time-only
  ```

  Report the **top 10 self-time frames** with their percentage, and the top 10
  allocation sites by retained size. A profile without a ranked list is a file,
  not a finding.

  For a TypeScript breach, ALSO run `scripts/spikes/ts-live-resolve-harness.ts`
  with `TAXDOME_ROOT=<the corpus>` — it is the only instrument that reproduces
  production's `resourceLimits` (16 MB stack, 2 GB old-gen) inside a worker, and
  a TS memory verdict taken outside those limits answers a different question.

- [ ] **Step 2 — check the named suspects before hunting.** For a PYTHON breach
      these are the candidates, in the order the measurement should test them:

  | suspect                                                                                   | where                                  | why it is a candidate                                                                                                                                                 |
  | ----------------------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `lookupPythonSymbolsByShortName`                                                          | `python/resolver/strategies/shared.ts` | filters the WHOLE namesake list to `.py` on EVERY call — a per-call-site linear scan the other two languages do not pay (`python/CLAUDE.md:19-25`)                    |
  | run-global folds: `classFieldTypesByClassKey`, `moduleReexports`, `classFieldCallResults` | `codegraph/symbols/run-state.ts`       | run-global maps that grow with declarations, held for the whole run — the first place a MB/1k-files breach would live                                                 |
  | `PythonAncestorLinearizerCache` memo hit rate                                             | `python/resolver/`                     | a C3 linearization recomputed per query instead of memoized is quadratic in inheritance depth; its `linearizationFallbacks` counter is already printed                |
  | `PythonImportFileMapper` memo                                                             | `python/resolver/`                     | one instance is shared per chain by design; a second instance anywhere silently doubles the work                                                                      |
  | the E4.1.3 chain probe memo                                                               | flag-off today                         | confirm it is actually off in the measured run before blaming anything else                                                                                           |
  | `splitReceiverHops` / `splitAtBracketDepthZero`                                           | `python/resolver/`                     | Python is the ONLY language supplying the bracket-aware scan (`language/CLAUDE.md`); a depth-and-quote scanner per receiver is a per-site cost Ruby and TS do not pay |

  Each suspect is CONFIRMED or ELIMINATED by the profile, with its percentage. A
  suspect the profile does not implicate does not get "fixed for safety".

- [ ] **Step 3 — fix, with the A/B as the gate.** Before and after, on the SAME
      checkout, byte-identical output required:

  ```bash
  # Python — all five corpora, edges/fileOnly/unresolved must match exactly
  for c in ugnest flask httpx netbox polar; do … --lang python --json before-$c.json; done
  # Ruby — mismatches must stay 0
  npx tsx scripts/spikes/ruby-resolver-parity.ts \
    --corpus ~/Dev/Tools/tea-rags-bench/corpora/mastodon --json rb.json
  # TypeScript — the oracle's verdict table unchanged
  npx tsx scripts/ts-codegraph-typechecker-oracle.ts …
  ```

  **Parity 0 on all three, or the fix is reverted.** A speedup that moves one
  edge is a behaviour change wearing a performance costume, and this program's
  whole value is the recall figures E1–E5 bought.

- [ ] **Step 4 — re-measure the breaching metric** with E6.0b Step 2's exact
      command, min of 3, and put the new number in the verdict table next to the
      old one. If it is still outside ±25 %, say so and file the remainder
      rather than declaring victory on a direction of travel.

- [ ] **Step 5 — full gate + commit.** `npx tsc --noEmit`,
      `npm run test:coverage`. Commit `perf(<scope>): … (e6)`.

**Task E6.1 is done when** the named suspect is confirmed with a percentage, the
fix holds parity 0 on all three languages, and the metric is re-measured — not
when the profile looks better.

---

## Task E6-close

**Files:**

- `docs/superpowers/specs/2026-09-03-python-codegraph-unification-program-design.md`

**Steps:**

- [ ] **Step 0 — worktree**, ff-merging everything E6 produced.

- [ ] **Step 1 — write the E6 section into the program spec**: the verdict table
      from E6.0b Step 5, the live corroboration from E6.0c, and the fixes E6.1
      landed. State the ±25 % criterion and whether Python met it per metric.

- [ ] **Step 2 — decide the capability text.**
      `src/core/domains/language/     capability/` describes what each
      language's codegraph can do, not how fast it does it. **If E6 changed no
      capability — which is the expected outcome, since E6.0 adds tooling and
      E6.1's gate is byte-identical output — say exactly that in the spec and
      change no capability file.** A performance epic that edits capability text
      is a smell: it means something moved that the parity gate should have
      caught.

- [ ] **Step 3 — settle the beads** per
      `.claude/rules/worktree-beads-lifecycle.md`: recover the set from
      `git log main..worktree-…`, close each with evidence (the measured number,
      not "done"), and reset to `open` anything E6.0c could not run because
      authorization or a stale index blocked it.

- [ ] **Step 4 — commit.**
      `docs(specs): record the E6 performance verdict (e6)`.

---

## Self-review

- Every metric in decision 3 has a producer command (E6.0b Step 2 offline, E6.0c
  Step 3 live) and a normalization formula. No metric is asserted without one.
- Every table in this plan names its columns. Six are empty by design — they are
  what E6.0b and E6.0c fill; each says which step fills it.
- **The TypeScript harness gap is stated as found, not assumed away:** there is
  no `--lang typescript` today and no TS equivalent of the tally, and E6.0a's
  answer is `--time-only` over the production resolver rather than a rebuilt TS
  ChainSpec, for the drift reason in decision 1.
- **What is NOT concrete and must be established by the run, not by this plan:**
  mastodon's call-site count (42,057 is the brief's figure, unverified here);
  tea-rags `src/`'s scored-file and call-site counts; every wall and RSS figure
  for Ruby and TypeScript, offline and live; whether ugnest still has codegraph
  disabled; whether `bench-mastodon` at index 1.38.1 can take a
  `--force-enrichments` without a full rebuild.
