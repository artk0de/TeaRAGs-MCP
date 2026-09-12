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

### E6.0a as built — 2026-09-11, `922138c05` + `6809e044c`

Three deviations from the steps above, each because the step as written would
have produced a wrong number.

1. **The `--ts-checker=off` switch is an env write, not a parameter.** The kill
   switch `TSCallResolver` exposes is `CODEGRAPH_TS_TYPECHECKER`, read once at
   resolver construction (`ts-resolver.ts:284`), so `main()` sets
   `process.env.CODEGRAPH_TS_TYPECHECKER = "0"` before the first resolve. The
   flip is worth a row of its own on this repo's 181 files: pass 2 goes 0.23 s →
   9.57 s, peak RSS 658 → 1,111 MB, edges 3,076 → 4,723.
2. **The C3-fallback line is suppressed under `--time-only`.** That counter
   lives on the cache the REBUILT chain feeds, and `--time-only` builds no
   chain; printing `0` would report a fallback count for a chain that did not
   run. So the byte-identity gate holds on every line except that one, which is
   structurally absent rather than changed.
3. **The sampler self-check needed a different fixture.** A
   `Buffer.alloc(600MB, 1)` written once peaks for well under one 250 ms tick
   and macOS reclaims the untouched pages within a second — the process reads
   ~40 MB three seconds later while `/usr/bin/time -l` still reports 643 MB. A
   correctly-wired sampler reports 254 MB against that target and looks broken.
   `scripts/spikes/rss-tree-sampler-selfcheck.js` re-touches every page every
   100 ms instead, holding a plateau; sampler 646 MB vs `time -l` 650 MB, 0.6 %
   apart. `RSS_SELFCHECK_CHILD=1` adds the tree half — 1,294 MB across parent
   and child, where `time -l` on the parent still says ~650 MB.

Also worth carrying into E6.0b: **the tally never calls `prepareResolvePass`**,
so the TypeScript leg's Program cache fills lazily per file rather than from the
whole-project prime production does (`typescript/index.ts:156`). Read the
`checker=1` row as a lower bound on TypeScript's Program cost, and take the
verdict on the `--ts-checker=off` row, which is the structural-parity
configuration Python and Ruby actually are.

**The exact command lines E6.0b runs.** `env -u NODE_OPTIONS` on every one, per
the Global Constraints, then the explicit ceiling. Discard the first run, report
the min of the next three.

```bash
# Python — the two matrix corpora, plus the --no-dispatch attribution row.
env -u NODE_OPTIONS NODE_OPTIONS=--max-old-space-size=8192 npx tsx \
  scripts/codegraph-chain-tally.ts --corpus ~/Dev/Tools/tea-rags-bench/corpora/polar \
  --lang python --quiet --time-only
env -u NODE_OPTIONS NODE_OPTIONS=--max-old-space-size=8192 npx tsx \
  scripts/codegraph-chain-tally.ts --corpus ~/Dev/Tools/tea-rags-bench/corpora/netbox \
  --lang python --quiet --time-only
env -u NODE_OPTIONS NODE_OPTIONS=--max-old-space-size=8192 npx tsx \
  scripts/codegraph-chain-tally.ts --corpus ~/Dev/Tools/tea-rags-bench/corpora/polar \
  --lang python --quiet --time-only --no-dispatch

# Ruby — mastodon whole, no --limit.
env -u NODE_OPTIONS NODE_OPTIONS=--max-old-space-size=8192 npx tsx \
  scripts/codegraph-chain-tally.ts --corpus ~/Dev/Tools/tea-rags-bench/corpora/mastodon \
  --lang ruby --quiet --time-only

# TypeScript — this repo. The VERDICT row is checker off; checker on is the
# second row, labelled, never averaged with it.
env -u NODE_OPTIONS NODE_OPTIONS=--max-old-space-size=8192 npx tsx \
  scripts/codegraph-chain-tally.ts --corpus "$PWD" --lang typescript --quiet \
  --time-only --ts-checker=off
env -u NODE_OPTIONS NODE_OPTIONS=--max-old-space-size=8192 npx tsx \
  scripts/codegraph-chain-tally.ts --corpus "$PWD" --lang typescript --quiet --time-only

# Machine-readable, when a run's numbers go into codegraph-corpora.json:
#   add `--json /tmp/e6-<corpus>-<lang>.json` — `timing` and `timeOnly` ride
#   along in the payload already.
```

---

### E6.0b measured — 2026-09-11, `809c50314`

Six rows, each four runs of `--time-only` — one warm-up discarded, three kept —
taken sequentially on an otherwise idle 12-core Apple Silicon host with 18 GB.
Every command carried
`env -u NODE_OPTIONS NODE_OPTIONS=--max-old-space-size=8192`.

**Quiet-machine readings.** Before row 1, 23:46:28: load averages 3.66 / 5.59 /
23.34, top process `spotlightknowledged` 97.9 % CPU. After row 6, 23:54:38: load
averages 3.49 / 3.54 / 14.47, top process `spotlightknowledged` 98.1 % CPU. The
1-minute load never went above 3.7 against a stop-gate of 12, and the 15-minute
figure is the decaying tail of the pre-dispatch storm, not live work. Spotlight
held one core of twelve for the whole window at a level that did not move
between the first reading and the last, so it is a constant applied equally to
all six rows rather than a per-row perturbation.

**Deviations from the steps as written.**

1. **The `--no-dispatch` row ran on netbox, not polar.** Step 3's table says
   netbox and the E6.0a command block says polar; the table won. This matters
   more than it looks: netbox fires the dispatch layer zero times (single 0, fan
   0), where polar fires it 22 (single 9, fan 13). Row 3 therefore bounds what
   it costs to CONSULT an empty dispatch layer, and says nothing about what a
   populated one costs.
2. **The TypeScript corpus is the whole worktree root, 1,017 scored files.**
   Step 3's table labels it "tea-rags `src/`"; the E6.0a command block passes
   `$PWD`, and `$PWD` is what ran.
3. **The checker A/B does not reproduce E6.0a's numbers.** E6.0a records pass 2
   going 0.23 s → 9.57 s and peak RSS 658 → 1,111 MB "on this repo's 181 files".
   On the full root it goes 0.25 s → 6.38 s and 947 → 1,558 MB. Different file
   set, so the two are not comparable; the rows below are the full-root ones.
4. **Min and median peak RSS agree.** The widest gap on any row is 6.6 %
   (netbox, 2,208 min vs 2,365 median), under the 15 % threshold that would have
   forced the memory verdict onto the median. The verdict is taken on the min
   per the plan, and the median cross-check below returns the same verdict.

**Step 4 — the raw table.** Min of the three kept runs, with the median of the
same three beside it for total wall and peak RSS.

| #   | lang       | corpus                    | pass1 s | pass2 s | total s | peak MB | total s (med) | peak MB (med) | files | sites  | LOC     |
| --- | ---------- | ------------------------- | ------- | ------- | ------- | ------- | ------------- | ------------- | ----- | ------ | ------- |
| 1   | python     | polar                     | 14.24   | 0.65    | 14.89   | 2247    | 14.90         | 2376          | 1339  | 56,710 | 306,460 |
| 2   | python     | netbox                    | 10.62   | 0.30    | 10.93   | 2208    | 11.46         | 2365          | 1038  | 44,126 | 278,182 |
| 3   | python     | netbox `--no-dispatch`    | 10.55   | 0.30    | 10.84   | 2365    | 11.26         | 2367          | 1038  | 44,126 | 278,182 |
| 4   | ruby       | mastodon                  | 2.09    | 0.64    | 2.74    | 791     | 2.78          | 791           | 1383  | 42,057 | 76,319  |
| 5   | typescript | tea-rags, checker **off** | 3.63    | 0.25    | 3.88    | 947     | 3.97          | 949           | 1017  | 26,643 | 161,045 |
| 6   | typescript | tea-rags, checker on      | 3.64    | 6.38    | 10.08   | 1558    | 10.22         | 1632          | 1017  | 26,643 | 161,045 |

No row was capped: the longest single run was polar at 14.9 s, three orders
below the `--limit` rule's 10-minute trigger. `chain drift 0` on every row, and
mastodon walked whole (2,669 of its files are excluded by `.gitignore` and
friends before scoring, leaving 1,383).

**Step 5 — the normalized table.** Computed from the min column.

| #   | lang       | corpus                    | s/1k sites | sites/s | s/10k LOC | MB/1k files |
| --- | ---------- | ------------------------- | ---------- | ------- | --------- | ----------- |
| 1   | python     | polar                     | 0.263      | 3,809   | 0.486     | 1,678       |
| 2   | python     | netbox                    | 0.248      | 4,037   | 0.393     | 2,127       |
| 3   | python     | netbox `--no-dispatch`    | 0.246      | 4,071   | 0.390     | 2,278       |
| 4   | ruby       | mastodon                  | 0.065      | 15,349  | 0.359     | 572         |
| 5   | typescript | tea-rags, checker **off** | 0.146      | 6,867   | 0.241     | 931         |
| 6   | typescript | tea-rags, checker on      | 0.378      | 2,643   | 0.626     | 1,532       |

**The verdict.** Python is the mean of rows 1 and 2; the comparators are row 4
and row 5. The band is |Python − other| / other ≤ 0.25 against BOTH.

| metric      | python | ruby  | ts (checker off) | vs ruby  | vs ts    | verdict |
| ----------- | ------ | ----- | ---------------- | -------- | -------- | ------- |
| s/1k sites  | 0.255  | 0.065 | 0.146            | +291.6 % | +75.2 %  | BREACH  |
| s/10k LOC   | 0.439  | 0.359 | 0.241            | +22.4 %  | +82.4 %  | BREACH  |
| MB/1k files | 1,903  | 572   | 931              | +232.7 % | +104.3 % | BREACH  |
| peak MB abs | 2,228  | 791   | 947              | +181.6 % | +135.2 % | BREACH  |

All four breach. `s/10k LOC` is the only metric that clears one comparator —
+22.4 % against Ruby, inside the band — and it fails on TypeScript at +82.4 %.

**Median cross-check on memory**, since the min is a known GC-thrash risk: MB/1k
files becomes python 2,026 vs ruby 572 (+254 %) and ts 933 (+117 %); peak MB abs
becomes python 2,370 vs ruby 791 (+200 %) and ts 949 (+150 %). Same verdict,
slightly worse, so the choice of estimator does not decide this cell.

**Attribution: this is a WALKER finding, on both time axes.** Pass 1 is 12.43 s
of Python's 12.91 s mean — **96.3 %** of the wall — and the split settles what
the two-axis rule cannot when both axes breach:

| per-pass figure  | python | ruby   | ts (off) | python vs ruby | python vs ts |
| ---------------- | ------ | ------ | -------- | -------------- | ------------ |
| pass1 s/1k sites | 0.2459 | 0.0497 | 0.1362   | 4.9×           | 1.8×         |
| pass1 s/10k LOC  | 0.423  | 0.274  | 0.225    | +54 %          | +88 %        |
| pass2 s/1k sites | 0.0091 | 0.0152 | 0.0094   | **−40 %**      | **−3 %**     |

Python's RESOLVER is the fastest of the three per call site — 40 % below Ruby's
and level with TypeScript's. There is no resolver finding here to chase. The
entire breach lives in pass 1: walk, extract, symbol-table upsert, type-channel
absorption.

**Corpus shape is part of the per-site gap and none of the per-LOC one.** Sites
per 1k LOC: python 172, ruby 551, ts 165. LOC per file: python 248, ruby 55,
ts 158. Ruby's call-site density is 3.2× Python's, which is exactly why the
per-site gap against Ruby (4.9×) is so much wider than the per-LOC one (+54 %) —
Ruby amortizes the same walk over three times the sites. Against TypeScript,
whose site density is within 4 % of Python's, both axes agree and neither is a
shape artefact: 1.8× per site, +88 % per 10k LOC. **TypeScript is the comparator
that carries the finding**, and it is the one E6.1 should profile against.

**Row 3 − row 2 — the E4.0.3 dispatch layer costs nothing measurable.** Total
−0.09 s on the min and −0.20 s on the median (turning it off is nominally
_slower_ on the median), against a row-2 spread of 10.93–11.70 s. Peak RSS +157
MB on the min and +2 MB on the median — noise, and the median is the honest read
here. But see deviation 1: netbox hit the dispatch layer zero times, so this row
prices consulting an empty layer. Pricing a populated one needs polar.

**Rows 6 vs 5 — what `ts.Program` costs.** Total 3.88 → 10.08 s, of which pass 2
alone goes 0.25 → 6.38 s (**25.5×**), and peak RSS 947 → 1,558 MB (+611 MB).
Context for the memory verdict, not part of it: the verdict row is checker-off,
where all three languages are tree-sitter-only. Even against the checker-ON row,
Python's 2,228 MB is +43 % on memory and +23 % on wall over 1.7× the LOC — the
`ts.Program` build is the single most expensive thing TypeScript does and Python
still costs more without an equivalent.

**Drift against E0's frozen figures.** polar 14.5 s / 959 MB → 14.89 s / 2,247
MB: wall flat, RSS 2.3×. netbox 16.2 s / 1,293 MB → 10.93 s / 2,208 MB: wall
down a third, RSS 1.7×. The walls are not the same quantity — E0's is a
`/usr/bin/time -l` process wall including `tsx` startup, E6's is the
harness-internal `pass1Ms + pass2Ms` — which is the second reason the `e6` block
sits beside `baseline` rather than replacing it. The RSS figures ARE the same
quantity, and they say five epics of new passes have cost Python roughly a
doubling of heap.

---

### E6.1 measured — 2026-09-12, `7c317d00f`

Three fixes, each its own TDD cycle, commit and A/B: `5a50f52f5` (local bindings
once per file), `13dd6dd74` (skip materializing an inert file), `7c317d00f`
(lazy field map). All four E6.0b metrics moved, none crossed the ±25 % band
against BOTH comparators, so the verdict stays **BREACH on all four** — with
`s/1k sites` now clearing TypeScript and `s/10k LOC` now clearing Ruby.

**Quiet-machine readings.** Before the BEFORE arm, 00:35: load averages 2.13 /
8.23 / 12.07, no process above 18 % CPU. Before the final four-row arm, 01:03:
7.60 / 7.19 / 8.37, top process 14.9 % (`claude` itself). The 1-minute figure
never exceeded 9.1 at the start of any timed arm, against a stop-gate of 12; the
five- and fifteen-minute figures are the decaying tail of the pre-commit vitest
fork storms between arms, not live work. Every arm waited for the 1-minute load
to fall under 8 before its warm-up run. Spotlight (`mds`) indexed the freshly
installed `node_modules` for roughly two minutes between the FIX A dumps and the
FIX A timing arm; that window was waited out rather than measured through.

#### The diagnosis — where Python's pass 1 actually goes

The parent session profiled the Python leg on `0e5ccd005` over netbox and polar
and handed down a finding this task recorded rather than re-derived. Three
things own the wall and the heap, and the resolver owns none of it:

1. **`materializeTree` is 33 % of pass 1** and the Python walker 44 %, of which
   `collectLocalBindingsForChunk` alone is 13 %. Kernel extraction passes are 11
   %, `Parser.parse` 2.4 %. Pass 2 per call site is the fastest of the three
   languages — E6.0b already said so and the profile agrees, so nothing in this
   task touches a resolver.
2. **The heap is ONE file.** Live heap after Mark-Compact (`--trace-gc`, 1024 MB
   ceiling) reaches 785–895 MB on netbox against 64 MB for Ruby's mastodon and
   113 MB for TypeScript. Extractions retain nothing — a probe found 43 KB kept
   per file and zero `AstNode` reachable from any `FileExtraction` — because the
   live set is the materialized tree of `netbox/extras/data/un_locode.py`:
   111,557 lines, 6.2 MB of a data table, 0 chunks, 0 calls, **5.33 s of
   netbox's 11.6 s pass 1 and ~800 MB of heap** for an empty answer.
   `extras/data/iata.py` (9.8k lines, 0 chunks) is another 0.41 s.
3. **`collectLocalBindingsForChunk` was O(chunks × nodes)** — a full-tree walk
   per chunk. Measured in isolation: `netbox/dcim/views.py` 5,045 lines / 475
   chunks = 0.87 s, `netbox/dcim/tests/test_filtersets.py` 7.7k lines / 620
   chunks = **14.1 s**, `polar sdk/python/polar/v2026_10/outputs.py` 11k lines /
   399 chunks = 1.0 s. The TypeScript walker does a comparable 15.9k-line /
   410-chunk file in 2.3 s total.

A fourth, smaller item: `MaterializedNode` allocated the node, a `children`
array, a `namedChildren` array, two position objects and an EAGER
`fields = new Map()` — roughly 350 B a node, of which the empty map is the
largest avoidable share. On this section's Python fixture 125 of 149 nodes
carried no field child at all.

Not fixed, noted: the polar row charges Python roughly 1.5 s of TypeScript
client files (`clients/packages/client/src/v1.ts`, 71k lines, and friends),
because the tally's symbol-table pass walks every language in the corpus while
only `.py` call sites are scored. That is harness normalization noise and it
sits in both arms equally.

#### The A/B protocol

Every timed row is E6.0b Step 2's command line:

```bash
env -u NODE_OPTIONS NODE_OPTIONS=--max-old-space-size=8192 \
  npx tsx scripts/codegraph-chain-tally.ts \
    --corpus <ABS> --lang <lang> --quiet --time-only [--ts-checker=off]
```

run four times, first discarded, min and median of the remaining three. The
BEFORE arm is the same harness with `src/` and
`scripts/ts-codegraph-typechecker-oracle.ts` checked out at `0e5ccd005`; the
tree was never left flipped across a commit.

Byte-identity of EXTRACTIONS is the primary gate, stronger than the tally's
counts: `scripts/spikes/py-extraction-dump.ts` (new) walks the tally's own kept
set and writes one canonical sorted-key JSON line per file, and the two arms'
files are compared with `cmp`. The tally's `edges` / `fileOnly` / `unresolved`
and `chain drift 0` are reported beside it on every row.

#### FIX A — `collectLocalBindingsForChunk` once per file (`5a50f52f5`)

`collectPythonLocalBindingSites` records every binding site once in document
order; `pythonLocalBindingsInRange` slices a chunk's share out of it. Exactly
the shape `collectPythonCallResultBindings` + `pythonCallResultBindingsInRange`
already had two lines above, and identical by construction: the old walk visited
nodes in document order and kept those inside `[startLine, endLine]`, so
filtering a document-order site list by the same test yields the same keys in
the same insertion order carrying the same arrays. Every rule inside the
collector is byte-for-byte what it was — the annotation-wins early return, the
CapWords constructor gate, the `endLine` span.

The complexity claim is pinned, not asserted: the new test instruments every
node's `startPosition` with a counting getter and requires that adding eight
method chunks to a file cost less than one extra traversal. Before the fix that
delta was 3,056 reads on a 382-node tree — exactly 8 × 382.

| corpus        | wall min s | wall med s | peak MB min | peak MB med |
| ------------- | ---------- | ---------- | ----------- | ----------- |
| polar before  | 14.52      | 14.78      | 2,328       | 2,347       |
| polar after   | **13.25**  | **13.26**  | 2,288       | 2,291       |
| netbox before | 10.97      | 11.25      | 2,382       | 2,384       |
| netbox after  | **10.13**  | **10.24**  | 2,352       | 2,370       |

−8.7 % / −7.7 % on the min wall, −10.3 % / −9.0 % on the median. Extraction
dumps byte-identical on ugnest, flask, httpx, netbox and polar. Tally counts
unmoved: polar 17,774 edges / 0 file-only / 38,936 unresolved, netbox 8,711 / 0
/ 35,415, `chain drift 0` on every run.

#### FIX B — never materialize an inert file (`13dd6dd74`)

`LanguageWalker.extractionBearingNodeTypes` (optional; absent means walk
everything) lets a language name the native node types its extraction is rooted
in. Python names six: `function_definition`, `class_definition`, `call`,
`import_statement`, `import_from_statement`, `future_import_statement` — the
last because tree-sitter-python gives `from __future__ import …` its own node.
`fileIsInertForExtraction` asks the NATIVE tree via `descendantsOfType`, before
the materializer allocates a JS node per syntax node. Both consumers take the
path: the provider's `parseFileExtraction` and the oracle's `extractFile`, which
is the one the tally measures — patching only production would make the harness
report a wall production never pays. Ruby and TypeScript declare no list and
cost one `undefined` check per file.

The gate is `scripts/spikes/py-inert-file-proof.ts` (new): for every file the
predicate wants to skip, it materializes the tree anyway, runs `collectSymbols`
and the REAL walker, and requires the result to be the empty shape with no
optional channel present.

| corpus | files | inert | mismatches |
| ------ | ----- | ----- | ---------- |
| flask  | 36    | 0     | 0          |
| httpx  | 23    | 1     | 0          |
| ugnest | 262   | 27    | 0          |
| netbox | 1,094 | 96    | 0          |
| polar  | 3,095 | 126   | 0          |

| corpus                    | wall min s | wall med s | peak MB min | peak MB med |
| ------------------------- | ---------- | ---------- | ----------- | ----------- |
| polar before (= after A)  | 13.25      | 13.26      | 2,288       | 2,291       |
| polar after               | 13.31      | 13.57      | 2,313       | 2,361       |
| netbox before (= after A) | 10.13      | 10.24      | 2,352       | 2,370       |
| netbox after              | **4.98**   | **4.99**   | **1,192**   | **1,192**   |

netbox halves — −50.8 % wall, −49.3 % peak RSS — and polar does not move (+0.5 %
min, +2.3 % median, inside the run-to-run spread). That asymmetry IS the
finding: the fix is worth what the corpus's inert files weigh, and netbox's 96
include a 6.2 MB data table while polar's 126 are small. The `descendantsOfType`
probe costs a few allocations on the ~96 % of files that are NOT inert, and
polar is where that cost shows up unrecovered. Extraction dumps byte-identical
on all five, counts and drift unmoved.

#### FIX C — lazy field map (`7c317d00f`)

`MaterializedNode.fieldsMap` is now private and built on the first field child;
`childForFieldName` reads `this.fieldsMap?.get(field) ?? null` and the
first-writer-wins rule moved into `setFieldChild`. Nothing outside
`src/core/infra/materialize.ts` has ever read `.fields` — `AstNode` exposes only
`childForFieldName` — so no getter and no contract change was needed (checked
with `hybrid_search` and an exhaustive ripgrep over `src/`, `scripts/` and
`tests/`). `startPosition` / `endPosition` / `children` / `namedChildren` are
untouched.

The test pins both halves: `childForFieldName` answers exactly what the native
tree answers for every field of every node of a broad Python fixture, and a
`Map`-construction counter requires one map per node that HAS a field rather
than one per node. Pre-fix that counter read 149 (every node); post-fix 24.

| row                       | wall min s | wall med s | peak MB min | peak MB med |
| ------------------------- | ---------- | ---------- | ----------- | ----------- |
| polar before (= after B)  | 13.31      | 13.57      | 2,313       | 2,361       |
| polar after               | 13.50      | 13.51      | **2,111**   | **2,116**   |
| netbox before (= after B) | 4.98       | 4.99       | 1,192       | 1,192       |
| netbox after              | 5.01       | 5.02       | 1,188       | 1,188       |
| mastodon before           | 2.75       | 2.76       | 757         | 762         |
| mastodon after            | 2.76       | 2.78       | 759         | 777         |
| ts checker-off before     | 3.91       | 3.91       | 933         | 960         |
| ts checker-off after      | 3.88       | 3.93       | 927         | 927         |

The wall is flat everywhere — the map was never the time cost — and polar's peak
RSS drops 8.7 % on the min and 10.4 % on the median. netbox barely moves because
FIX B already removed the tree that dominated its heap. Ruby and TypeScript are
inside noise in both directions, which is the answer this shared file needed.

Parity, because `materialize.ts` is shared by the chunker and every language:
extraction dumps byte-identical on all five Python corpora AND on mastodon
(1,386 Ruby files); on this repo — which is its own corpus, so the changed
file's own extraction legitimately moves — 1,040 of 1,041 files identical and
the single difference is `src/core/infra/materialize.ts` itself.
`ruby-resolver-parity.ts --before-root /Users/artk0re/Dev/Tools/tea-rags-mcp`:
42,057 sites compared, **mismatches 0, drift 0**.
`ruby-walker-composition-parity.ts --limit 500`: **mismatches 0**.

#### The final matrix — four rows re-taken on `7c317d00f`

| #   | lang       | corpus                    | pass1 s | pass2 s | total s | peak MB | total s (med) | peak MB (med) | files | sites  | LOC     |
| --- | ---------- | ------------------------- | ------- | ------- | ------- | ------- | ------------- | ------------- | ----- | ------ | ------- |
| 1   | python     | polar                     | 12.81   | 0.68    | 13.50   | 2111    | 13.51         | 2116          | 1339  | 56,710 | 306,460 |
| 2   | python     | netbox                    | 4.70    | 0.31    | 5.01    | 1188    | 5.02          | 1188          | 1038  | 44,126 | 278,182 |
| 4   | ruby       | mastodon                  | 2.12    | 0.65    | 2.76    | 759     | 2.78          | 777           | 1383  | 42,057 | 76,319  |
| 5   | typescript | tea-rags, checker **off** | 3.63    | 0.25    | 3.88    | 927     | 3.93          | 927           | 1020  | 26,735 | 161,466 |

Rows 3 and 6 were not re-taken: row 3 priced an empty dispatch layer and E6.0b
already showed it costs nothing measurable, and row 6 prices `ts.Program`, which
none of these three fixes touches.

Normalized from the min column:

| #   | lang       | corpus      | s/1k sites | sites/s | s/10k LOC | MB/1k files |
| --- | ---------- | ----------- | ---------- | ------- | --------- | ----------- |
| 1   | python     | polar       | 0.238      | 4,201   | 0.441     | 1,577       |
| 2   | python     | netbox      | 0.114      | 8,807   | 0.180     | 1,145       |
| 4   | ruby       | mastodon    | 0.066      | 15,238  | 0.362     | 549         |
| 5   | typescript | checker off | 0.145      | 6,890   | 0.240     | 909         |

**The verdict.** Python is the mean of rows 1 and 2, band |Python − other| /
other ≤ 0.25 against BOTH comparators.

| metric      | E6.0b python | E6.1 python | ruby  | ts    | E6.0b vs ruby | E6.1 vs ruby | E6.0b vs ts | E6.1 vs ts  | verdict |
| ----------- | ------------ | ----------- | ----- | ----- | ------------- | ------------ | ----------- | ----------- | ------- |
| s/1k sites  | 0.255        | 0.176       | 0.066 | 0.145 | +291.6 %      | **+167.9 %** | +75.2 %     | **+21.1 %** | BREACH  |
| s/10k LOC   | 0.439        | 0.310       | 0.362 | 0.240 | +22.4 %       | **−14.2 %**  | +82.4 %     | **+29.1 %** | BREACH  |
| MB/1k files | 1,903        | 1,361       | 549   | 909   | +232.7 %      | **+147.9 %** | +104.3 %    | **+49.7 %** | BREACH  |
| peak MB abs | 2,228        | 1,650       | 759   | 927   | +181.6 %      | **+117.3 %** | +135.2 %    | **+77.9 %** | BREACH  |

Every cell improved and not one metric clears both comparators, so the honest
answer is that E6.1 narrowed the breach and did not close it. Two metrics now
clear ONE comparator each — `s/1k sites` is inside the band against TypeScript
at +21.1 %, `s/10k LOC` is inside it against Ruby at −14.2 % (Python is now
FASTER than Ruby per line) — and `s/10k LOC` misses TypeScript by 4.1 points.
The remaining distance is memory: +147.9 % / +49.7 % on MB per 1k files.

Median cross-check, since the min is a GC-thrash risk: s/1k sites python 0.176
vs ruby 0.066 (+166.3 %) and ts 0.147 (+19.7 %); s/10k LOC 0.311 vs 0.364 (−14.7
%) and 0.243 (+27.6 %); MB/1k files 1,362 vs 562 (+142.5 %) and 909 (+49.9 %);
peak MB abs 1,652 vs 777 (+112.6 %) and 927 (+78.2 %). Same verdict on every
cell, so the choice of estimator decides nothing here either.

**The corpus-shape caveat E6.0b recorded still applies and is now larger, not
smaller.** Ruby's 551 call sites per 1k LOC against Python's 172 is why the
per-site gap against Ruby (2.7×) stays wide while the per-LOC one has gone
NEGATIVE: Ruby amortizes its walk over three times the sites. TypeScript remains
the comparator that carries the finding — its site density is within 4 % of
Python's — and against it both axes now agree at +21 % and +29 %, which is a
different picture from E6.0b's 1.8× and +88 %. The polar row still carries ~1.5
s of TypeScript client files through the symbol-table pass, so Python's true
per-site figure is slightly better than the table says.

**What is left, for whoever picks up the remainder.** The wall is now dominated
by polar, and polar's cost is the walk itself — not one pathological file, not
the resolver. The memory breach is the materialized tree's per-node footprint:
after the empty map, what remains per node is two position objects and two child
arrays, and `namedChildren` duplicates references already in `children`. That is
the next measurable lever, and it is a bigger change than a performance epic
should make without its own A/B.

#### Deviations

1. **Step 1 was not re-run.** The parent session had already profiled and
   root-caused the breach, and its diagnosis was recorded above rather than
   re-derived. The suspects E6.1 Step 2 lists are all resolver-side and E6.0b
   had already eliminated the resolver; the profile implicated the walker and
   the materializer, which is what got fixed.
2. **`fileIsInertForExtraction` lives in `src/core/infra/`, not
   `src/core/domains/language/kernel/`.** The plan named the kernel, but
   `eslint.config.js` forbids `domains/trajectory/** -> domains/language/**` and
   `.claude/rules/domains-language.md` §2 says never to add an exemption, so the
   codegraph provider cannot import a kernel helper. The alternative was to
   inject it through `CodegraphSymbolsProviderDeps` the way `collectSymbols` is
   injected, which threads a new required field through four interfaces and the
   composition root — a wider interface change than this task's own rule allows.
   `infra/` is where `materializeTree` already sits for exactly this reason,
   stated in its own docblock, and `domains/language` may import `infra/` too.
   The DATA (`extractionBearingNodeTypes`) stays the language module's.
3. **The TypeScript corpus is this worktree, and it moved between arms.** Its
   BEFORE reading was taken before FIX C added a test file, so the AFTER row
   shows 1,020 files / 161,466 LOC / 26,735 sites against 161,453 / 26,734 — one
   file of drift, two thousandths of a percent. Same effect makes a self-repo
   extraction dump differ on exactly the files whose source text the commit
   changed.
4. **Rows 3 and 6 of E6.0b were not re-taken**, as recorded above.
5. **Python walker version NOT bumped** — outputs are byte-identical, which is
   the whole claim.

### E6.0c measured — 2026-09-12, live from the branch build @ `4e341797a`

Three
`index-codebase --project <alias> --force-enrichments codegraph --languages <lang> --json`
runs from this worktree's `build/`, sequential, each under a 250 ms per-process
sampler over the whole process tree (the CLI parent, its `--__worker` child that
runs the pipeline, the DuckDB daemon it spawns, and any pre-existing daemon).
`NODE_OPTIONS` unset. Every run ended with `outcome.failed []` and
`outcome.degraded []`.

| lang       | project        | files | codegraph enrichment | index worker peak | daemon peak | tree peak |
| ---------- | -------------- | ----- | -------------------- | ----------------- | ----------- | --------- |
| python     | ugnest         | 234   | 2.4 s                | 903 MB            | 148 MB      | 1,275 MB  |
| typescript | tea-rags       | 1,021 | 22.9 s               | 1,392 MB          | 113 MB      | 1,660 MB  |
| ruby       | bench-mastodon | 1,385 | 4.6 s                | 1,355 MB          | 474 MB      | 1,967 MB  |

Wall of the whole command is dominated by the incremental sync's embedding of
files changed since the last index (ugnest 8.9 s, tea-rags 31.4 s, mastodon 46.3
s) and is not a codegraph number; the enrichment column is
`enrichmentMetrics.totalDurationMs`.

**Live/harness parity holds.** ugnest live edges 778 = the offline chain tally's
778 = the oracle-validated chain (recall tiebroken 0.9847, phantom 0). `prime`
per receiver kind after the run: bareCall 1.00 (367/1717), constant 0.98,
selfMember 0.93, dynamic 0.32 (27/1631), chain 0.08 (7/813), localVar 0.07,
super 0/14. The headline `resolveSuccessRate 0.76` is a denominator artefact,
not a resolver gap: 57 dynamic, 79 chain, 75 localVar and 14 `super` calls have
EXTERNAL targets the oracle books as `agreeExt`, while the live classifier
leaves them in the attempted-minus-external denominator. Filed as a follow-up.

**The memory verdict moves off the walker.** The index worker's peak is 0.9–1.4
GB for all three languages and does not track project size (234 files → 903 MB,
1,385 files → 1,355 MB), while the Python walker alone on ugnest peaks at 274 MB
offline. On ugnest the worker sat at 81–109 MB after the sync and climbed 109 →
903 MB inside the 2.4 s enrichment phase. One enrichment worker thread's module
graph is 49 MB resident (measured by importing `enrichment/infra/worker.js` in a
bare process), so the climb is not module loading. What allocates it — the
enrichment thread pool (`INGEST_TUNE_ENRICHMENT_POOL_SIZE`, default 4, each
thread its own isolate), the DuckDB client side, or the payload pass — needs an
instrumented ugnest run (DEBUG phase lines aligned to the sampler, then a heap
snapshot near a worker heap limit), which the reindex permission gate blocked in
this session. That is the open E6 item; the walker-side verdict stands as E6.1
recorded it.

#### Attribution runs — 2026-09-12, instrumented ugnest, spike reverted

The permission gate was lifted for ugnest, so four more recomputes ran with
per-phase `rss / heapUsed / heapTotal / external` appended to every PHASE line
by an uncommitted spike in `debug-logger.ts`. Under `DEBUG` the worker's stderr
goes to `~/.tea-rags/logs/worker-debug-*.log`, not to the CLI's stdout — which
is where the earlier "no phase lines" came from.

| run                | pool | rss at RECOMPUTE_SCROLL | rss at ALL_COMPLETE | thread heap used / total | sampler worker peak | live pass 1 |
| ------------------ | ---- | ----------------------- | ------------------- | ------------------------ | ------------------- | ----------- |
| baseline (E6.0c)   | 4    | —                       | —                   | —                        | 903 MB              | 1.10 s      |
| instrumented       | 4    | 327 MB                  | 647 MB              | 102 → 81 / 205 MB        | 897 MB              | —           |
| single thread      | 1    | 212 MB                  | 403 MB              | 89 → 73 / 139 → 80 MB    | 672 MB              | —           |
| single thread + gc | 1    | 297 MB                  | 426 MB              | 82 → 103 / 204 MB        | 633 MB              | 2.18 s      |

Reading: the enrichment thread's OWN heap never exceeds ~100 MB used across the
codegraph phase, on any run. The process grows 190–320 MB during that phase
anyway, and three quarters of the pool-4 baseline over pool-1 (327 vs 212 MB)
plus the completion gap (647 vs 403 MB) is the other three isolates: the pass-1
fan-out parses in every thread, so every thread carries its own transient trees
and committed-heap slack. The `gc()`-every-32-files spike (obtained via
`v8.setFlagsFromString` + `vm.runInNewContext`, because `--expose-gc` is an
invalid Worker `execArgv` flag — `ERR_WORKER_INVALID_EXEC_ARGV`) bought 62 MB
per phase for a doubled pass 1 and is rejected. The thread heap ceiling is 6,144
MB (`ENRICHMENT_WORKER_MEMORY_LIMIT_MB`, sized for taxdome's `ts.Program`),
which is why V8 collects lazily and native tree-sitter trees wait for
finalization; lowering it globally is not an option. The one lever with a
measurable, cost-free effect on small projects is the pool size — filed as
E6.2a. Python's own share of the live worker peak is small; the walker fixes of
E6.1 remain the win, and the residual is pipeline machinery, language-blind.

Also seen on every run from the branch build: `codegraph daemon build mismatch`
— the running DuckDB daemon is `main`'s build, so the worktree client spawns its
own (the 125–148 MB "child" in the sampler). It clears once `main` is rebuilt
after the merge.

### E6.2 measured — 2026-09-12, `49823d6ab`

E6.1 left the walker's own traversals as the largest remaining pass-1 cost:
`walker.ts` self time ~32 % of samples, `python-def-scope-walk.ts` ~10 %. The
cause was that `extractFromPythonFile` walked the SAME materialized tree about
fourteen times per file, once per collector.

Eleven of those descents are now three, through two drivers that pre-order the
tree once and hand each node to every visitor in list order. Every collector
keeps its own body, its own accumulator, and its own pre-order.

| driver                            | collectors folded in                                                                      | descents |
| --------------------------------- | ----------------------------------------------------------------------------------------- | -------- |
| `walkOnce`                        | imports, calls, decorator calls, classExtends, classFieldTypes, localBindingSites (gated) | 6 → 1    |
| `walkPythonClassScopes`           | classAncestors, classFieldTypesByClassKey, classFieldCallResults                          | 3 → 1    |
| `walkPythonScopes` (ast type src) | the per-class field table and the file return-type table                                  | 2 → 1    |

Three traversals were deliberately left alone, each for a reason that would have
changed output:

- `collectPythonInheritanceEdges` — its scope advances through CLASSES only, so
  a class declared inside a `def` keys `Outer.Inner` there and `build.Local` on
  the shared scoped descent, and it walks a function's non-body children that
  the shared descent prunes.
- `collectPythonCallResultBindings` — it descends `namedChildren`, a different
  node set from `children`, and carries an `inFunction` flag the flat driver has
  no notion of.
- the other three inline type sources (`annotations`, `docstring`, `iteration`)
  — `PYTHON_INLINE_TYPE_SOURCES` is consumed with `flatMap`, so facts are
  concatenated per source; `iteration` and `ast` share the `PYTHON_AST_SOURCE`
  rank, and interleaving their emission could move a same-rank tie in
  `TypeFactStore.fromFacts`.

`collectPythonClassFieldTypes` keeps its inner per-class-body walk, and the
per-chunk slicing of `localBindingSites` / `callResultBindings` is untouched.

#### Byte-identity and tally — both clean

`scripts/spikes/py-extraction-dump.ts` on five corpora, BEFORE at `97277b953`
and AFTER at `49823d6ab`, compared with `cmp`: **zero diff on all five** (flask
36 files, httpx 23, ugnest 262, netbox 1094, polar 3095; parse failures 0
everywhere). The dumps were re-taken against the committed source after
lint-staged reformatted mid-run, so the compared bytes are the ones that landed.

Chain tally reproduced its counts exactly on every corpus and on BOTH arms of
every timed run — 28 tally runs in total, all with `chain drift 0`:

| corpus | edges | unresolved | file-only |
| ------ | ----- | ---------- | --------- |
| flask  | 349   | 997        | 0         |
| httpx  | 499   | 1050       | 0         |
| ugnest | 778   | 3953       | 0         |
| netbox | 8711  | 35415      | 0         |
| polar  | 17774 | 38936      | 0         |

#### The A/B did not get a quiet machine, and the numbers say so

The protocol wanted a 1-minute load under 8. Across the 90-minute window the
machine never went below 110: ten sibling worktrees were running their own
suites, and the load oscillated between 110 and 390 with 37 concurrent `vitest`
processes at the peak. The fallback was taken — interleaved A/B pairs with the
load recorded beside each run — and a second instrument, whole-process user CPU,
was added because wall clock at this contention measures the other executors.

Wall clock, `pass1` seconds, warm-up `#0` discarded:

| corpus | arm    | #1 (load)   | #2 (load)   | #3 (load)   | min   | median |
| ------ | ------ | ----------- | ----------- | ----------- | ----- | ------ |
| polar  | before | 64.41 (125) | 58.20 (278) | 84.19 (193) | 58.20 | 64.41  |
| polar  | after  | 70.52 (121) | 28.84 (271) | 23.03 (161) | 23.03 | 28.84  |
| netbox | before | 15.06 (111) | 7.78 (296)  | 16.38 (170) | 7.78  | 15.06  |
| netbox | after  | 58.79 (211) | 27.76 (206) | 86.51 (170) | 27.76 | 58.79  |

These are not a measurement. The intra-arm spread is 1.4× on polar-before and
3.1× on netbox-after, every single run is 2–18× slower than E6.1's quiet
baselines (polar 12.81 s, netbox 4.70 s), and the two corpora disagree in
DIRECTION at matched load. `load1` is a one-minute average sampled before a run
that then spans one to two minutes, so it does not even describe the contention
the run actually met.

Whole-process user CPU is far less contention-sensitive — in the polar `#0` pair
the wall moved 38.22 s → 116.68 s while user CPU moved 23.04 s → 24.52 s — so it
is the instrument that can still say something here:

| corpus | arm    | user CPU #0 / #1 / #2 | min   | median |
| ------ | ------ | --------------------- | ----- | ------ |
| polar  | before | 23.04 / 23.63 / 21.57 | 21.57 | 23.04  |
| polar  | after  | 24.52 / 22.23 / 23.06 | 22.23 | 23.06  |
| netbox | before | 9.71 / 9.82 / 8.84    | 8.84  | 9.71   |
| netbox | after  | 9.00 / 8.96 / 9.68    | 8.96  | 9.00   |

Flat. polar median +0.1 %, netbox median −7.3 %, and both sit inside the
intra-arm spread (±5 % polar, ±10 % netbox). No effect is resolvable in either
direction.

**The verdict: the perf gate is INCONCLUSIVE, and the per-LOC comparison against
TypeScript's 0.241 s/10k LOC cannot be computed from these runs.** What is
established is that the change is output-neutral on five corpora and that it
removes eight full tree descents per Python file. What is not established is
that this is worth measurable time. Whoever re-runs it needs an actually idle
machine; nothing else about the change needs redoing.

There is also a reason to expect the effect to be modest even when it is
measured. Fusing N walks into one does not reduce how often the visitor BODIES
run — that stays N per node. What it removes is N−1 recursive descents and their
per-node iterator setup, plus N−1 pointer-chasing passes over the tree. On a
corpus where the bodies dominate, the ceiling on this fix is the traversal
overhead alone, not the 32 % the profile attributes to `walker.ts` as a whole.

#### Parent re-measure — 2026-09-12, integration tree `d323c26be`

Taken by the parent session once every executor had finished. The machine was
not quiet by the plan's rule — load 21–43, all of it one runaway `coreaudiod`
holding ~6 of 12 cores steady — but a single-threaded tally gets a free core
under that shape, and the two arms ran back to back under the same load. Arm B
flips ONLY `src/core/domains/language/python/walker/` back to `97277b953`
(pre-fusion traversals; resolver, kernel and every other tail identical), arm A
is the integration tree. One warm-up discarded, three kept, min and median:

| corpus | arm | pass 1 min | pass 1 median | peak RSS median |
| ------ | --- | ---------- | ------------- | --------------- |
| polar  | B   | 13.22 s    | 13.25 s       | 2,228 MB        |
| polar  | A   | 12.80 s    | 12.87 s       | 2,226 MB        |
| netbox | B   | 4.83 s     | 4.86 s        | 1,177 MB        |
| netbox | A   | 4.71 s     | 4.75 s        | 1,166 MB        |

**−3.2 % / −2.5 % of pass 1 (min), −2.9 % / −2.3 % (median), memory flat.** Edge
and unresolved counts identical in both arms (polar 17,791 / 38,919 — the
post-1v12o.4 figures — netbox 8,711 / 35,415). That is the traversal overhead
the section above bounded the fix by, and no more: the visitor bodies still run
once per collector per node. The fusion stays because it is byte-identical and
structurally simpler, not because it moved the verdict. Python's per-LOC wall
(pass 1 + pass 2, polar and netbox averaged) goes 0.310 → ~0.303 s/10k LOC
against TypeScript's 0.241 — +26 %, still outside the ±25 % band by a point.

---

## Task E6.0b — the offline matrix

**Files:**

- `docs/superpowers/plans/2026-09-11-python-e6-perf-parity.md` — the tables
  below, filled in place
- `scripts/lib/codegraph-corpora.json` — an `e6` block per Python corpus

**Interfaces:** none. This task runs commands and records numbers.

**Steps:**

- [x] **Step 0 — worktree**, as E6.0a Step 0, ff-merging the branch that carries
      E6.0a.

- [x] **Step 1 — declare the machine quiet.** `ps aux | sort -nrk 3 | head -5`
      and confirm nothing above a few percent CPU. No parallel agent build, no
      reindex, no test suite. Record the check in the commit body — a run whose
      transcript cannot show it was quiet is not evidence.

- [x] **Step 2 — the run function.** Every row is produced by exactly this, four
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

- [x] **Step 3 — the six rows.** Python twice (the two large corpora), Ruby
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

- [x] **Step 4 — fill the raw table.** Every cell from the `--timing` block:

  Filled in **"E6.0b measured — 2026-09-11, `809c50314`"** above, with a median
  column beside the min for total wall and peak RSS.

- [x] **Step 5 — fill the normalized table and take the verdict.**

  Filled in the same section. Verdict: **BREACH on all four metrics**,
  attributed to pass 1 — Python's resolver is the fastest of the three per call
  site.

  Then, per metric, Python's figure against the Ruby and the TypeScript one.
  Python's row is the MEAN of rows 1 and 2 (polar and netbox), because a
  single-corpus Python figure would be compared against a single-corpus Ruby
  figure and neither would carry its own spread:

  | metric      | python | ruby  | ts (checker off) | vs ruby  | vs ts    | verdict |
  | ----------- | ------ | ----- | ---------------- | -------- | -------- | ------- |
  | s/1k sites  | 0.255  | 0.065 | 0.146            | +291.6 % | +75.2 %  | BREACH  |
  | s/10k LOC   | 0.439  | 0.359 | 0.241            | +22.4 %  | +82.4 %  | BREACH  |
  | MB/1k files | 1,903  | 572   | 931              | +232.7 % | +104.3 % | BREACH  |
  | peak MB abs | 2,228  | 791   | 947              | +181.6 % | +135.2 % | BREACH  |

  A metric is a **PASS** at |Python − other| / other ≤ 0.25 against BOTH. A
  per-site PASS with a per-LOC BREACH is recorded as a **WALKER finding** and
  attributed via `pass1Ms`; the reverse is a **RESOLVER finding** via `pass2Ms`.
  Row 3 minus row 2 attributes any Python-only regression to the E4.0.3 dispatch
  layer. Rows 5 vs 6 quantify what the `ts.Program` costs, which is context for
  the memory verdict, not part of it.

- [x] **Step 6 — freeze the Python numbers.** Add an `e6` block beside each
      Python corpus's existing `baseline` in
      `scripts/lib/codegraph-corpora.json` —
      `{ "wallSeconds": …, "peakRssMb": …, "sites": …, "loc": …, "files": … }` —
      and extend the existing baseline test (the one at
      `2026-09-08-python-codegraph-e0-measurement.md:357`) with the new fields
      so a later change that moves them fails a test rather than going
      unnoticed. Do NOT overwrite `baseline`: E0's figures are the historical
      anchor, and flask's 275 MB → 320 MB drift between E0 and today is exactly
      the kind of movement a second block preserves and an overwrite erases.

- [x] **Step 7 — commit.**

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

- [x] **Step 0 — worktree**, ff-merging the branch carrying E6.0b.

- [x] **Step 1 — profile the breaching leg, offline, single process.**

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

- [x] **Step 2 — check the named suspects before hunting.** For a PYTHON breach
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

- [x] **Step 3 — fix, with the A/B as the gate.** Before and after, on the SAME
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

- [x] **Step 4 — re-measure the breaching metric** with E6.0b Step 2's exact
      command, min of 3, and put the new number in the verdict table next to the
      old one. If it is still outside ±25 %, say so and file the remainder
      rather than declaring victory on a direction of travel.

- [x] **Step 5 — full gate + commit.** `npx tsc --noEmit`,
      `npm run test:coverage`. Commit `perf(<scope>): … (e6)`.

**Recorded in "E6.1 measured — 2026-09-12, `7c317d00f`" above.** Three fixes
landed — `5a50f52f5` local bindings once per file, `13dd6dd74` inert-file fast
path, `7c317d00f` lazy field map. The profile was the parent session's and named
the walker and the materializer, not a resolver, so the suspect table in Step 2
is ELIMINATED wholesale: E6.0b had already measured Python's pass 2 as the
fastest of the three languages per call site. Parity held on all three languages
— extraction dumps byte-identical on the five Python corpora and mastodon, Ruby
resolver parity 0 over 42,057 sites, `chain drift 0` everywhere. All four
metrics improved and all four still BREACH, which the record says rather than
claiming a direction of travel.

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
