# Python Frontier E4.0 — Measurement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Frontier E4's ordering measurable before any of it is built. Four
things are missing and each blocks a claim E4.1–E4.6 would otherwise have to
make on faith. (1) **22,755 rows are outside every denominator** — polar 20,424
and netbox 2,331 — because parso 0.8.7, the parser jedi 0.20.0 pins, cannot read
Python 3.14 grammar; a second offline oracle answers those files or the report
keeps saying so out loud. (2) **The dispatch layer has never been run by the
harness**: both the oracle (`py-codegraph-jedi-oracle.ts:225`) and the tally
(`codegraph-chain-tally.ts:438`) `continue` past a `CallRef` carrying `dispatch`
and neither ever calls `resolveDispatch`, while production calls it FIRST and
lets a fan-out REPLACE the chain's answer (`resolution-runner.ts:557`). (3)
**Nobody has measured how much of the phantom population is the oracle being
wrong** — two such shapes are already known and hand-patched
(`applySuperMroBlindSpot`, `oracleNonCallable`), and flask's 2.82 % is ten rows.
(4) **The residual is no longer one shape**: 762 missed rows over a dozen
families with nothing above 424, so the next increment's order is an attribution
question, not a design question.

**Architecture:** Additive instrumentation on the two existing harnesses, no
production file changed. A second oracle process speaks the SAME stdin/stdout
NDJSON contract as `scripts/py-oracle/jedi_oracle.py`, so the TS host merges
replies **per FILE** behind one `--oracle jedi|lsp|merged` flag and every row
carries `oracleEngine`. Fan scoring is a second scoring pass over the same walk:
the harness calls `production.resolveDispatch(call, ctx)` alongside
`resolveViaChain`, records `fanOutcome` / `fan` / `fanSize` / `fanConfidence` /
`fanHitsOracle`, and prints them in their own column group — `--no-dispatch`
reproduces today's columns byte-for-byte and that identity is the task's gate.
The report is jq/tsx over the row dumps, not new harness code. Nothing here runs
in the indexer, and no engine is introduced to production.

**Tech Stack:** TypeScript (NodeNext, `strict`), vitest, tsx for the corpus
harnesses; Python 3.13 / 3.14 under `uv run --no-project` for the oracle side.
Verified on this machine:
`uv run --no-project --python 3.13 --with jedi==0.20.0` resolves **jedi 0.20.0 /
parso 0.8.7 on CPython 3.13.7**; `node v24.14.1`; **neither `pyright` nor `ty`
is installed** (`command not found`, and neither is in the `uv` cache) — E4.0.1
installs both.

**Spec:** `docs/superpowers/specs/2026-09-10-python-frontier-e4-design.md` —
"E4.0 A — the second oracle" (contract, merge rule, denominator rule), "E4.0 B —
fan scoring" (columns, cap interaction, why 1:1 and fan are never summed), "E4.0
C — the oracle-disagreement audit" (the six classes), "E4.0 D — family
attribution" (the family table and the ordering rule), "Interaction with 4vg1i /
8qyax". Measurement baseline:
`docs/superpowers/specs/2026-09-03-python-codegraph-e0-measurement-design.md` →
"Final measurement record" and components A/B. Predecessors, whose plan format
this one reuses: `docs/superpowers/plans/2026-09-10-python-recall-frontier.md`
(seam 5, decisions 1 and 11) and
`docs/superpowers/plans/2026-09-10-python-django-managers.md` (E3, decision 12
and the closing measurement record).

---

## Decision record

### E4.0 — the measurement increment (`w205u`)

**1. The population this increment exists for, measured.** Recall, precision and
edges from E3's closing measurement record (`6d9eee602`,
`docs/superpowers/plans/2026-09-10-python-django-managers.md`); the degraded
counts from the E0 final measurement record (`30a1d1891`).

| corpus | recall | phantom + wrongFile / edges | edges  | oracleDegraded rows |
| ------ | ------ | --------------------------- | ------ | ------------------- |
| ugnest | 0.970  | 0 / 770 = 0.00 %            | 770    | 0                   |
| netbox | 0.969  | 27 / 8,651 = 0.31 %         | 8,651  | **2,331**           |
| polar  | 0.951  | 186 / 16,623 = 1.12 %       | 16,623 | **20,424**          |
| httpx  | 0.961  | 8 / 491 = 1.63 %            | 491    | 0                   |
| flask  | 0.874  | 10 / 355 = 2.82 %           | 355    | 0                   |

Residual `missed` rows, summed over the receiver kinds E3 published a residual
for: netbox 110 (`chain` 7, `localVar` 50, `dynamic` 41, `bareCall` 12), polar
652 (`chain` 75, `localVar` 50, `dynamic` 424, `bareCall` 103). Nothing above
424, which is why E4's order is an attribution question. Per-corpus TOTALS
across all kinds are not published anywhere and E4.0.4 is what produces them.

The degraded column is the one this plan attacks first. polar's 20,424 is ~24.7
% of its 82,554 call sites, and those rows are dropped by `isDegraded`
(`scripts/lib/py-oracle-core.ts:275`) from every rate the program has published.

**2. Why a SECOND oracle and not a newer parso.**
`scripts/py-oracle/pyproject.toml` already answers this in a comment and the
answer stands: jedi pins parso, and floating parso to a version jedi has not
been tested against trades a KNOWN degradation the harness reports for an
unknown one it cannot see. The oracle's job is to be trustworthy, not to be
current. A second engine with its own maintained parser, merged per file, keeps
the known-good population untouched.

**3. Per FILE, never per site.** jedi's answer is not a pure function of the
file: `jedi_oracle.py:539` documents that the per-process module cache makes one
file's answer depend on what that worker parsed before it, which is why the pool
uses a striped partition with `maxtasksperchild=1`. Mixing two engines inside
one file would put two module resolutions behind one `jedi.Script` cache. The
host already keys replies by `relPath` (`askOracle` returns
`Map<string, PyOracleFileReply>`), so per-file merging is the shape the code
already has.

**4. Both denominators, permanently.** Adding rows changes every published rate
with no resolver change. So the report prints `recallLegacy` (jedi-answerable
rows only — must reproduce E3's closing numbers exactly, and that identity is a
GATE) beside `recallMerged`, with `nLegacy` / `nMerged` printed, never inferred.

**5. Determinism is a hard gate, and "neither" is an admissible outcome.** Two
consecutive full runs on one corpus must produce byte-identical dumps on
`(relPath, startLine, callText) → (kind, origin, target.relPath, target.symbolId)`.
An LSP server accumulates workspace state; jedi needed `PYTHONHASHSEED` pinned
(`ORACLE_PYTHON_HASH_SEED`, `vua9f`: three polar runs scored 14,947 / 14,984 /
10,482) before it was reproducible. If neither candidate passes, E4.0.1 records
that and the denominator stays where it is.

**6. The spike keeps no code.** E4.0.1 writes throwaway scripts under
`scripts/spikes/` and deletes them in its own final commit. Its deliverable is
decision D7 in the spec, filled in with measured numbers.

**7. Fan scoring is additive and provably so.** `--no-dispatch` must reproduce
the current columns byte-for-byte. That is not a promise in a docblock, it is
E4.0.3's gate: dump rows before and after with `--no-dispatch` and `diff` them.

**8. `ambiguous` counts as a fan miss and is excluded from fan SIZE.** An
over-cap decision emits no edges and no fallback (`dispatch-narrowing.ts`
terminal, `resolveDispatchViaComponents` treats it as decisive). It is a cost of
the cap, so it belongs in `recallAtFan`'s denominator as a miss; there is no fan
to size, so it is out of `fanSize*` and `precisionProxy`.

**9. `4vg1i` changes what the LIVE side reports, not what this plan measures.**
The persisted `structuredReturnTypes` / `functionReturnTypes` channels (`8qyax`)
repair the INCREMENTAL path; the harness has always built its channels from a
full walk (`py-codegraph-jedi-oracle.ts:180`), so every number here is a
full-walk number and none of them move. The entry-narrowing gate (`2c321ba26`)
restricts `callsUnnarrowedTemplate` to `constant` receivers and splits it per
kind on `CodegraphResolveKindRow`; the registries it reads are Ruby-only, so
Python reads 0 in every bucket and E4.0 adopts that as a free live assertion
rather than as a metric. The column E4.1 will actually move is
`ambiguousFanout`, already present per kind.

---

## Global Constraints

- **No production file is edited by this plan.** Everything lands under
  `scripts/`, `tests/scripts/` and `docs/`. A task that finds itself wanting to
  change `src/core/` has found a different task and stops.
- **`--oracle jedi` is the default and is byte-identical to today.** Every task
  that touches the host proves it by dumping rows before and after and diffing.
- **`recallLegacy` reproduces E3's closing numbers exactly**: netbox `chain`
  0.972 (241/248), netbox `localVar` 0.764, netbox `dynamic` 0.973, netbox
  `bareCall` 0.997, polar `localVar` 0.888, polar `chain` 0.953, ugnest / flask
  / httpx byte-identical. A deviation is a harness bug, not a finding.
- **Determinism before publication.** No number from a new engine is quoted
  before its two-run byte-identical check has passed on at least one corpus.
- **Seeded sampling only.** `samplePyRows` + `mulberry32` — never first-N. The
  audit's 100 rows are drawn with a recorded seed.
- **No network at measurement time.** Engines are installed once in E4.0.1; the
  measurement runs offline so a registry outage cannot silently change an
  answer.
- **Perf.** The harness is not production, but a run that cannot finish is not a
  measurement: polar's jedi pass is 15–40 min at `--workers 8`, and the second
  engine's per-1k-sites wall is a spike deliverable precisely so E4.0.2 can
  refuse an engine that would push a corpus past an hour.
- **Commits.** `feat(scripts): … (w205u)`, `test(scripts): … (w205u)`,
  `docs(specs): … (w205u)`. Body wrapped at ≤ 100 columns. Trailers
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01FNCoxgrknsrkLSDjn1p5Mm`.
  `scripts` is a non-release scope — no version bump, and no
  `language-capability-sync` obligation, because no walker or resolver changes.
- **Execution.** A fresh Opus executor per task, in its own agent worktree,
  ff-merging `worktree-py-frontier-e4` in Step 0. Tool calls ≤ 8 min; writes ≤
  120 lines per call. Live validation is user-gated. Never push.

---

## File Structure

```text
scripts/
├── spikes/
│   ├── py-second-oracle-pyright.mts       NEW → DELETED by E4.0.1's last commit
│   ├── py-second-oracle-ty.mts            NEW → DELETED by E4.0.1's last commit
│   └── py-second-oracle-compare.mts       NEW → DELETED by E4.0.1's last commit
├── py-oracle/
│   ├── jedi_oracle.py                     —    unchanged, and that is a gate
│   ├── pyproject.toml                     —    unchanged
│   └── lsp_oracle.ts                      NEW  E4.0.2, schema-identical rows
├── lib/
│   ├── py-oracle-core.ts                  MOD  oracleEngine + fan fields on PyOracleRow,
│   │                                           mergeOracleReplies, fan tallies
│   ├── py-oracle-origin.ts                NEW  classifyOrigin ported from jedi_oracle.py
│   └── codegraph-corpora.json             —    unchanged
├── py-codegraph-jedi-oracle.ts            MOD  --oracle, --no-dispatch, fan pass, fan columns
├── codegraph-chain-tally.ts               MOD  --with-dispatch, fan counters
└── py-e4-family-report.mts                NEW  E4.0.4, jq-equivalent over dumps

tests/scripts/
├── py-oracle-core.test.ts                 MOD  merge rule, fan tallies, origin port
├── py-codegraph-jedi-oracle.test.ts       MOD  --oracle parsing, fan row shape
└── py-second-oracle-merge.test.ts         NEW  the per-file fallback table

docs/superpowers/
├── specs/2026-09-10-python-frontier-e4-design.md   MOD  D7 and D8 filled in
└── plans/2026-09-10-python-e4-0-measurement.md     MOD  Measurement record at close

~/.claude/jobs/<job>/tmp/e4/                        row dumps, not in the repo
```

---

## Context the implementer needs

### How a row is produced today, end to end

`walkCorpus` (`py-codegraph-jedi-oracle.ts:~140`) selects files exactly as
production does, builds ONE `InMemoryGlobalSymbolTable` over every
`CODEGRAPH_LANGUAGES` extension, and then, for each `.py` chunk, assembles a
`CallContext` by hand from the extraction — `imports`, `classFieldTypes`,
`localBindings`, `callResultBindings`, `classExtends`, `structuredReturnTypes`,
`functionReturnTypes`, `classAncestors`, `classFieldTypesByClassKey`,
`moduleReexports`. For each call it runs a probed copy of the chain
(`AnsweredByProbe` records `answeredBy`), cross-checks against the real
`provider.resolver` (`chainDrift` non-zero voids the run), and pushes a
`PyChainSite`. **The line that matters for E4.0.3** is:

```ts
for (const call of chunk.calls ?? []) {
  if (call.dispatch !== undefined) continue; // the runner skips normal resolution here
```

`askOracle` spawns the Python side ONCE per corpus, writes a config line then
one `{kind:"file"}` line per file, and collects
`Map<relPath, PyOracleFileReply>`. `buildRows` joins them with a per-file CURSOR
— the Nth site of a file is matched to the Nth answer — applies
`applySuperMroBlindSpot`, and calls `classifyPyVerdict`. `PYTHONHASHSEED` is
pinned to `ORACLE_PYTHON_HASH_SEED` because jedi's answer is otherwise not
reproducible (`vua9f`).

### The verdict lattice, and which rows are in a denominator

`classifyPyVerdict` (`scripts/lib/py-oracle-core.ts:107`) has a strict
precedence, and it is documented in that file: `parseFailed` wins outright (no
AST ⇒ no ground truth), then `oracleNonCallable` (jedi points at an assignment,
so there is no callable target for any chain to find, `z796g`), then
`skippedInProject` (the classifier called the site external and jedi found it
in-project — the classifier's own precision defect). `tallyPyRows` folds
`skippedInProject` into `missed`; `isDegraded` drops `oracleDegraded`,
`parseFailed` and `oracleNonCallable` from the rates entirely. A second engine
does not change this lattice — it changes which rows carry `oracleDegraded`.

### What production does that the harness does not

`CallEdgeResolutionRunner.dispatchCall` (`resolution-runner.ts:496`) has three
channels. Explicit `call.dispatch` fans through `resolveDispatch` and returns.
`call.dispatchArgs` resolves normally AND fans. The default channel calls
`resolver.resolveDispatch(call, ctx)` **first**: an `ambiguous` outcome records
an aggregate and returns with no edges and no fallback; a non-empty fan-out
emits its edges and returns; only an empty fan-out falls through to
`resolver.resolve`. Python's `resolveDispatch` is one `ConeDispatchResolver`
(`python-resolver.ts:123`). So today's oracle numbers are the EXACT-chain
numbers, and they equal production only where the cone is empty. One data point
says that is everywhere on ugnest — E3's live `prime` read 770 edges, "the
oracle's AFTER dump exactly" — and no other corpus has been checked.

### The fan terminal, verbatim in behaviour

`resolveNarrowedFanout` (`kernel/dispatch-narrowing.ts`): run the narrowers, an
empty survivor set short-circuits to `{kind:"edges", edges:[]}`; exactly one
survivor gives ONE edge at confidence 1.0; more survivors than
`dispatchFanoutPolicyFor(ctx.symbolTable).cap` gives
`{kind:"ambiguous", member, candidateCount}` and NO edges; otherwise m edges at
`discount / m`. The cap is `max(16, ceil(p99 defs-per-member))`, memoised per
symbol-table instance (`kernel/fanout-policy.ts`). `ConeDispatchResolver` never
returns `ambiguous` — it collapses over `coneMax` to a single `poly-base` edge —
so today Python's `ambiguousFanout` reads 0 by construction.

### Where the second oracle plugs in

`parseArgs` currently hard-codes the child command:

```ts
pythonArgv: ["uv","run","--no-project","--python",interpreter,"--with","jedi==0.20.0",
             "python", join(import.meta.dirname, "py-oracle", "jedi_oracle.py")],
```

E4.0.2 turns that into a per-engine launcher record, keeps jedi's exactly as it
is, and adds the chosen engine's. `askOracle` needs no change beyond taking the
launcher it is handed — it already accepts `python: string[]`.

---

## Task E4.0.1 — Second-oracle SPIKE (`pyright` vs `ty`)

**Goal.** Decide, on measured evidence from polar's parso-degraded files, which
engine (if either) can serve as the second oracle. The deliverable is decision
**D7** in the spec, filled in. No code from this task survives it.

**Files.**

| file                                          | verb | what                                          |
| --------------------------------------------- | ---- | --------------------------------------------- |
| `scripts/spikes/py-degraded-files.py`         | NEW  | list the files parso 0.8.7 cannot read        |
| `scripts/spikes/py-lsp-probe.mts`             | NEW  | minimal LSP stdio client, one engine per flag |
| `scripts/spikes/py-second-oracle-compare.mts` | NEW  | the four measurements + the decision matrix   |
| all three                                     | DEL  | removed in this task's final commit           |

**Interfaces.**

```text
uv run --no-project --python 3.14 --with jedi==0.20.0 python \
  scripts/spikes/py-degraded-files.py <corpusRoot> <root>... > degraded.txt

npx tsx scripts/spikes/py-lsp-probe.mts --engine pyright|ty --corpus <root> \
  --files degraded.txt --sites sites.ndjson --out answers.ndjson

npx tsx scripts/spikes/py-second-oracle-compare.mts --answers-a a.ndjson \
  --answers-b b.ndjson [--sample 500]
```

### Steps — E4.0.1

- [ ] **Step 0 — worktree.** Create an agent worktree, `git fetch` and ff-merge
      `worktree-py-frontier-e4`. Confirm `git log -1` is this plan's branch
      head.

- [ ] **Step 1 — install both engines and RECORD the versions.** Both are absent
      on this machine (verified 2026-09-10: `pyright: command not found`,
      `ty: command not found`, neither in the `uv` cache). Install once, offline
      thereafter:

      ```bash
      npm i -g pyright && pyright --version && pyright-langserver --help | head -3
      uv tool install ty && ty --version && ty server --help | head -3
      node --version
      uv run --no-project --python 3.14 --with jedi==0.20.0 \
        python -c "import jedi, parso, sys; print(jedi.__version__, parso.__version__, sys.version)"
      ```

      Paste all four outputs into the task's notes. A version string that cannot
      be pasted is a version that was never checked.

- [ ] **Step 2 — enumerate the degraded population.** parso is the oracle's own
      dependency, so ask it directly rather than inferring from a dump.

      ```python
      # scripts/spikes/py-degraded-files.py — THROWAWAY (bd w205u, E4.0.1)
      """List every file under a corpus whose parso 0.8.7 parse carries error
      nodes. That set IS the `oracleDegraded` population the second oracle has
      to answer; jedi reads those files from a damaged tree."""
      import sys
      from pathlib import Path

      import parso

      def main() -> int:
          root = Path(sys.argv[1]).resolve()
          roots = [root / entry for entry in sys.argv[2:]] or [root]
          grammar = parso.load_grammar()
          for base in roots:
              for path in sorted(base.rglob("*.py")):
                  text = path.as_posix()
                  if "/site-packages/" in text or "/.venv/" in text:
                      continue
                  code = path.read_text(encoding="utf-8", errors="replace")
                  errors = len(list(grammar.iter_errors(grammar.parse(code))))
                  if errors:
                      print(f"{path.relative_to(root).as_posix()}\t{errors}")
          return 0

      if __name__ == "__main__":
          raise SystemExit(main())
      ```

      Run it on polar and netbox. Expect ~79 polar files and 2 netbox files; a
      wildly different count means the corpus moved and the spike must say so.

- [ ] **Step 3 — collect the call sites for those files.** Reuse the production
      walk rather than re-deriving it: run the existing oracle with a dump
      driver and keep the rows whose `relPath` is in `degraded.txt`.

      ```bash
      ORACLE_MODULE=$PWD/scripts/py-codegraph-jedi-oracle.ts \
      DUMP_OUT=/tmp/e4/polar-all.ndjson \
        npx tsx /Users/artk0re/.claude/jobs/dffe3647/tmp/flask-lost/dump-rows.mts \
        --corpus polar --workers 8
      cut -f1 /tmp/e4/polar-degraded.txt | sort -u > /tmp/e4/degraded-paths.txt
      jq -c --slurpfile paths <(jq -R . /tmp/e4/degraded-paths.txt | jq -s .) \
        'select([.relPath] | inside($paths[0]))
         | {relPath, startLine, callText, receiver, member}' \
        /tmp/e4/polar-all.ndjson > /tmp/e4/sites.ndjson
      wc -l /tmp/e4/sites.ndjson   # expect ~20,424 for polar
      ```

      `sites.ndjson` carries `{relPath, startLine, callText, receiver, member}` —
      exactly the record `askOracle` sends the Python side — so the probe's
      answers key against jedi's on `(relPath, startLine, callText)`.

- [ ] **Step 4 — the LSP probe.** One client, two launchers. Both engines speak
      LSP over stdio with `Content-Length` framing, so the transport is shared
      and only the spawn line and the config differ.

      ```ts
      // scripts/spikes/py-lsp-probe.mts — THROWAWAY (bd w205u, E4.0.1)
      /** Minimal LSP stdio client: open a file, ask textDocument/definition at
       *  each recorded callee, write one answer per site. Engine-agnostic. */
      import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
      import { readFileSync, writeFileSync } from "node:fs";
      import { join, resolve as resolvePath } from "node:path";
      import { pathToFileURL } from "node:url";

      const LAUNCHERS: Record<string, string[]> = {
        pyright: ["pyright-langserver", "--stdio"],
        ty: ["ty", "server"],
      };

      class LspClient {
        private readonly child: ChildProcessWithoutNullStreams;
        private buffer = Buffer.alloc(0);
        private nextId = 1;
        private readonly pending = new Map<number, (value: unknown) => void>();

        constructor(command: string[], cwd: string) {
          const [bin, ...args] = command;
          this.child = spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
          this.child.stderr.setEncoding("utf8");
          this.child.stderr.on("data", (piece: string) => process.stderr.write(piece));
          this.child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
        }

        private onData(chunk: Buffer): void {
          this.buffer = Buffer.concat([this.buffer, chunk]);
          for (;;) {
            const header = this.buffer.indexOf("\r\n\r\n");
            if (header < 0) return;
            const head = this.buffer.subarray(0, header).toString("utf8");
            const match = /Content-Length: (\d+)/i.exec(head);
            if (match === null) throw new Error("no Content-Length in LSP header");
            const length = Number(match[1]);
            const start = header + 4;
            if (this.buffer.length < start + length) return;
            const body = this.buffer.subarray(start, start + length).toString("utf8");
            this.buffer = this.buffer.subarray(start + length);
            const message = JSON.parse(body) as { id?: number; result?: unknown };
            if (message.id !== undefined && this.pending.has(message.id)) {
              this.pending.get(message.id)?.(message.result ?? null);
              this.pending.delete(message.id);
            }
          }
        }

        private send(payload: object): void {
          const body = JSON.stringify(payload);
          const size = Buffer.byteLength(body, "utf8");
          this.child.stdin.write("Content-Length: " + String(size) + "\r\n\r\n" + body);
        }

        notify(method: string, params: object): void {
          this.send({ jsonrpc: "2.0", method, params });
        }

        request(method: string, params: object): Promise<unknown> {
          const id = this.nextId++;
          const settled = new Promise<unknown>((done) => this.pending.set(id, done));
          this.send({ jsonrpc: "2.0", id, method, params });
          return settled;
        }

        kill(): void {
          this.child.kill();
        }
      }
      ```

- [ ] **Step 5 — drive it over the sites.** LSP positions are 0-based with
      UTF-16 character offsets; the recorded `startLine` is 1-based and the
      harness carries no column, so the callee is located by searching the line
      for the member name followed by optional whitespace and `(`. A site whose
      member cannot be located is reported `unlocated: "coordinateMiss"` — the
      same shape `jedi_oracle.py` uses, so the two instruments fail alike.

      ```ts
      // …continues py-lsp-probe.mts
      interface Site {
        relPath: string;
        startLine: number;
        callText: string;
        receiver: string | null;
        member: string;
      }

      const read = (flag: string): string | undefined => {
        const index = process.argv.indexOf(flag);
        return index >= 0 ? process.argv[index + 1] : undefined;
      };
      const engine = read("--engine") ?? "pyright";
      const corpus = resolvePath(read("--corpus") ?? process.cwd());
      const sites = readFileSync(read("--sites") ?? "", "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Site);

      const client = new LspClient(LAUNCHERS[engine], corpus);
      const rootUri = pathToFileURL(corpus).href;
      await client.request("initialize", {
        processId: process.pid,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: "corpus" }],
        capabilities: { textDocument: { definition: { linkSupport: true } } },
      });
      client.notify("initialized", {});

      const byFile = new Map<string, Site[]>();
      for (const site of sites) {
        const bucket = byFile.get(site.relPath);
        if (bucket) bucket.push(site);
        else byFile.set(site.relPath, [site]);
      }

      const keyOf = (site: Site) => ({
        relPath: site.relPath,
        startLine: site.startLine,
        callText: site.callText,
        member: site.member,
      });
      const locateMember = (line: string, member: string): number => {
        const escaped = member.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const found = new RegExp("\\b" + escaped + "\\s*\\(").exec(line);
        return found === null ? -1 : found.index;
      };

      const answers: unknown[] = [];
      for (const relPath of [...byFile.keys()].sort()) {
        const absolute = join(corpus, relPath);
        const text = readFileSync(absolute, "utf8");
        const lines = text.split("\n");
        const uri = pathToFileURL(absolute).href;
        client.notify("textDocument/didOpen", {
          textDocument: { uri, languageId: "python", version: 1, text },
        });
        for (const site of byFile.get(relPath) ?? []) {
          const column = locateMember(lines[site.startLine - 1] ?? "", site.member);
          if (column < 0) {
            answers.push({ ...keyOf(site), outcome: { kind: "unknown" }, unlocated: "coordinateMiss" });
            continue;
          }
          const raw = await client.request("textDocument/definition", {
            textDocument: { uri },
            position: { line: site.startLine - 1, character: column },
          });
          answers.push({ ...keyOf(site), raw });
        }
        client.notify("textDocument/didClose", { textDocument: { uri } });
      }
      client.kill();
      writeFileSync(read("--out") ?? "answers.ndjson", answers.map((a) => JSON.stringify(a)).join("\n") + "\n");
      ```

      Run it once per engine on the polar degraded set, timing each:

      ```bash
      mkdir -p /tmp/e4
      time npx tsx scripts/spikes/py-lsp-probe.mts --engine pyright \
        --corpus ~/Dev/Tools/tea-rags-bench/corpora/polar \
        --sites /tmp/e4/sites.ndjson --out /tmp/e4/pyright-1.ndjson
      time npx tsx scripts/spikes/py-lsp-probe.mts --engine ty \
        --corpus ~/Dev/Tools/tea-rags-bench/corpora/polar \
        --sites /tmp/e4/sites.ndjson --out /tmp/e4/ty-1.ndjson
      ```

- [ ] **Step 6 — the four measurements.** One comparison script produces all of
      them, so nothing is eyeballed.

      ```ts
      // scripts/spikes/py-second-oracle-compare.mts — THROWAWAY (bd w205u, E4.0.1)
      /** answerable / determinism / wall / agreement, from probe dumps. */
      import { readFileSync } from "node:fs";

      interface Answer {
        relPath: string;
        startLine: number;
        callText: string;
        member: string;
        raw?: unknown;
        unlocated?: string;
      }
      const load = (path: string): Map<string, Answer> => {
        const map = new Map<string, Answer>();
        for (const line of readFileSync(path, "utf8").split("\n")) {
          if (line.trim() === "") continue;
          const row = JSON.parse(line) as Answer;
          map.set(`${row.relPath} ${String(row.startLine)} ${row.callText}`, row);
        }
        return map;
      };
      /** An LSP definition result is Location | Location[] | LocationLink[] | null. */
      const targetsOf = (raw: unknown): { uri: string; line: number }[] => {
        const list = raw === null || raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
        return list.flatMap((entry) => {
          const item = entry as Record<string, unknown>;
          const uri = (item.uri ?? item.targetUri) as string | undefined;
          const range = (item.range ?? item.targetSelectionRange ?? item.targetRange) as
            | { start: { line: number } }
            | undefined;
          return uri === undefined || range === undefined ? [] : [{ uri, line: range.start.line }];
        });
      };
      const answered = (row: Answer | undefined): boolean =>
        row !== undefined && row.unlocated === undefined && targetsOf(row.raw).length > 0;
      const fingerprint = (row: Answer | undefined): string =>
        row === undefined ? "-" : targetsOf(row.raw).map((t) => `${t.uri}:${String(t.line)}`).sort().join(",");

      const read = (flag: string): string | undefined => {
        const index = process.argv.indexOf(flag);
        return index >= 0 ? process.argv[index + 1] : undefined;
      };
      const a = load(read("--answers-a") ?? "");
      const b = read("--answers-b") === undefined ? null : load(read("--answers-b") ?? "");
      const total = a.size;
      const answerable = [...a.values()].filter((row) => answered(row)).length;
      process.stdout.write(`sites ${String(total)}\n`);
      process.stdout.write(
        `answerable ${String(answerable)} (${((answerable / Math.max(total, 1)) * 100).toFixed(1)}%)\n`,
      );
      if (b !== null) {
        let same = 0;
        let differ = 0;
        for (const [key, row] of a) {
          if (fingerprint(row) === fingerprint(b.get(key))) same += 1;
          else differ += 1;
        }
        process.stdout.write(`identical ${String(same)} · different ${String(differ)}\n`);
      }
      ```

      The four numbers, each with the command that produces it:

      | measurement            | command                                                           | bar                            |
      | ---------------------- | ----------------------------------------------------------------- | ------------------------------ |
      | answerable sites       | `compare --answers-a <engine>-1.ndjson`                           | report; no bar, it is evidence |
      | determinism            | run the probe twice, `compare --answers-a run1 --answers-b run2`  | **different must be 0**        |
      | wall per 1k sites      | `time` from step 5, divided by `sites / 1000`                     | report; E4.0.2 refuses > 1 h/corpus |
      | agreement with jedi    | 500-site sample of files BOTH parse (below)                       | report + classify every miss   |

- [ ] **Step 7 — the agreement sample.** Draw 500 sites from files with ZERO
      parso errors — the population where jedi is trustworthy — using the same
      seeded sampler the harness uses, so the sample is reproducible:

      ```bash
      # sites from NON-degraded polar files, sampled with a recorded seed
      jq -c --slurpfile paths <(jq -R . /tmp/e4/degraded-paths.txt | jq -s .) \
        'select([.relPath] | inside($paths[0]) | not)
         | {relPath, startLine, callText, receiver, member, oracleTargetRelPath, oracleTargetSymbolId}' \
        /tmp/e4/polar-all.ndjson > /tmp/e4/clean-all.ndjson
      npx tsx -e "import {readFileSync,writeFileSync} from 'node:fs';import {mulberry32} from './scripts/lib/py-oracle-core.js';const rows=readFileSync('/tmp/e4/clean-all.ndjson','utf8').split('\n').filter(l=>l.trim());const rand=mulberry32(20260910);const picked=rows.filter(()=>rand()<500/rows.length).slice(0,500);writeFileSync('/tmp/e4/agreement-sites.ndjson',picked.join('\n')+'\n');"
      ```

      Run each engine over `agreement-sites.ndjson` and compare its target
      against the `oracleTargetRelPath` / `oracleTargetSymbolId` the dump already
      carries from jedi. Report agreement as a percentage AND classify every
      disagreement by hand into: engine-right, jedi-right, both-wrong,
      different-question (a `@property`, a descriptor, an overload set). A raw
      percentage with no classification is not a result.

- [ ] **Step 8 — write decision D7 into the spec.** Edit
      `docs/superpowers/specs/2026-09-10-python-frontier-e4-design.md`,
      replacing the "**pending E4.0.1**" body with the filled template it
      already carries. State the third outcome plainly if it holds: neither
      engine passes, the denominator stays, and E4.0.2 becomes "record the
      degraded counts in the report and stop".

- [ ] **Step 9 — delete the spike.** `git rm` all three files in the final
      commit. The commit body carries the four measurements, so the evidence
      survives the code.

**Gates.**

- Both engines' `--version` outputs pasted into the task notes, plus `node -v`
  and the jedi/parso line.
- Determinism run recorded for the CHOSEN engine on polar: `different 0`, or the
  engine is rejected.
- Agreement disagreements classified individually, not summarised.
- D7 written in the spec with numbers, and `git status` clean of spike files.
- No file under `src/` touched: `git diff --name-only main... | grep '^src/'`
  must print nothing.

### Measurement record — E4.0.1, 2026-09-10, HEAD `52163fa2e`

Versions, as run: pyright **1.1.414**
(`npx --yes --package pyright@1.1.414 pyright-langserver --stdio`), ty **0.0.80
(7fd8e1569 2026-09-09)** (`uvx ty@0.0.80 server`), node **v24.14.1**,
`uv run --no-project --python 3.14 --with jedi==0.20.0` → jedi **0.20.0** /
parso **0.8.7** on CPython **3.14.0rc2**. Both engines are cache-local and
pinned; nothing was installed globally and no corpus venv was written to.

**Population.** `scripts/spikes/py-degraded-files.py` finds **107**
parso-degraded files in polar and **19** in netbox; the production walk carries
**102** and **4** of them, the rest being tests and other excluded trees. The
plan predicted ~79 polar / 2 netbox against an 82,554-site corpus; this walk
reads 56,710 polar sites and 44,126 netbox sites, so the corpus and the
exclusion set have both moved since the E0 record and every ratio below is
stated against the walk it was measured on, not against the older absolute
counts.

| corpus | walk files | walk sites | degraded files walked | degraded sites | share  |
| ------ | ---------- | ---------- | --------------------- | -------------- | ------ |
| polar  | 1,339      | 56,710     | 102 of 107            | 12,494         | 22.0 % |
| netbox | 1,038      | 44,126     | 4 of 19               | 1,732          | 3.9 %  |

**Table 1 — polar's degraded set** (12,491 distinct
`(relPath, startLine, callText)` keys; 708 of them `coordinateMiss`, identical
for both engines because the client's line search is shared):

| engine          | inProject      | pinned | external       | unknown        | 2-run diff | wall / 1k | peak RSS |
| --------------- | -------------- | ------ | -------------- | -------------- | ---------- | --------- | -------- |
| pyright 1.1.414 | 4,717 (37.8 %) | 4,616  | 6,247 (50.0 %) | 1,527 (12.2 %) | **0**      | 2.2 s     | 1,967 MB |
| ty 0.0.80       | 4,717 (37.8 %) | 4,665  | 6,291 (50.4 %) | 1,483 (11.9 %) | **0**      | 0.7 s     | 412 MB   |

Both runs are byte-identical at the file level, not merely row-equal. pyright on
netbox's degraded set for comparison: 449 in-project (25.9 %, all pinned), 735
external, 548 unknown, 2.5 s per 1k, 723 MB.

**Table 2 — the 500-site agreement sample**, drawn with `mulberry32(20260910)`
over the Fisher-Yates index shuffle `samplePyRows` uses, restricted to files
parso reads with zero errors:

| engine      | inProject    | unknown    | same origin / 500 | both inProject | same symbolId     | jedi-only | engine-only |
| ----------- | ------------ | ---------- | ----------------- | -------------- | ----------------- | --------- | ----------- |
| jedi 0.20.0 | 133 (26.6 %) | 31 (6.2 %) | —                 | —              | —                 | —         | —           |
| pyright     | 143 (28.6 %) | 43 (8.6 %) | 427 (85.4 %)      | 132            | 132 (**100.0 %**) | 1         | 11          |
| ty          | 116 (23.2 %) | 41 (8.2 %) | 419 (83.8 %)      | 105            | 104 (99.0 %)      | **28**    | 11          |

The `jedi-only` column is what decided D7: 28 rows where jedi answers in-project
and ty answers `sitePackages`, all under `sdk/python/polar/**`. Both engines add
the same 11 rows jedi cannot answer — `Repository.from_session(...)` receivers,
the shape E4.0.2's merged denominator gains.

**A defect in the spike client, recorded because E4.0.2 inherits it.** The
host's `CallRef` carries no column, so the probe locates the callee by searching
the line for the member name. On `asyncio.run(run())` that finds the wrong
`run`. One row of 500 — but it is a systematic bias toward the leftmost
same-named callee, and `lsp_oracle.ts` must take a column from the host rather
than re-deriving one.

---

## Task E4.0.2 — Second-oracle host integration

**Goal.** Ship the chosen engine as a peer of `jedi_oracle.py` behind
`--oracle jedi|lsp|merged`, with a per-FILE fallback, a determinism check, and
unit tests on the merge rule. `--oracle jedi` stays the default and stays
byte-identical. **Precondition:** spec decision D7 names an engine. If D7 says
"neither", this task reduces to Step 7 (report the degraded counts) and stops.

**Files.**

| file                                           | verb | what                                                |
| ---------------------------------------------- | ---- | --------------------------------------------------- |
| `scripts/lib/py-oracle-origin.ts`              | NEW  | `classifyOrigin` ported from `jedi_oracle.py:64`    |
| `scripts/py-oracle/lsp_oracle.ts`              | NEW  | LSP engine speaking the jedi NDJSON contract        |
| `scripts/lib/py-oracle-core.ts`                | MOD  | `oracleEngine` on the row, `mergeOracleReplies`     |
| `scripts/py-codegraph-jedi-oracle.ts`          | MOD  | `--oracle`, engine launchers, two `askOracle` calls |
| `tests/scripts/py-second-oracle-merge.test.ts` | NEW  | the fallback table                                  |
| `tests/scripts/py-oracle-core.test.ts`         | MOD  | origin port cases                                   |

**Interfaces.**

```ts
export type OracleEngine = "jedi" | "lsp";
export type OracleSelection = OracleEngine | "merged";

/** Per FILE, never per site: jedi's reply unless jedi could not read the file. */
export function mergeOracleReplies(
  jedi: ReadonlyMap<string, PyOracleFileReply>,
  lsp: ReadonlyMap<string, PyOracleFileReply>,
): Map<string, { reply: PyOracleFileReply; engine: OracleEngine }>;

/** Where a target lives. Port of `classify_origin`; ORDER is load-bearing. */
export function classifyOrigin(
  absTargetPath: string | null,
  corpusRoot: string,
): PyTargetOrigin;
```

### Steps — E4.0.2

- [ ] **Step 0 — worktree.** Agent worktree, ff-merge `worktree-py-frontier-e4`,
      confirm E4.0.1 is in the history and that D7 is filled in.

- [ ] **Step 1 — capture the BEFORE dumps.** Before touching the host, dump all
      five corpora with `dump-rows.mts` into `/tmp/e4/before-<corpus>.ndjson`.
      Every later step diffs against these. Record the wall of each run.

- [ ] **Step 2 — port `classify_origin` (TDD, test first).** The Python function
      is 20 lines and its ORDER is the whole content: bundled-stub markers, then
      `site-packages` / `dist-packages`, then the stdlib DIRECTORY regex, and
      ONLY then corpus containment — because ugnest keeps its venv inside its
      own checkout, and root-prefix-first called Django's own source "project"
      in 26 of 30 sampled targets. The stdlib NAME test runs LAST, for a path
      the corpus does not contain.

      ```ts
      // scripts/lib/py-oracle-origin.ts
      import { relative, sep } from "node:path";

      import type { PyTargetOrigin } from "./py-oracle-core.js";

      const STUB_MARKERS = ["/jedi/third_party/typeshed/", "/jedi/third_party/django-stubs/"];
      const STDLIB_DIR = /\/(?:lib\/python3\.\d+|python3\.\d+\/lib)\//;

      /**
       * Port of `jedi_oracle.py:classify_origin`. The ORDER is load-bearing and
       * is not the obvious one — see that docstring for the two measured
       * misclassifications (26/30 ugnest targets, 432 netbox + 46 polar rows)
       * that fixed it there. Any reordering here re-opens both.
       */
      export function classifyOrigin(
        absTargetPath: string | null,
        corpusRoot: string,
        stdlibNames: ReadonlySet<string>,
      ): PyTargetOrigin {
        if (absTargetPath === null) return "builtin";
        const text = absTargetPath.split(sep).join("/");
        if (STUB_MARKERS.some((marker) => text.includes(marker))) return "typeshedStub";
        if (text.includes("/site-packages/") || text.includes("/dist-packages/")) return "sitePackages";
        if (STDLIB_DIR.test(text)) return "stdlib";
        const rel = relative(corpusRoot, absTargetPath);
        if (rel.startsWith("..") || rel === "") {
          const stem = text.slice(text.lastIndexOf("/") + 1).replace(/\.pyi?$/, "");
          return stdlibNames.has(stem) ? "stdlib" : "outsideRepo";
        }
        return rel.split("/").includes("migrations") ? "generatedInRepo" : "project";
      }
      ```

      The stdlib NAME set comes from the corpus interpreter, not from a literal:
      reuse `scripts/py-oracle/gen-stdlib-modules.py`, which already exists for
      the production vocabulary. Tests: one case per branch, plus the two
      regression cases named in the docstring (a venv INSIDE the corpus root; a
      project file called `string.py` / `types.py`).

- [ ] **Step 3 — the engine, speaking the jedi contract.** `lsp_oracle.ts` is
      the spike's probe turned into a long-lived process with the SAME stdin /
      stdout protocol as `jedi_oracle.py`: read a `{kind:"config"}` line, then
      one `{kind:"file"}` line per file, emit one reply object per file.

      ```ts
      // scripts/py-oracle/lsp_oracle.ts
      /**
       * The second oracle (bd tea-rags-mcp-w205u, E4.0.2). Same stdin/stdout
       * NDJSON contract as `jedi_oracle.py`, so the host merges per FILE without
       * knowing which engine answered. It exists for ONE population: the files
       * parso 0.8.7 cannot read — 20,424 polar rows and 2,331 netbox rows that
       * every published rate has dropped. It is NOT a replacement for jedi, and
       * `--oracle jedi` stays the default.
       *
       * `parsoErrors` is always 0 here: the field means "jedi's parser was
       * unhappy", and this engine has no jedi in it. The host reads the field
       * from the JEDI reply when it decides the fallback, never from this one.
       */
      ```

      Requirements, each of which is a test in Step 5:

      1. `symbolId` composition mirrors `compose_symbol_id`: `Class#method`;
         `Class.method` when the target `def` carries `staticmethod` /
         `classmethod`; a bare name at module level; `Outer.Inner` for nesting;
         `defKind: "nonCallable"` + `pinUncertain: true` when the target line
         starts no `def` / `class`; `defKind: "unknown"` + `pinUncertain: true`
         when the target file cannot be read. Read the target file with the
         SAME `_cached_tree`-shaped memo the Python side uses — one parse per
         target file, not one per site.
      2. `outcome.kind` is `inProject` when `classifyOrigin` says `project` or
         `generatedInRepo`, `external` for `stdlib` / `sitePackages` /
         `typeshedStub` / `builtin` / `outsideRepo`, `unknown` when the engine
         returns no target.
      3. `siteFacts` is emitted with the same keys the Python side emits.
         Fields the engine genuinely cannot determine are omitted, never
         guessed — an absent fact and a false fact are different, and
         `categorizePySite` treats them differently.
      4. Output is ordered by `relPath`, and answers within a file are in the
         order the host sent the sites, because `buildRows` joins by CURSOR.

- [ ] **Step 4 — the merge rule, in the pure core (TDD, test first).** It is
      eight lines and it is the whole decision, so it lives beside the verdict
      lattice rather than inside `main`.

      ```ts
      // scripts/lib/py-oracle-core.ts
      export type OracleEngine = "jedi" | "lsp";
      export type OracleSelection = OracleEngine | "merged";

      /**
       * Per FILE, never per site (bd tea-rags-mcp-w205u).
       *
       * jedi is primary: five corpora of published numbers rest on it, and its
       * blind spots are hand-audited (`applySuperMroBlindSpot`,
       * `oracleNonCallable`). The second engine is a REPAIR for files jedi could
       * not read — `parsoErrors > 0` means jedi answered from a damaged tree,
       * `parseFailed` means it had no tree at all — and never a tiebreak on a
       * file jedi read cleanly.
       *
       * File granularity is not a simplification: jedi's per-process module
       * cache makes one file's answer depend on what its worker parsed before it
       * (`jedi_oracle.py:539`), so a per-SITE mix would put two module
       * resolutions behind one `jedi.Script` cache.
       */
      export function mergeOracleReplies(
        jedi: ReadonlyMap<string, PyOracleFileReply>,
        lsp: ReadonlyMap<string, PyOracleFileReply>,
      ): Map<string, { reply: PyOracleFileReply; engine: OracleEngine }> {
        const merged = new Map<string, { reply: PyOracleFileReply; engine: OracleEngine }>();
        for (const [relPath, reply] of jedi) {
          const damaged = reply.parseFailed || reply.parsoErrors > 0;
          const replacement = damaged ? lsp.get(relPath) : undefined;
          merged.set(
            relPath,
            replacement === undefined ? { reply, engine: "jedi" } : { reply: replacement, engine: "lsp" },
          );
        }
        // A file only the second engine saw (jedi's launcher skipped it) still
        // belongs in the population — dropping it would shrink the denominator
        // silently, which is the failure this whole task exists to end.
        for (const [relPath, reply] of lsp) {
          if (!merged.has(relPath)) merged.set(relPath, { reply, engine: "lsp" });
        }
        return merged;
      }
      ```

      Table the unit test pins, one row per case:

      | jedi reply                 | lsp reply | engine chosen | why                          |
      | -------------------------- | --------- | ------------- | ---------------------------- |
      | clean (`parsoErrors: 0`)   | present   | `jedi`        | jedi is primary              |
      | `parsoErrors: 3`           | present   | `lsp`         | damaged tree                 |
      | `parseFailed: true`        | present   | `lsp`         | no tree at all               |
      | `parsoErrors: 3`           | absent    | `jedi`        | no repair available; degraded stays |
      | absent                     | present   | `lsp`         | file only the second saw     |

- [ ] **Step 5 — thread it through the host.** `PyOracleRow` gains
      `oracleEngine: OracleEngine`; `buildRows` takes the merged map and stamps
      each row from the entry it read. `parseArgs` gains
      `oracle: OracleSelection` (default `"jedi"`) and turns the hard-coded
      `pythonArgv` into a per-engine launcher:

      ```ts
      // scripts/py-codegraph-jedi-oracle.ts
      const JEDI_LAUNCHER = (interpreter: string): string[] => [
        "uv", "run", "--no-project", "--python", interpreter, "--with", "jedi==0.20.0",
        "python", join(import.meta.dirname, "py-oracle", "jedi_oracle.py"),
      ];
      const LSP_LAUNCHER = (): string[] => [
        "npx", "tsx", join(import.meta.dirname, "py-oracle", "lsp_oracle.ts"),
      ];
      ```

      `main` then asks the engines the selection requires — `jedi` only, `lsp`
      only, or BOTH for `merged` — and calls `mergeOracleReplies`. `askOracle`
      itself is unchanged: it already takes `python: string[]`.

- [ ] **Step 6 — both denominators in the report.** `tallyPyRows` grows a
      companion that partitions by `oracleEngine`, and the printed block gains,
      per corpus and per receiverKind: `recallLegacy` / `nLegacy` (rows the jedi
      engine answered and `isDegraded` keeps) and `recallMerged` / `nMerged`
      (all non-degraded rows whatever engine answered). Both are printed always,
      and the JSON output carries both. Never print one alone.

- [ ] **Step 7 — determinism, and the identity gate.** Two consecutive
      `--oracle merged` runs on polar, dumped and diffed:

      ```bash
      for run in 1 2; do
        ORACLE_MODULE=$PWD/scripts/py-codegraph-jedi-oracle.ts \
        DUMP_OUT=/tmp/e4/det-$run.ndjson \
          npx tsx .../dump-rows.mts --corpus polar --workers 8 --oracle merged
      done
      diff /tmp/e4/det-1.ndjson /tmp/e4/det-2.ndjson && echo DETERMINISTIC
      ```

      Then the identity gate, which is the more important of the two: dump all
      five corpora with `--oracle jedi` and diff against Step 1's BEFORE dumps.
      **Every byte must match**, `oracleEngine` aside. A single differing row
      means the default path moved and the task is not done.

**Gates.**

- `--oracle jedi` dumps byte-identical to Step 1 on all five corpora.
- `recallLegacy` reproduces E3's closing numbers exactly (netbox `chain` 0.972
  241/248, netbox `localVar` 0.764, polar `localVar` 0.888, polar `chain` 0.953,
  ugnest / flask / httpx byte-identical).
- `--oracle merged` deterministic on polar across two runs: `diff` silent.
- `npm run test:coverage` green. New tests: the merge table (5 rows), the origin
  port (one per branch + the 2 regressions), `--oracle` parsing.
- Merged-run wall recorded per corpus; if any corpus exceeds one hour, the
  report says so and `--oracle merged` is documented as opt-in for that corpus.
- `git diff --name-only` shows nothing under `src/`.

### Measurement record — E4.0.2, corrected legacy site counts (w205u, E4.0.2b)

Two populations were being compared as one, and the mismatch read as a bug in
the merge. The HOST REPORT withholds a degraded row from every rate while still
counting it in `sites`; the scratch dump driver (`dump-rows.mts`) applies no
withholding at all and its verdict histogram counts every row. On netbox the
histogram sums 8,314 recall-verdict rows against the report's 7,894 — the 420
rows in the four parso-damaged files, withheld by the report in BOTH selections.
The host report is canonical for every E4 rate. The dump driver is the row-level
A/B tool: use it for gross lost/gained between two trees, never for a rate.

What was actually wrong was narrower. `main` built its legacy population by
filtering on `oracleEngine === "jedi"`, which dropped a replaced file's sites
outright, so the three published tables printed a short `sites` column under
`--oracle merged` — netbox `bareCall` 17,353 against 18,234, polar `bareCall`
18,067 against 23,367 — while every rate column already matched. A replaced
file's row now carries the row jedi itself produced (`PyOracleRow#legacy`, read
through `legacyViewOf`), degraded flag included, so the legacy side counts it in
`sites` and withholds it from the rates exactly as a jedi-only run does. The
recall block sorts by label rather than by `nMerged`, or the same numbers print
in a different order once the merged denominator grows.

Re-measured at `--workers 8`, netbox and polar: the three legacy tables and the
recall block's legacy columns diff clean between `--oracle jedi` and
`--oracle merged`. netbox legacy recall is unchanged at `bareCall` 0.997
n=4,751, `dynamic` 0.972 n=1,480, `selfMember` 1.000 n=1,008, `chain` 0.971
n=245, `super` 1.000 n=213, `localVar` 0.814 n=167, `constant` 0.897 n=29,
`index` 0.000 n=1 — merged adds 449 second-engine rows on top. jedi flips one
netbox row between runs (`agreeExternal` ↔ `bothUnresolved`, an `ext` column
moving by 1), which is engine noise, not a host defect; a repeat run diffs
clean.

---

## Task E4.0.3 — Fan scoring

**Goal.** Run the Python dispatch layer in the oracle and the tally, score fans
in their OWN columns, and prove the 1:1 columns did not move. Today neither
harness ever calls `resolveDispatch`, while production calls it first
(`resolution-runner.ts:557`), so the size of that parity gap is itself an
unknown this task closes.

**Files.**

| file                                   | verb | what                                                     |
| -------------------------------------- | ---- | -------------------------------------------------------- |
| `scripts/lib/py-oracle-core.ts`        | MOD  | `PyFanOutcome`, fan fields on the row, fan tallies       |
| `scripts/py-codegraph-jedi-oracle.ts`  | MOD  | fan pass in `walkCorpus`, `--no-dispatch`, columns       |
| `scripts/codegraph-chain-tally.ts`     | MOD  | `--with-dispatch`, fan counters beside `dispatchSkipped` |
| `tests/scripts/py-oracle-core.test.ts` | MOD  | fan tallies, `ambiguous` accounting                      |

**Interfaces.**

```ts
export interface PyFanOutcome {
  /** `none` = empty edges (the exact chain runs); `fan` = m ≥ 1 edges; `ambiguous` = over cap, NO edges. */
  kind: "none" | "fan" | "ambiguous";
  /** `${targetRelPath}#${targetSymbolId ?? ""}`, sorted, deduped. Empty for none/ambiguous. */
  fan: string[];
  /** `fan.length` for a fan; `candidateCount` for ambiguous; 0 for none. */
  fanSize: number;
  /** The per-edge confidence the component assigned; null when there are no edges. */
  fanConfidence: number | null;
}

export interface PyFanTally {
  recallAtFan: number;
  fanHits: number;
  fanScored: number;
  fanSizeMean: number;
  fanSizeP50: number;
  fanSizeP95: number;
  ambiguousShare: number;
  precisionProxy: number;
}
export function tallyPyFan(
  rows: readonly PyOracleRow[],
  keyOf: (row: PyOracleRow) => string[],
): Map<string, PyFanTally>;
```

### Steps — E4.0.3

- [ ] **Step 0 — worktree.** Agent worktree, ff-merge `worktree-py-frontier-e4`.

- [ ] **Step 1 — BEFORE dumps again.** Five corpora, `--oracle jedi`, into
      `/tmp/e4/predispatch-<corpus>.ndjson`. Step 6's gate diffs against these.

- [ ] **Step 2 — score the fan in the walk.** In `walkCorpus`, keep the exact
      chain exactly as it is and add a second call. The `call.dispatch` skip
      stays — those sites are the runner's table channel, a different question —
      but it now increments a counter instead of vanishing.

      ```ts
      // scripts/py-codegraph-jedi-oracle.ts — inside the per-call loop
      for (const call of chunk.calls ?? []) {
        if (call.dispatch !== undefined) {
          dispatchTableSites++; // reported, not silently dropped
          continue;
        }
        probe.answeredBy = "none";
        const chain = resolveViaChain(probedChain, call, ctx);
        const truth = production.resolve(call, ctx);
        // …existing drift check…
        // The fan pass. Production consults resolveDispatch BEFORE the exact
        // chain, so this is what production would have emitted at this site.
        const fan = withDispatch ? scoreFan(production, call, ctx) : NO_FAN;
        sites.push({ /* …existing fields…, */ fan });
      }
      ```

      ```ts
      // scripts/lib/py-oracle-core.ts
      export const NO_FAN: PyFanOutcome = { kind: "none", fan: [], fanSize: 0, fanConfidence: null };

      /**
       * What `resolveDispatch` would emit at this site (bd tea-rags-mcp-w205u).
       *
       * NOT summed with the exact chain, ever: a confidence-1 edge is a claim
       * governed by the ≤ 2 % precision bar, a fan edge is a hypothesis set
       * carrying `discount / m` and hidden from navigation. `ambiguous` is the
       * DECISION not to fan at all — no edges, no fallback — so it carries no
       * fan to size and its `fanSize` is the candidate count instead.
       */
      export function scoreFan(
        resolver: { resolveDispatch?: (call: CallRef, ctx: CallContext) => DispatchFanoutOutcome },
        call: CallRef,
        ctx: CallContext,
      ): PyFanOutcome {
        const outcome = resolver.resolveDispatch?.(call, ctx);
        if (outcome === undefined) return NO_FAN;
        if (outcome.kind === "ambiguous") {
          return { kind: "ambiguous", fan: [], fanSize: outcome.candidateCount, fanConfidence: null };
        }
        if (outcome.edges.length === 0) return NO_FAN;
        const fan = [...new Set(outcome.edges.map((e) => `${e.targetRelPath}#${e.targetSymbolId ?? ""}`))].sort();
        return {
          kind: "fan",
          fan,
          fanSize: fan.length,
          fanConfidence: outcome.edges[0]?.confidence ?? null,
        };
      }
      ```

- [ ] **Step 3 — `fanHitsOracle` in `buildRows`.** The oracle's in-project
      target is already computed there; the hit test reuses the SAME
      file-granularity degradation `buildRows` applies to a `pinUncertain`
      target, so a fan is not credited with a symbol match the 1:1 path would
      have refused.

      ```ts
      const oracleTarget =
        oracle.kind === "inProject"
          ? `${oracle.answer.targetRelPath}#${oracle.answer.targetSymbolId ?? ""}`
          : null;
      const fanHitsOracle =
        oracleTarget === null
          ? false
          : targets[0]?.pinUncertain === true
            ? site.fan.fan.some((entry) => entry.split("#")[0] === oracle.answer.targetRelPath)
            : site.fan.fan.includes(oracleTarget);
      ```

- [ ] **Step 4 — the fan tallies.** `tallyPyFan` folds rows by the same key
      function `tallyPyRows` uses, so every fan column can be printed per corpus
      and per `receiverKind` with no second grouping concept. Accounting, pinned
      by unit tests:

      - denominator `fanScored` = rows where the oracle has an in-project target
        AND `fan.kind !== "none"`. A row the fan never touched is not a fan
        result and is not in this denominator.
      - `recallAtFan` = `fanHits / fanScored`, where an `ambiguous` row counts as
        a MISS — the cap threw the answer away and that cost is the cap's.
      - `fanSizeMean` / `P50` / `P95` over `kind === "fan"` only. p95 uses the
        floor-index convention `sorted[min(floor(n*0.95), n-1)]`, matching
        `contracts/signal-utils.ts` so two percentiles in one repo do not mean
        two different things.
      - `ambiguousShare` = `ambiguous / (fan + ambiguous)`.
      - `precisionProxy` = `Σ (1 / fanSize)` over hitting `fan` rows, divided by
        `fanScored`. A 1-edge fan scores 1.0, a 10-edge fan 0.1.

- [ ] **Step 5 — print them apart, and print the cap.** The report gains a block
      that never shares a table with the 1:1 columns:

      ```text
      fan (dispatch layer) — NOT summed with the 1:1 columns above
        cap 16 (p99 defs-per-member 11) · fan 812 · ambiguous 44 · untouched 43,270
        recall@fan 0.71 (577/812) · size mean 2.4 p50 2 p95 6 · ambiguousShare 0.051
        precisionProxy 0.38
      ```

      `cap` and `p99DefsPerMember` come from
      `dispatchFanoutPolicyFor(symbolTable)` and are printed because the cap is
      corpus-adaptive: a moved cap changes `ambiguousShare` for reasons that have
      nothing to do with the increment being measured.

- [ ] **Step 6 — the identity gate.** `--no-dispatch` must reproduce Step 1's
      dumps byte-for-byte:

      ```bash
      ORACLE_MODULE=$PWD/scripts/py-codegraph-jedi-oracle.ts \
      DUMP_OUT=/tmp/e4/nodispatch-netbox.ndjson \
        npx tsx .../dump-rows.mts --corpus netbox --workers 8 --no-dispatch
      diff /tmp/e4/predispatch-netbox.ndjson /tmp/e4/nodispatch-netbox.ndjson
      ```

      Repeat for all five. Any difference means the fan pass leaked into the
      exact path and the task stops until it does not.

- [ ] **Step 7 — the tally learns the same trick.** `codegraph-chain-tally.ts`
      gains `--with-dispatch` (default off, so today's A/B numbers are unmoved)
      and, when on, counts `fan` / `ambiguous` / `fanEdges` beside the existing
      `dispatchSkipped`. `chainDrift` stays computed on the EXACT chain only —
      it exists to prove the rebuilt chain mirrors production, and folding a fan
      into it would make a real drift invisible.

- [ ] **Step 8 — `diff-rows` learns fan transitions.** The scratch differ at
      `/Users/artk0re/.claude/jobs/dffe3647/tmp/flask-lost/diff-rows.mjs` groups
      by verdict transitions; it gains one group keyed
      `${b.fanOutcome} -> ${a.fanOutcome}` and a `fanSize` delta histogram, so
      an E4.1 A/B can say "these 40 sites went `none` → `fan`" without a bespoke
      script. Copy it to `/tmp/e4/diff-rows.mjs` and edit there — it is a
      scratch driver, not a repo file.

- [ ] **Step 9 — record the parity finding.** Report, per corpus: how many sites
      the cone fires on TODAY (`fan.kind !== "none"` with zero code changes).
      That number is the oracle-vs-production gap this program has been
      carrying. If it is 0 everywhere, say so — it retroactively validates every
      published number, and it is a finding worth writing down.

**Gates.**

- `--no-dispatch` byte-identical to the pre-task dumps on all five corpora.
- `chainDrift` 0 on all five, with and without dispatch.
- Fan columns present per corpus and per receiverKind; `cap` and
  `p99DefsPerMember` printed for each corpus.
- `npm run test:coverage` green, with unit tests pinning: `ambiguous` counts as
  a recall@fan miss, `ambiguous` excluded from `fanSize*` and `precisionProxy`,
  p95 floor-index convention, `fanHitsOracle` degrading to file granularity on a
  `pinUncertain` target.
- Wall increase of the oracle run ≤ +25 % against Step 1 (the fan pass is one
  extra resolver call per site; more than that means something is rebuilding per
  call).
- Nothing under `src/` touched.

---

## Task E4.0.4 — Disagreement audit and family-attribution report

**Goal.** Produce the two documents E4.1–E4.6 are ordered by: a 100-row audit
saying how much of the phantom population is the ORACLE being wrong, and a
per-corpus family table with counts. Both are written into the spec's decision
record — D8 for the family table, a new subsection for the audit.

**Files.**

| file                              | verb | what                                                |
| --------------------------------- | ---- | --------------------------------------------------- |
| `scripts/py-e4-family-report.mts` | NEW  | family classification + the printed table           |
| spec `…-frontier-e4-design.md`    | MOD  | D8 filled in; audit results as a new decision entry |
| this plan                         | MOD  | Measurement record at close                         |

**Interfaces.**

```text
npx tsx scripts/py-e4-family-report.mts --rows /tmp/e4/final-<corpus>.ndjson \
  --corpus-root <abs path> [--verdict missed|phantom|all] [--json out.json]
```

### Steps — E4.0.4

- [ ] **Step 0 — worktree**, ff-merge `worktree-py-frontier-e4`, confirm E4.0.2
      and E4.0.3 are in the history.

- [ ] **Step 1 — the final tree, dumped twice.** All five corpora at the E4.0
      HEAD, `--oracle merged`, once with the standard exclusion and once with
      tests walked:

      ```bash
      for corpus in ugnest flask netbox polar httpx; do
        ORACLE_MODULE=$PWD/scripts/py-codegraph-jedi-oracle.ts \
        DUMP_OUT=/tmp/e4/final-$corpus.ndjson \
          npx tsx .../dump-rows.mts --corpus $corpus --workers 8 --oracle merged
        CODEGRAPH_EXCLUDE_TESTS=false \
        ORACLE_MODULE=$PWD/scripts/py-codegraph-jedi-oracle.ts \
        DUMP_OUT=/tmp/e4/final-tests-$corpus.ndjson \
          npx tsx .../dump-rows.mts --corpus $corpus --workers 8 --oracle merged
      done
      ```

      The tests-walked run is a SEPARATE population and never becomes the
      baseline: walking tests changes the symbol table and therefore every
      short-name ambiguity computation, not just the fixture family.

- [ ] **Step 2 — the classifier.** Two tiers, kept apart on purpose: a family
      decidable from the dump row alone, and one needing the caller's source
      line. Mixing them hides which counts are cheap and which are judgement.

      ```ts
      // scripts/py-e4-family-report.mts
      /**
       * Family attribution over an oracle row dump (bd tea-rags-mcp-w205u,
       * E4.0.4). Same method as seam 5 decision 1 and E3 decision 1: bucket every
       * row by the mechanism that WOULD have answered it. Counts are ROWS — a
       * site in two overlapping chunks is emitted twice, which is what every rate
       * the oracle prints is computed over.
       */
      import { readFileSync } from "node:fs";
      import { join } from "node:path";

      interface Row {
        relPath: string; startLine: number; callText: string;
        receiver: string | null; member: string; receiverKind: string;
        verdict: string; answeredBy: string; missBucket: string;
        oracleTargetRelPath: string | null; fanOutcome?: string; fanSize?: number;
      }

      const WRAPPERS = ["Mapped", "Annotated", "ClassVar", "Final", "Required", "NotRequired"];
      const SQLALCHEMY_RECEIVERS = ["session", "self.session", "stmt", "statement", "query"];
      const PYDANTIC_MEMBERS = ["model_validate", "model_validate_json", "model_dump", "model_dump_json", "model_copy"];
      const CELERY_MEMBERS = ["delay", "apply_async"];
      const DRF_MEMBERS = ["get_serializer", "get_object", "get_queryset", "get_serializer_class"];

      /** Tier 1: decidable from the row. Returns every family that fires. */
      function familiesFromRow(row: Row): string[] {
        const found: string[] = [];
        const receiver = row.receiver ?? "";
        if (PYDANTIC_MEMBERS.includes(row.member)) found.push("pydanticRow");
        if (CELERY_MEMBERS.includes(row.member)) found.push("celeryEnqueue");
        if (DRF_MEMBERS.includes(row.member) && receiver === "self") found.push("drfViewAttr");
        if (receiver === "self.request" || row.callText.startsWith("self.request.")) found.push("drfViewAttr");
        if (SQLALCHEMY_RECEIVERS.includes(receiver) || /^select\(/.test(row.callText)) found.push("sqlalchemyRow");
        if (/^await\s|\(await\s/.test(row.callText)) found.push("asyncForm");
        if (row.callText.includes("asyncio.gather(")) found.push("asyncForm");
        if (/^[A-Z][A-Za-z0-9_]*\(.*\)\./.test(row.callText)) found.push("constructorChainHead");
        if (row.receiverKind === "bareCall" && row.oracleTargetRelPath === row.relPath) {
          found.push("sameFileBareCall");
        }
        if (/\/urls?(_[a-z]+)?\.py$/.test(row.relPath) && /^(path|re_path)\(/.test(row.callText)) {
          found.push("djangoUrlRoute");
        }
        if (row.member === "as_view") found.push("djangoUrlRoute");
        if (/^getattr\(/.test(row.callText) || row.member === "__getattr__") found.push("runtimeOnly");
        return found;
      }
      ```

- [ ] **Step 3 — tier 2, the source-line read.** Four families cannot be seen in
      the row and need the binding site: `unionBranchReceiver`,
      `protocolReceiver`, `transparentWrapper`, `typeVarGeneric`,
      `untypedFieldHop`. The classifier reads the caller file ONCE per file
      (memoised), scans backwards from `startLine` for the nearest binding or
      annotation of the receiver's head name, and matches:

      | family                | pattern on the binding / annotation line                         |
      | --------------------- | ---------------------------------------------------------------- |
      | `unionBranchReceiver` | `= X(...) if ... else Y(...)`, or an annotation containing ` \| ` or `Optional[` |
      | `transparentWrapper`  | annotation whose head is in `WRAPPERS`                            |
      | `protocolReceiver`    | annotation naming a class the symbol table shows subclassing `Protocol` |
      | `typeVarGeneric`      | enclosing `def` whose return annotation is a name bound by `TypeVar(` in the file, or `Self` |
      | `untypedFieldHop`     | dotted receiver whose head resolves to a `self.<attr>` with NO annotation anywhere |

      A row matching none is `residual`, and `residual` is REPORTED, not hidden.
      A backwards scan is a heuristic, so the report prints its own miss rate:
      how many rows found no binding line at all.

- [ ] **Step 4 — sanity-check the classifier against known ground truth.** Run
      it against the E3 residuals, which were bucketed by hand: netbox `chain` 7
      rows (4 `constructorChainHead`), netbox `localVar` 50 (module alias
      heads), polar `chain` 75 (71 `untypedFieldHop`), polar `bareCall` 103
      (`prompt_setup` — `sameFileBareCall`). If the classifier disagrees with
      the hand count by more than ~10 %, fix the classifier, not the hand count:
      those numbers were produced by opening the files.

- [ ] **Step 5 — the audit, 100 rows.** Sample `phantom` and `wrongFile` rows
      with `samplePyRows` at seed `20260910`, stratified across corpora in
      proportion to each corpus's `phantom + wrongFile` count, with flask
      over-sampled to all 10 of its rows because n is small and its 2.82 % is
      the only rate above the bar. For each row: open
      `<corpusRoot>/<relPath>:<startLine>`, read the binding site, then ask the
      second engine the same site (`--oracle lsp`) as a tiebreaker, and classify
      into exactly one of `chainWrong`, `oracleWrongMro`,
      `oracleWrongSingleton`, `oracleWrongCache`, `bothWrong`, `undecidable`.

      The engines agreeing against the chain is `chainWrong` with high
      confidence; the engines disagreeing goes to the manual reading, and the
      reading wins. Record the sample list (corpus, relPath, startLine) in the
      spec so the classification is auditable by someone else.

- [ ] **Step 6 — `precisionMissAdjusted`.** Per corpus,
      `(phantom + wrongFile − oracleWrong*) / edges`, printed BESIDE the raw
      rate and never instead of it. If flask lands under 2 % adjusted, that is a
      finding about the instrument; the raw 2.82 % stays in the spec's ceiling
      map either way.

- [ ] **Step 7 — write D8, and the ordering.** The family table, per corpus,
      with `missed` counts for recall families and `edgesGained` for the
      zero-recall ones (SQLAlchemy / pydantic — E3 measured 2,550 and 223 polar
      rows with **0 `missed`**), plus the fan columns per family from E4.0.3.
      Then the execution order, applying the spec's two overrides: a family with
      no recall mass never outranks one with it, and E4.1's Ruby-narrower
      relocation may be pulled forward because its cost is bounded by a parity
      gate. Write it into the spec's D8 as the table, and state plainly that
      THAT table is the execution order.

- [ ] **Step 8 — the pytest delta.** From the paired dumps of Step 1, report the
      `pytestFixture` family as a delta between the two populations, with a note
      on how much everything ELSE moved when tests were walked. If the
      collateral movement is large, say so — it is the cost of that family's
      fix, and E4.3 needs it before it commits.

**Gates.**

- Classifier agrees with E3's hand-bucketed residuals within ~10 % on the four
  known buckets; disagreements are explained, not averaged away.
- Every one of the 100 audit rows carries a class and a one-line reason; the
  sample list is in the spec.
- D8 is written with counts, and the ordering overrides are applied explicitly.
- Both denominators and the fan columns appear in the report; `residual` and the
  classifier's own binding-line miss rate are printed.
- `npm run test:coverage` green. Nothing under `src/` touched.

---

## Task order, and what each one unblocks

```text
E4.0.1 SPIKE ──► E4.0.2 host integration ──┐
                                            ├──► E4.0.4 audit + family report ──► E4.1…E4.6
E4.0.3 fan scoring ─────────────────────────┘
```

E4.0.1 → E4.0.2 is a hard dependency: D7 names the engine. E4.0.3 is independent
of both and may run in parallel — it touches the fan columns, they touch the
oracle columns, and the only shared file is `scripts/lib/py-oracle-core.ts`, so
whichever lands second rebases and re-runs its own identity gate. E4.0.4 needs
both, because the family table carries fan columns and the audit uses the second
engine as tiebreaker.

Forecast, anchored on the E0 measurement sub-epic (the closest historical work:
same harnesses, same corpora, same measure-fix-measure loop). E4.0 is a sub-epic
of four tasks with one novel component (an LSP-driven oracle) and a large
substrate discount — the walk, the protocol, the verdict lattice, the sampler
and the dump drivers all exist. Corpus runs dominate the wall: polar's jedi pass
alone is 15–40 min and several steps run it twice.

|     | burst days | calendar  |
| --- | ---------- | --------- |
| P25 | 3.0        | 1 week    |
| P50 | 4.0        | 1.5 weeks |
| P75 | 5.5        | 2 weeks   |

The spread's upper half is almost entirely E4.0.1: if both engines fail the
determinism gate, the task ends in a "neither" decision that is cheap, but if
one nearly passes, the debugging is open-ended. Cap it — two burst days on the
spike, then decide with what has been measured.

---

## Measurement record — to be written at close

Filled in by the task that closes E4.0, in the shape E3's record uses:

- Per corpus and per receiverKind: `recallLegacy` / `nLegacy` beside
  `recallMerged` / `nMerged`, with the E3 closing numbers quoted for comparison
  on the legacy column.
- Fan block per corpus: `cap`, `p99DefsPerMember`, fan / ambiguous / untouched
  counts, `recallAtFan`, size mean / p50 / p95, `ambiguousShare`,
  `precisionProxy`.
- Precision: raw `(phantom + wrongFile) / edges` and `precisionMissAdjusted`
  side by side, per corpus.
- The audit's six classes with counts, and the sample list.
- The family table, per corpus, and the execution order it produces.
- Wall and peak RSS for each harness mode, so the next increment knows what a
  full measurement costs.
- Determinism evidence: the two-run diff output for the merged oracle.

---

## What this plan does NOT claim

- It does not improve recall. Not one resolver, walker or strategy file is
  edited; every number this plan produces describes the tree as E3 left it.
- It does not claim the merged denominator is comparable to the legacy one. They
  are printed side by side and never subtracted from each other.
- It does not claim the second engine is more correct than jedi. It claims the
  second engine can READ files jedi cannot, and the agreement sample is what
  bounds the rest.
- It does not decide E4.1's design. It produces the counts E4.1's design will be
  argued from, and D8 is where that argument gets recorded.
- It does not ship a fan-out. E4.0.3 SCORES the dispatch layer as it stands
  today; Python still has one cone component and no union, dynamic or protocol
  component until E4.1.
- It does not touch Ruby, and it does not touch production. `git diff` under
  `src/` is empty at every task's close, which is one of the gates.
- It does not settle whether production should walk test files. It measures what
  walking them would cost and hands that to the tests-tier bead.
- It does not re-run live validation. Live validation is user-gated, and nothing
  here changes what an index contains.
