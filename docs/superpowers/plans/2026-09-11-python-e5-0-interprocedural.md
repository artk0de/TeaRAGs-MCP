# Python E5.0 — Inter-Procedural Measurement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the measurement that decides whether inter-procedural parameter
typing is worth building for Python, and ship the oracle-debt correction the E4
increments are waiting on. Two tasks execute (E5.0a, E5.0b); two more (E5.1,
E5.2) are specified in full and **GATED SHUT** by E5.0a's own number, which a
prototype run has already read at **5 rows against a bar of 100**. A gated task
is not deleted: E5.0a is re-runnable on any corpus, and a corpus that clears the
bar re-opens E5.1 without a redesign.

**Architecture:** Four moves, none of them a resolver change. (1) A binding
classifier, `scripts/lib/py-receiver-binding.ts`, answers ONE question per
residual row — what statement bound this receiver name — over a fixed 14-value
vocabulary, with `unbound` reported rather than hidden. It is the same two-tier
discipline as `scripts/lib/py-residual-families.ts`, one level finer, and it
shares that file's `PyResidualSourceView` port so both classifiers read a corpus
through one interface. (2) An agreement report,
`scripts/py-e5-interprocedural-report.ts`, takes the rows the classifier calls
`paramUnannotated` (plus two sibling buckets read off the row shape), opens
every call site of the owning `def`, types the argument bound to the parameter
from facts that already exist, and prints the exact/LUB/disagree table plus the
numeric go/no-go. (3) A re-scoring pass, `scripts/py-e5-oracle-debt.ts`, selects
rows in the three named oracle-wrong classes by pure predicates over dump fields
and emits `recallDebtAdjusted` BESIDE `recallMerged`, never in place of it. (4)
Gated: three Python walker passes that fill the producer channels the already-
built barrier fold at
`src/core/domains/trajectory/codegraph/symbols/call-arg-param-types.ts`
consumes.

**Tech Stack:** TypeScript (NodeNext, `strict`), vitest, tsx for the corpus
harnesses. No new dependency, no schema migration, no walker-version bump for
E5.0a/E5.0b — they are `scripts/` only. E5.1, if the gate ever opens, rides
walker version 5 exactly as E4.6 does (5 is unreleased on this branch).

**Spec:**
`docs/superpowers/specs/2026-09-11-python-interprocedural-e5-design.md` — E5.0 A
(the binding vocabulary and the attribution table), E5.0 A2 (the agreement
tables and the go/no-go), E5.0 B (why the debt correction is a re-scoring pass
and not a merge-rule change), E5.1 (the engine that already exists and the three
producer gaps), and D1–D8. Upstream: the E4 spec
`docs/superpowers/specs/2026-09-10-python-frontier-e4-design.md` — D8 (family
attribution), D9 (`OW:*` classes incl. `oracleWrongSelf`), D10 (the falsified
name-only dispatch), and the per-FILE merge rule. Format and gate protocol are
inherited verbatim from
`docs/superpowers/plans/2026-09-10-python-e4-6-typed-residuals.md`.

---

## Decision record

### 1 — The attribution, measured (prototype run 2026-09-11, `/tmp/e5attr`, dumps `~/.claude/jobs/dffe3647/tmp/e46b1/after-*.ndjson`)

Every residual row (`missed | fileOnly | wrongFile | skippedInProject`) whose
receiver is an undotted identifier and whose `receiverKind` is `dynamic`,
`localVar` or `selfMember` — 336 rows over five corpora — was classified by the
statement that BOUND the receiver name inside the enclosing `def`.

| binding                                    | ugnest | flask | httpx | netbox | polar   | total   |
| ------------------------------------------ | ------ | ----- | ----- | ------ | ------- | ------- |
| `assignCallProject`                        | 0      | 1     | 0     | 7      | **135** | **143** |
| `unbound`                                  | 1      | 11    | 0     | 18     | 26      | 56      |
| `paramAnnotated`                           | 0      | 0     | 0     | 0      | **50**  | **50**  |
| `loopTarget`                               | 0      | 1     | 5     | 5      | 19      | 30      |
| `assignAlias`                              | 0      | 4     | 0     | 0      | 20      | 24      |
| `assignCallExternal`                       | 2      | 3     | 0     | 1      | 7       | 13      |
| `tupleUnpack`                              | 0      | 1     | 0     | 1      | 4       | 6       |
| **`paramUnannotated`**                     | **0**  | **1** | **0** | **4**  | **0**   | **5**   |
| `assignOther`                              | 0      | 0     | 0     | 0      | 4       | 4       |
| `walrus`                                   | 0      | 0     | 0     | 4      | 0       | 4       |
| `exceptAs`                                 | 0      | 0     | 0     | 0      | 1       | 1       |
| `comprehension` / `withAs` / `moduleLevel` | 0      | 0     | 0     | 0      | 0       | 0       |
| **total**                                  | 3      | 22    | 5     | 40     | 266     | **336** |

`self` and `cls` are NOT parameters here (spec D7). The first prototype run
counted them and scored polar's `paramUnannotated` at 10, every row a `cls`
receiver in a `@classmethod` — E4.4's family, not E5's.

### 2 — The agreement tables, and the go/no-go

Per owning `def`: every occurrence of its name in the corpus is opened, the
argument bound to the parameter is extracted (kwarg first, then positional with
the `self`/`cls` slot removed), and the argument expression is typed from
existing facts. Verdicts: `exact` (one distinct type over ≥1 determinable site),
`lub` (>1 type sharing an MRO ancestor), `disagree`, `noDeterminable`,
`noCallSites`. `resolvable` counts ROWS under `exact`/`lub` whose `member` is
declared on the agreed class or an ancestor.

**Bucket A — receiver is an unannotated parameter**

| corpus | rows  | defs | exact | lub   | disagree | noDeterminable | noCallSites | **resolvable** |
| ------ | ----- | ---- | ----- | ----- | -------- | -------------- | ----------- | -------------- |
| ugnest | 0     | 0    | 0     | 0     | 0        | 0              | 0           | 0              |
| flask  | 1     | 1    | 1     | 0     | 0        | 0              | 0           | **1**          |
| httpx  | 0     | 0    | 0     | 0     | 0        | 0              | 0           | 0              |
| netbox | 4     | 3    | 1     | 0     | 0        | 3              | 0           | **1**          |
| polar  | 0     | 0    | 0     | 0     | 0        | 0              | 0           | 0              |
| total  | **5** | 4    | **2** | **0** | 0        | 3              | 0           | **2**          |

**Bucket D — parameter-bound callables (`def run(cb): cb()`)**

| corpus | rows  | defs | exact | lub   | disagree | noDeterminable | **resolvable** |
| ------ | ----- | ---- | ----- | ----- | -------- | -------------- | -------------- |
| ugnest | 1     | 1    | 0     | 0     | 1        | 0              | 0              |
| flask  | 0     | 0    | 0     | 0     | 0        | 0              | 0              |
| httpx  | 0     | 0    | 0     | 0     | 0        | 0              | 0              |
| netbox | 2     | 2    | 0     | 0     | 1        | 1              | 0              |
| polar  | 3     | 3    | **3** | 0     | 0        | 0              | **3**          |
| total  | **6** | 6    | **3** | **0** | 2        | 1              | **3**          |

**Bucket E — `self.f = <unannotated parameter>`**

| corpus | rows  | defs | exact | noDeterminable | **resolvable** |
| ------ | ----- | ---- | ----- | -------------- | -------------- |
| netbox | 1     | 1    | 0     | 1              | 0              |
| others | 0     | 0    | 0     | 0              | 0              |
| total  | **1** | 1    | **0** | 1              | **0**          |

The brief's "27" for bucket E is a misread: the E4.6 plan
(`2026-09-10-python-e4-6-typed-residuals.md:241`) measures `self.f = param` at
**1 row corpus-wide** and marks it `out`; 27 is the whole `untypedFieldHop`
declined remainder (line 351). This re-measurement reproduces the 1.

|                                         | exact | LUB   |
| --------------------------------------- | ----- | ----- |
| rows unlocked, all buckets, all corpora | **5** | **5** |
| bar                                     | 100   | 100   |

**NO-GO.** Per corpus, all of E5.1 + E5.2 would be polar +3, netbox +1, flask
+1, httpx 0, ugnest 0. LUB buys zero: no `def` produced a `lub` verdict, because
the determinable-site counts are 1–2 and one witness cannot disagree with
itself. Tasks E5.1 and E5.2 therefore do not execute; step 0 of each is a gate
check that stops them.

### 3 — The engine E5.1 would have built already exists, and it is not in the kernel

`src/core/domains/trajectory/codegraph/symbols/call-arg-param-types.ts` (186
lines, bd `tea-rags-mcp-bvalc`, "Interprocedural PARAMETER typing at the
pass-1→pass-2 barrier, Increment 1") already implements the mechanism, already
agreement-only, already consumed through `localBindings`. Four exports:
`foldKnownTargetParamTypes`, `deriveClassFieldTypesFromParams`,
`seedParamLocalBindings`, `mergeDerivedClassFieldTypes`. `RubyTypeRef` is a
plain alias of `TypeRef` (`contracts/types/language.ts:716`), so there is no
Ruby type in its signatures and **no relocation is needed** — the relocation
protocol does not apply. What is Ruby-specific is the PRODUCER
(`ruby/walker/type-channels.ts:63-66`). E5.1 is a Python producer, not an
engine.

### 4 — Pass and barrier, backed by the runner

The fold runs at the **pass-1→pass-2 barrier**, `run-state.ts:937-940`, and
there is **no worklist fixpoint**. Pass 1 (`RunState#absorb`,
`run-state.ts:1347-1354`) merges each file's `knownTargetCallArgs`, `paramNames`
and `classFieldParamLinks` as files stream in; the barrier folds once, before a
single call is resolved; pass 2 (`CallEdgeResolutionRunner`) reads the product
per chunk via `seedParamLocalBindings` (`resolution-runner.ts:351`). It can do
this because the fold reads ONLY call sites whose callee is known from SYNTAX
and needs no resolution — `Cls(...)` targets `Cls#__init__` however the rest of
the program resolves. Determinism is structural: the input is a merged set,
disagreement collapses to silence, and no output depends on iteration order.

There is NO run-global call-site table, and E5 must not add one. Pass 2 reads
calls per file from `extraction.chunks[].calls`
(`resolution-runner.ts:346,356`); the run-global maps sealed at the barrier are
declaration-shaped (ancestry, hierarchy view, self-dispatch templates) plus the
type-inference family listed above.

### 5 — Persistence: batch-scoped, and that is measured, not assumed

`contracts/types/codegraph-pass1.ts:117` records the ablation from
`scripts/spikes/ruby-incremental-runglobal-delta.ts` on taxdome (9,945 attempted
calls, 250 files): an incremental run loses 168 edges; persisting
`structuredReturnTypes` + `functionReturnTypes` recovers 131; **the whole param
family — `paramNames`, `paramTypes`, `classFieldParamLinks`,
`derivedClassFieldTypes` — recovers exactly ZERO.** They stay unpersisted on
purpose. The reasoning transfers unchanged to Python: a derived param type only
ever SEEDS a binding the walker left empty, so a batch that cannot see a def's
other call sites produces silence rather than a wrong answer. E5 changes nothing
here and adds no persisted column.

### 6 — Oracle debt is corrected downstream, and one dump field blocks it

The debt, recall side, is 57 rows: `cls(...)` constructor **32** (E4.4 decision
3 — both engines answer the enclosing classmethod because `cls` is a parameter
whose definition line IS the `def` line), `OW:Self` **14** (polar), `OW:Mro`
**11** (netbox). D9's `OW:EnumClassmethod` 18 and `OW:ShadowedPackage` 8 are
phantom-side and already subtracted from `precisionMissAdjusted`; E5.0b
re-scores them only to prove it reproduces D9 on a class it did not change.

The merge rule stays per FILE. jedi holds a per-process module cache and
`jedi_oracle.py:539` stripes files across workers with `maxtasksperchild=1`
because `imap(chunksize=4)` moved a flask site between `external` and `unknown`
run to run; mixing engines within a file puts two module resolutions behind one
`jedi.Script` cache. A per-CLASS-of-site override is exactly the tiebreak the E4
spec forbids. So the correction is a pass over DUMPS that emits
`recallDebtAdjusted` beside `recallMerged`.

**Blocking precondition.** `PyResidualRow` declares `oracleTargetRelPath` and
`oracleTargetSymbolId` (`scripts/lib/py-residual-families.ts:36-37`) and the
e46b1 dumps carry NEITHER. The damage is visible: re-running
`scripts/py-e4-family-report.ts` over `after-polar.ndjson` splits polar's bare
calls `sameFileBareCall` 0 / `crossFileBareCall` 110, where D8 recorded 140 / 31
across the corpora — the same-file test compares `row.oracleTargetRelPath`
against `undefined` on every row. E5.0b step 1 emits the two fields.

**Cleared 2026-09-11** (step 1, `w205u`). Post-fix dumps read polar 87 / 23 and
flask 5 / 0; D8's split stands and its polar `crossFileBareCall` column
reproduces exactly. See step 1's measurement block.

### 7 — What the mass actually is, and who owns it

Read as an ordering over the same 336 rows: `assignCallProject` **143** (E4.6b's
call-result fold, ACROSS CHUNKS — 135 polar rows whose head is a `-> Self`
classmethod, the `from_session` shape D9's `OW:Self` describes); `unbound` 56
(mostly `cls` ⇒ E4.4, 32 of them oracle debt); `paramAnnotated` 50 (a NARROWING
failure — union / generic heads — E4.1.4's deferred `union` arm and E4.4's
`typeVarGeneric`); `loopTarget` 30 (container element type, E4.5, which D8
scored at 4 because it counted subscript receivers and not iteration targets);
`assignAlias` 24; `assignCallExternal` 13; the rest 15.

The next increment after E4.6 should be the cross-chunk call-result fold, not
this one. That is an attribution and not a forecast — nothing here authorises a
claim about its yield.

---

## Global Constraints

Every task obeys all of these. A task that cannot is a task that stops and
reports, not one that improvises.

- **One fresh Opus executor per task.** Step 0 of every task: create an agent
  worktree and `git merge --ff-only` `<E5 branch>` into it. `<E5 branch>` is
  `worktree-py-frontier-e5` if the orchestrator has cut one, otherwise
  `worktree-py-frontier-e4` — the task's step 0 reads which exists and says
  which it took. Never edit the shared checkout.
- **Tool calls ≤ 8 minutes.** A corpus walk over polar or netbox fits; an oracle
  run does not. No task in this plan runs the jedi or LSP oracle over a whole
  corpus. E5.0b's per-site pyright quotes are ≤ 60 sites, driven directly on a
  site list.
- **Writes ≤ 120 lines per Write/Edit call.** Longer files are appended in
  chunks.
- **Existing tests are never rewritten.** Moving a test is fine; changing what
  it asserts is not. If a change makes an existing assertion false, the change
  is wrong until proven otherwise in the task report.
- **Ruby stays byte-identical.** No task here touches `ruby/`, and E5.1's gate
  includes a Ruby parity run.
- **No reindex, no `npm link`, no build-and-link.** These tasks are `scripts/`
  and (gated) walker code. A bare `npm run build` is allowed when a worktree has
  no `build/`; the global link is never moved.
- **`bd` is not run by any task.** Bead ids in commit subjects are the literal
  placeholder `(e5)`, `(e5).1`, `(e5).2`, `(e5).3`, `(e5).4`; the orchestrator
  substitutes real ids.
- **Commits.** `type(scope): subject (<bead>)` — e.g.
  `feat(scripts): classify residual receiver bindings ((e5).1)`. Subject ≤ 100
  chars. Sole trailer:
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Nothing else in
  the footer.
- **Every number in a task report carries its command.** A report that states a
  count without the invocation that produced it is not accepted.

---

## File Structure

```text
scripts/
  lib/
    py-receiver-binding.ts          NEW  (E5.0a)  binding classifier + vocabulary
    py-residual-families.ts         READ ONLY     shares PyResidualSourceView
  py-e5-interprocedural-report.ts   NEW  (E5.0a)  agreement tables + go/no-go
  py-e5-oracle-debt.ts              NEW  (E5.0b)  re-scoring pass
  py-e4-family-report.ts            EDIT (E5.0b)  emit oracleTarget* in the dump
  lib/py-oracle-core.ts             EDIT (E5.0b)  carry oracleTarget* on the row
tests/scripts/
  py-receiver-binding.test.ts       NEW  (E5.0a)
  py-e5-oracle-debt.test.ts         NEW  (E5.0b)
src/core/domains/language/python/walker/passes/
  python-def-signatures.ts          EDIT (E5.1, GATED)  fill paramNames
  python-known-target-args.ts       NEW  (E5.1, GATED)
  python-class-field-params.ts      NEW  (E5.1, GATED)
docs/superpowers/plans/
  2026-09-11-python-e5-0-interprocedural.md   this file (E5-close appends the record)
```

Nothing under `src/core/domains/trajectory/` is edited by any task. The barrier
fold is used as-is.

---

## Context the implementer needs

Read this section before Task E5.0a. It is the exact shape of every fact,
channel and port the tasks touch, so no task has to go looking.

### The dump row

One NDJSON line per residual site, produced by the E4 harness. Fields the tasks
read, verbatim from `~/.claude/jobs/dffe3647/tmp/e46b1/after-polar.ndjson`:

```jsonc
{
  "relPath": "server/polar/backoffice/organizations_v2/endpoints.py",
  "startLine": 871, // 1-BASED
  "callText": "review_repo.get_latest_agent_review(organization_id)",
  "receiver": "review_repo", // null for a bare call
  "member": "get_latest_agent_review",
  "receiverKind": "dynamic", // chain|localVar|dynamic|bareCall|super|constant|selfMember|index
  "categories": ["annotationReturn"],
  "verdict": "missed", // match|missed|fileOnly|wrongFile|phantom|skippedInProject
  "answeredBy": "none",
  "chainOutput": "none",
  "origin": "project",
  "oracleDegraded": false,
  "oracleEngine": "jedi", // jedi|lsp
  "dispatch": {
    "kind": "none",
    "fan": [],
    "fanSize": 0,
    "fanConfidence": null,
    "single": null,
    "hitsOracle": false,
    "oracleInProject": true,
  },
  "chain": {
    "targetRelPath": "…",
    "targetSymbolId": "CustomerRepository#update",
  }, // optional
  "legacy": {
    /* the pre-merge-oracle row, same shape */
  }, // optional
  "exactVerdict": "match",
  "exactChainOutput": "pinned", // optional
}
```

`oracleTargetRelPath` / `oracleTargetSymbolId` are DECLARED by `PyResidualRow`
and ABSENT from these dumps. E5.0b adds them; E5.0a must not depend on them.

### `PyResidualSourceView` — the port both classifiers read a corpus through

Declared at `scripts/lib/py-residual-families.ts:39-63`. E5.0a extends it rather
than inventing a second port:

```ts
export interface PyResidualSourceView {
  importBindings: (relPath: string) => ReadonlySet<string>;
  bindingLine: (relPath: string, line: number, name: string) => string | null;
  typeVarNames: (relPath: string) => ReadonlySet<string>;
  enclosingReturnAnnotation: (relPath: string, line: number) => string | null;
  enclosingDefParams: (relPath: string, line: number) => ReadonlySet<string>;
  isProtocolClass: (className: string) => boolean;
  isProjectFixture: (name: string) => boolean;
}
```

`scripts/py-e4-family-report.ts:91-118` builds it with one memoised read per
file. E5.0a's report reuses `buildSourceView` and adds three methods behind a
separate interface (`PyBindingSourceView`, below) so the existing one is
untouched.

### The corpus roots

`scripts/lib/codegraph-corpora.json`, `~` unexpanded. ugnest
`~/Dev/Collaborate/ugnest`; flask `~/Dev/OpenSource/codegraph-test/flask`;
netbox / polar / httpx `~/Dev/Tools/tea-rags-bench/corpora/<name>`. Passing the
wrong root is not an error, it is a silent zero on every tier-2 read — the E4.6
plan's decision 1 records exactly that bug costing flask's whole attribution.

### The barrier fold (E5.1 only, gated)

`src/core/domains/trajectory/codegraph/symbols/call-arg-param-types.ts`:

```ts
export type KnownTargetParamTypes = Record<string, Record<string, RubyTypeRef>>;
export function foldKnownTargetParamTypes(
  records: Iterable<KnownTargetCallArgs>,
  paramNamesBySymbolId: Readonly<Record<string, readonly string[]>>,
): KnownTargetParamTypes;
export function deriveClassFieldTypesFromParams(
  links: Readonly<
    Record<string, Readonly<Record<string, ClassFieldParamLink>>>
  >,
  paramTypes: KnownTargetParamTypes,
  declaredFields: ReadonlySet<string>,
): Record<string, Record<string, string>>;
```

Producer channels, all `contracts/types/codegraph-extraction.ts`:

```ts
interface KnownTargetCallArgs {
  readonly targets: readonly string[]; // "Fq::Type#initialize" / "Fq::Type.build", innermost scope first
  readonly argTypes: readonly (TypeRef | null)[]; // null = absent evidence, no vote, no veto
} // truncated at the first splat/kwarg
interface ClassFieldParamLink {
  readonly method: string;
  readonly param: string;
}
// FileExtraction.knownTargetCallArgs?: KnownTargetCallArgs[]        (:266)
// FileExtraction.classFieldParamLinks?: Record<string, Record<string, ClassFieldParamLink>>  (:282)
// ChunkExtraction.paramNames?: string[]                             (:482)
```

Python fills NONE of the three today —
`python/walker/passes/python-def-signatures.ts:36` states that `paramNames` is
deliberately unfilled.

---

## Task E5.0a — receiver-binding attribution and the agreement tables

**Files**

- NEW `scripts/lib/py-receiver-binding.ts`
- NEW `scripts/py-e5-interprocedural-report.ts`
- NEW `tests/scripts/py-receiver-binding.test.ts`

**Interfaces**

```ts
export const PY_RECEIVER_BINDINGS = [
  "paramUnannotated",
  "paramAnnotated",
  "loopTarget",
  "comprehension",
  "tupleUnpack",
  "walrus",
  "exceptAs",
  "withAs",
  "assignCallProject",
  "assignCallExternal",
  "assignAlias",
  "assignOther",
  "moduleLevel",
  "unbound",
] as const;
export type PyReceiverBinding = (typeof PY_RECEIVER_BINDINGS)[number];

export interface PyBindingSourceView {
  /** Source lines of a file, `[]` when unreadable. */
  linesOf: (relPath: string) => readonly string[];
  /** Is this short name a class declared anywhere in the corpus? */
  isProjectClass: (name: string) => boolean;
  /** Is this short name a `def` declared anywhere in the corpus? */
  isProjectDef: (name: string) => boolean;
}

export interface PyBindingAttribution {
  binding: PyReceiverBinding;
  /** The binding statement's own text, trimmed to 60 chars. `""` for `unbound`. */
  detail: string;
  /** The enclosing def's 0-based line, `null` when the row is at module scope. */
  defLine: number | null;
}

export function classifyReceiverBinding(
  row: {
    relPath: string;
    startLine: number;
    receiver: string | null;
    receiverKind: string;
  },
  view: PyBindingSourceView,
): PyBindingAttribution;

export function enclosingPythonDef(
  src: readonly string[],
  callLine1: number,
): { line: number; name: string; params: PyParam[]; isMethod: boolean } | null;

export interface PyParam {
  name: string;
  annotated: boolean;
  annotation: string | null;
}
```

**Steps**

- [ ] **0. Worktree.** Create an agent worktree. Determine `<E5 branch>`:
      `git rev-parse --verify worktree-py-frontier-e5` — if it resolves, that is
      the branch; otherwise `worktree-py-frontier-e4`. Then
      `git merge --ff-only <E5 branch>`. State in the report which branch was
      taken and its SHA. If the ff-merge is not a fast-forward, STOP and report.

- [ ] **1. RED — pin the two failure modes and the vocabulary.** Write
      `tests/scripts/py-receiver-binding.test.ts`. It must fail before step 2
      exists. Every case hands `classifyReceiverBinding` a literal source array
      through a stub view — no corpus, no disk.

      ```ts
      import { describe, expect, it } from "vitest";
      import { classifyReceiverBinding, enclosingPythonDef } from "../../scripts/lib/py-receiver-binding.js";

      const view = (src: string[], classes: string[] = [], defs: string[] = []) => ({
        linesOf: () => src,
        isProjectClass: (n: string) => classes.includes(n),
        isProjectDef: (n: string) => defs.includes(n),
      });
      const row = (line: number, receiver: string) => ({
        relPath: "a.py", startLine: line, receiver, receiverKind: "dynamic",
      });

      describe("classifyReceiverBinding", () => {
        it("calls an unannotated parameter a parameter", () => {
          const src = ["def f(x):", "    x.m()"];
          expect(classifyReceiverBinding(row(2, "x"), view(src)).binding).toBe("paramUnannotated");
        });

        it("keeps an annotated parameter apart from an unannotated one", () => {
          const src = ["def f(x: Foo):", "    x.m()"];
          expect(classifyReceiverBinding(row(2, "x"), view(src)).binding).toBe("paramAnnotated");
        });

        // spec D7 — self/cls are E4.4's class-object family, never parameters.
        it("does not call cls a parameter", () => {
          const src = ["class C:", "    @classmethod", "    def f(cls):", "        cls.m()"];
          expect(classifyReceiverBinding(row(4, "cls"), view(src)).binding).not.toBe("paramUnannotated");
        });

        // The prototype's enclosing-def scan updated its indent watermark on any
        // dedented line, so a flush-left comment orphaned every row below it:
        // 346 of polar's 548 read "no enclosing def" before the fix, 0 after.
        it("finds the enclosing def past a flush-left comment", () => {
          const src = ["def f(x):", "    y = 1", "# note", "    x.m()"];
          expect(enclosingPythonDef(src, 4)?.name).toBe("f");
          expect(classifyReceiverBinding(row(4, "x"), view(src)).binding).toBe("paramUnannotated");
        });

        it("separates an in-project call result from an external one", () => {
          const src = ["def f():", "    r = Repo.from_session(s)", "    r.m()"];
          expect(classifyReceiverBinding(row(3, "r"), view(src, ["Repo"])).binding).toBe("assignCallProject");
          expect(classifyReceiverBinding(row(3, "r"), view(src)).binding).toBe("assignCallExternal");
        });

        it("reads a loop target as a loop target and a walrus as a walrus", () => {
          expect(classifyReceiverBinding(row(2, "a"), view(["def f(xs):", "    for a in xs:"])).binding).toBe("loopTarget");
          expect(classifyReceiverBinding(row(2, "a"), view(["def f():", "    if (a := g()):"])).binding).toBe("walrus");
        });

        it("reports unbound rather than guessing", () => {
          expect(classifyReceiverBinding(row(2, "z"), view(["def f():", "    z.m()"])).binding).toBe("unbound");
        });
      });
      ```

      Run `npx vitest run tests/scripts/py-receiver-binding.test.ts` and record
      that it fails on a missing module.

- [ ] **2. GREEN part 1 — the scanners.** Create
      `scripts/lib/py-receiver-binding.ts` with the header comment and the three
      primitives every later step reuses. Write it in one call; it is under 120
      lines.

      ```ts
      /**
       * Which STATEMENT bound a residual row's receiver name (bd (e5).1, E5.0a).
       *
       * `scripts/lib/py-residual-families.ts` answers which MECHANISM would
       * resolve a row. This answers one level finer and only for the bare-name
       * population: what the receiver identifier IS. Exactly one binding per
       * row, precedence most-specific-first, `unbound` REPORTED rather than
       * hidden — a classifier that cannot say so is not a measurement.
       *
       * `self` and `cls` are not parameters here. They are E4.4's class-object
       * family, and counting them inflates `paramUnannotated` by an order of
       * magnitude (spec D7).
       */
      export const PY_RECEIVER_BINDINGS = [
        "paramUnannotated", "paramAnnotated", "loopTarget", "comprehension",
        "tupleUnpack", "walrus", "exceptAs", "withAs", "assignCallProject",
        "assignCallExternal", "assignAlias", "assignOther", "moduleLevel", "unbound",
      ] as const;
      export type PyReceiverBinding = (typeof PY_RECEIVER_BINDINGS)[number];

      export interface PyParam { name: string; annotated: boolean; annotation: string | null }
      export interface PyBindingSourceView {
        linesOf: (relPath: string) => readonly string[];
        isProjectClass: (name: string) => boolean;
        isProjectDef: (name: string) => boolean;
      }
      export interface PyBindingAttribution {
        binding: PyReceiverBinding;
        detail: string;
        defLine: number | null;
      }

      /** Names the fold must never treat as parameters (spec D7). */
      const IMPLICIT_RECEIVERS = new Set(["self", "cls"]);

      export const indentOf = (s: string): number => s.length - s.trimStart().length;

      /**
       * Balanced-bracket span starting at the `(` at (line, col). Returns the
       * INNER text and the line it closed on; `null` when it does not close
       * within 60 lines, which is a signature no report should guess at.
       */
      export function bracketSpan(
        src: readonly string[], line: number, col: number,
      ): { text: string; endLine: number } | null {
        let depth = 0; let out = ""; let l = line; let c = col;
        for (; l < src.length && l < line + 60; l++) {
          const s = src[l] ?? "";
          for (; c < s.length; c++) {
            const ch = s[c];
            if (ch === "(" || ch === "[" || ch === "{") { depth++; if (depth === 1) continue; }
            else if (ch === ")" || ch === "]" || ch === "}") { depth--; if (depth === 0) return { text: out, endLine: l }; }
            out += ch;
          }
          out += " "; c = 0;
        }
        return null;
      }

      /** Split on TOP-LEVEL commas, respecting brackets and string literals. */
      export function splitTopLevel(text: string): string[] {
        const out: string[] = []; let depth = 0; let cur = ""; let quote: string | null = null;
        for (const ch of text) {
          if (quote !== null) { cur += ch; if (ch === quote) quote = null; continue; }
          if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
          if (ch === "(" || ch === "[" || ch === "{") depth++;
          if (ch === ")" || ch === "]" || ch === "}") depth--;
          if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
          cur += ch;
        }
        if (cur.trim() !== "") out.push(cur.trim());
        return out;
      }

      /** Parse the `def` at `line` (0-based) into its name and parameter list. */
      export function parsePythonDef(
        src: readonly string[], line: number,
      ): { name: string; params: PyParam[] } | null {
        const s = src[line] ?? "";
        const m = /(?:async\s+)?def\s+(\w+)\s*\(/.exec(s);
        if (m === null) return null;
        const span = bracketSpan(src, line, s.indexOf("(", m.index));
        if (span === null) return null;
        const params = splitTopLevel(span.text)
          .map((raw) => {
            const bare = raw.replace(/^\*+/, "").trim();
            const eq = bare.indexOf("=");
            const head = (eq === -1 ? bare : bare.slice(0, eq)).trim();
            const colon = head.indexOf(":");
            if (colon === -1) return { name: head, annotated: false, annotation: null };
            return { name: head.slice(0, colon).trim(), annotated: true, annotation: head.slice(colon + 1).trim() };
          })
          .filter((p) => /^[A-Za-z_]\w*$/.test(p.name));
        return { name: m[1] as string, params };
      }
      ```

- [ ] **3. GREEN part 2 — the enclosing-def scan, and why it is written this
      way.** Append to `scripts/lib/py-receiver-binding.ts`.

      The scan uses a FIXED `callIndent` watermark and skips every dedented
      line that is not a `def` or a `class`. The obvious version — carry a
      moving watermark and lower it on each dedent — is wrong, and wrong
      silently: one flush-left comment or a dedented continuation drops the
      watermark to 0 and every row below reads "no enclosing def". Measured on
      the e46b1 dumps, that version orphaned 346 of polar's 548 residual rows;
      this version orphans 0.

      ```ts
      /**
       * The `def` enclosing a 1-based call line.
       *
       * Walks up for the nearest line INDENTED LESS than the call that is a
       * `def`; a `class` header reached first means the call sits in a class
       * body and has no enclosing def. Every other dedented line — an `if`, a
       * comment, a closing bracket — is skipped WITHOUT lowering the watermark,
       * which is the whole correctness of the scan.
       */
      export function enclosingPythonDef(
        src: readonly string[], callLine1: number,
      ): { line: number; name: string; params: PyParam[]; isMethod: boolean } | null {
        const idx = callLine1 - 1;
        if (idx < 0 || idx >= src.length) return null;
        const callIndent = indentOf(src[idx] as string);
        for (let i = idx; i >= 0; i--) {
          const s = src[i] as string;
          if (s.trim() === "") continue;
          if (indentOf(s) >= callIndent) continue;
          if (/^\s*(?:async\s+)?def\s+\w+\s*\(/.test(s)) {
            const parsed = parsePythonDef(src, i);
            if (parsed === null) continue;
            const first = parsed.params[0]?.name;
            return { line: i, name: parsed.name, params: parsed.params, isMethod: IMPLICIT_RECEIVERS.has(first ?? "") };
          }
          if (/^\s*class\s+\w/.test(s)) return null;
        }
        return null;
      }
      ```

- [ ] **4. GREEN part 3 — the classifier.** Append. Precedence is parameter →
      loop/comprehension → tuple unpack → walrus → `except`/`with` → assignment
      → module scope → `unbound`, and the first match wins.

      ```ts
      const LITERAL_RHS = /^(["'`]|[frbu]["']|\d|True|False|None|\[|\{|\()/;

      /** What an assignment's right-hand side says about the bound name. */
      function classifyRhs(rhs: string, view: PyBindingSourceView): { binding: PyReceiverBinding; detail: string } {
        const t = rhs.trim().replace(/^await\s+/, "");
        const call = /^([A-Za-z_][\w.]*)\s*\(/.exec(t);
        if (call !== null) {
          const head = (call[1] as string).split(".").pop() as string;
          const inProject = view.isProjectClass(head) || view.isProjectDef(head);
          return { binding: inProject ? "assignCallProject" : "assignCallExternal", detail: (call[1] as string).slice(0, 60) };
        }
        if (/^[A-Za-z_][\w.]*$/.test(t)) return { binding: "assignAlias", detail: t.slice(0, 60) };
        if (LITERAL_RHS.test(t)) return { binding: "assignOther", detail: t.slice(0, 60) };
        return { binding: "assignOther", detail: t.slice(0, 60) };
      }

      export function classifyReceiverBinding(
        row: { relPath: string; startLine: number; receiver: string | null; receiverKind: string },
        view: PyBindingSourceView,
      ): PyBindingAttribution {
        const name = row.receiver ?? "";
        const src = view.linesOf(row.relPath);
        if (!/^[A-Za-z_]\w*$/.test(name) || src.length === 0) return { binding: "unbound", detail: "", defLine: null };
        const def = enclosingPythonDef(src, row.startLine);
        const defLine = def?.line ?? null;
        if (def !== null && !IMPLICIT_RECEIVERS.has(name)) {
          const param = def.params.find((p) => p.name === name);
          if (param !== undefined) {
            return { binding: param.annotated ? "paramAnnotated" : "paramUnannotated", detail: `def ${def.name}`, defLine };
          }
        }
        const stop = def?.line ?? 0;
        for (let i = row.startLine - 2; i >= stop; i--) {
          const line = (src[i] ?? "").trim();
          const forOne = new RegExp(`\\bfor\\s+${name}\\s+in\\s+([^:]+)`).exec(line);
          if (forOne !== null) {
            const comprehension = /^[\[({]/.test(line) || /[\[({][^\])}]*\bfor\s/.test(line);
            return { binding: comprehension ? "comprehension" : "loopTarget", detail: (forOne[1] as string).trim().slice(0, 60), defLine };
          }
          if (new RegExp(`\\bfor\\s+[\\w\\s,]*\\b${name}\\b[\\w\\s,]*\\s+in\\s+`).test(line)) {
            return { binding: "tupleUnpack", detail: line.slice(0, 60), defLine };
          }
          if (new RegExp(`\\b${name}\\s*:=`).test(line)) return { binding: "walrus", detail: line.slice(0, 60), defLine };
          if (new RegExp(`\\bexcept\\b.*\\bas\\s+${name}\\b`).test(line)) return { binding: "exceptAs", detail: line.slice(0, 60), defLine };
          if (new RegExp(`\\bwith\\b.*\\bas\\s+${name}\\b`).test(line)) return { binding: "withAs", detail: line.slice(0, 60), defLine };
          const assign = new RegExp(`^${name}\\s*(?::[^=]+)?=\\s*(.+)$`).exec(line);
          if (assign !== null) return { ...classifyRhs(assign[1] as string, view), defLine };
          if (line.includes(",") && new RegExp(`^[\\w\\s,*]*\\b${name}\\b[\\w\\s,*]*=[^=]`).test(line)) {
            return { binding: "tupleUnpack", detail: line.slice(0, 60), defLine };
          }
        }
        for (let i = 0; i < src.length; i++) {
          if (indentOf(src[i] as string) !== 0) continue;
          const assign = new RegExp(`^${name}\\s*(?::[^=]+)?=\\s*(.+)$`).exec((src[i] as string).trim());
          if (assign === null) continue;
          const rhs = classifyRhs(assign[1] as string, view);
          return { binding: rhs.binding === "assignOther" ? "moduleLevel" : rhs.binding, detail: `module: ${rhs.detail}`, defLine };
        }
        return { binding: "unbound", detail: "", defLine };
      }
      ```

      Run `npx vitest run tests/scripts/py-receiver-binding.test.ts`. All seven
      cases pass. Record the output.

- [ ] **5. The corpus index.** Create `scripts/py-e5-interprocedural-report.ts`
      with the header and the index. One walk builds four things: source lines
      per file, a class table (bases + declared methods), the set of `def`
      names, and a call index mapping a short name to every
      `(file, line, col     of its open paren)` occurrence — bare and dotted
      alike, because a method is called both ways.

      ```ts
      /**
       * E5.0a — receiver-binding attribution and the call-site AGREEMENT tables
       * that decide whether inter-procedural parameter typing is worth building
       * for Python (bd (e5).1).
       *
       * Usage:
       *   npx tsx scripts/py-e5-interprocedural-report.ts --rows <dump.ndjson> \
       *     --corpus-root <abs path> --corpus <name> [--json out.json]
       *
       * The corpus root must be the corpus's REAL root from
       * `scripts/lib/codegraph-corpora.json` — flask and ugnest do not live
       * under `tea-rags-bench/corpora/`, and passing the wrong root is a silent
       * zero on every source read rather than an error (E4.6 plan, decision 1).
       */
      import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
      import { join, relative } from "node:path";
      import {
        bracketSpan, classifyReceiverBinding, enclosingPythonDef, indentOf,
        PY_RECEIVER_BINDINGS, splitTopLevel,
        type PyParam, type PyReceiverBinding,
      } from "./lib/py-receiver-binding.js";

      const RESIDUAL = new Set(["missed", "fileOnly", "wrongFile", "skippedInProject"]);
      const BARE_KINDS = new Set(["dynamic", "localVar", "selfMember"]);
      const SKIP_DIRS = new Set([".venv", "venv", "node_modules", "__pycache__", "site-packages", ".tox", "build", "dist"]);

      interface DumpRow {
        relPath: string; startLine: number; callText: string; receiver: string | null;
        member: string; receiverKind: string; verdict: string;
      }
      interface ClassFacts { file: string; bases: string[]; methods: Set<string> }
      interface Corpus {
        lines: Map<string, string[]>;
        classes: Map<string, ClassFacts>;
        defNames: Set<string>;
        callIndex: Map<string, Array<readonly [string, number, number]>>;
      }

      function loadCorpus(root: string): Corpus {
        const lines = new Map<string, string[]>();
        const classes = new Map<string, ClassFacts>();
        const defNames = new Set<string>();
        const callIndex = new Map<string, Array<readonly [string, number, number]>>();
        const stack = [root];
        while (stack.length > 0) {
          const dir = stack.pop() as string;
          let entries: string[];
          try { entries = readdirSync(dir); } catch { continue; }
          for (const entry of entries) {
            if (entry.startsWith(".") || SKIP_DIRS.has(entry)) continue;
            const full = join(dir, entry);
            let isDir: boolean;
            try { isDir = statSync(full).isDirectory(); } catch { continue; }
            if (isDir) { stack.push(full); continue; }
            if (!entry.endsWith(".py")) continue;
            let src: string[];
            try { src = readFileSync(full, "utf8").split("\n"); } catch { continue; }
            const rel = relative(root, full);
            lines.set(rel, src);
            indexFile(rel, src, classes, defNames, callIndex);
          }
        }
        return { lines, classes, defNames, callIndex };
      }

      function indexFile(
        rel: string, src: string[], classes: Map<string, ClassFacts>,
        defNames: Set<string>, callIndex: Map<string, Array<readonly [string, number, number]>>,
      ): void {
        let openClass: { name: string; indent: number } | null = null;
        for (let i = 0; i < src.length; i++) {
          const s = src[i] as string;
          const cls = /^(\s*)class\s+(\w+)\s*(?:\(([^)]*)\))?\s*:/.exec(s);
          if (cls !== null) {
            const bases = (cls[3] ?? "").split(",")
              .map((b) => ((b.split("[")[0] ?? "").trim().split(".").pop() ?? "").trim())
              .filter((b) => /^[A-Z_]\w*$/.test(b));
            classes.set(cls[2] as string, { file: rel, bases, methods: new Set() });
            openClass = { name: cls[2] as string, indent: (cls[1] as string).length };
            continue;
          }
          const def = /^(\s*)(?:async\s+)?def\s+(\w+)\s*\(/.exec(s);
          if (def !== null) {
            defNames.add(def[2] as string);
            if (openClass !== null) {
              if ((def[1] as string).length > openClass.indent) classes.get(openClass.name)?.methods.add(def[2] as string);
              else openClass = null;
            }
          }
          for (const re of [/(?<![\w.])(\w{2,})\s*\(/g, /\.(\w+)\s*\(/g]) {
            for (const hit of s.matchAll(re)) {
              const name = hit[1] as string;
              const at = (hit.index as number) + (hit[0] as string).length - 1;
              const list = callIndex.get(name) ?? [];
              list.push([rel, i, at] as const);
              callIndex.set(name, list);
            }
          }
        }
      }
      ```

- [ ] **6. The argument typer and the agreement verdict.** Append. A site whose
      argument types to nothing is DETERMINABLE-NO and is counted, never
      dropped: `noDeterminable` is a reported verdict, which is what makes the
      go/no-go readable rather than optimistic.

      ```ts
      type Verdict = "exact" | "lub" | "disagree" | "noDeterminable" | "noCallSites";
      const LITERAL = /^(["'`]|[frbu]["']|\d|True|False|None|\[|\{|\()/;

      function ancestorsOf(cls: string, corpus: Corpus, seen = new Set<string>()): Set<string> {
        if (seen.has(cls)) return seen;
        seen.add(cls);
        for (const base of corpus.classes.get(cls)?.bases ?? []) ancestorsOf(base, corpus, seen);
        return seen;
      }

      /** Lowest common ancestor by MRO-ish base walk; `null` when the sets are disjoint. */
      function lowestCommonAncestor(types: string[], corpus: Corpus): string | null {
        if (types.some((t) => t.includes(":"))) return null; // callable refs never join
        const chains = types.map((t) => ancestorsOf(t, corpus));
        for (const candidate of chains[0] as Set<string>) {
          if (chains.every((c) => c.has(candidate))) return candidate;
        }
        return null;
      }

      /** The head class of an annotation; `null` for unions and non-project heads. */
      function annotationClass(text: string, corpus: Corpus): string | null {
        const t = text.trim().replace(/^["']|["']$/g, "");
        if (t.includes("|") || /^(Optional|Union)\[/.test(t)) return null;
        const head = (/^([A-Za-z_][\w.]*)/.exec(t)?.[1] ?? "").split(".").pop() ?? "";
        return corpus.classes.has(head) ? head : null;
      }

      /** The project class an argument expression denotes, or `null` (absent evidence). */
      function argType(expr: string, corpus: Corpus, callerFile: string, callerLine: number): string | null {
        const t = expr.trim();
        if (t === "" || LITERAL.test(t)) return null;
        const ctor = /^([A-Za-z_][\w.]*)\s*\(/.exec(t);
        if (ctor !== null) {
          const head = (ctor[1] as string).split(".").pop() as string;
          return /^[A-Z]/.test(head) && corpus.classes.has(head) ? head : null;
        }
        const src = corpus.lines.get(callerFile);
        if (src === undefined) return null;
        if (/^[A-Za-z_]\w*$/.test(t)) {
          const param = enclosingPythonDef(src, callerLine + 1)?.params.find((p) => p.name === t);
          if (param?.annotated === true) return annotationClass(param.annotation as string, corpus);
          return nearestTyped(src, callerLine, t, corpus);
        }
        const field = /^self\.(\w+)$/.exec(t);
        return field === null ? null : nearestTyped(src, callerLine, field[1] as string, corpus, true);
      }

      /** Nearest `name: T` annotation or `name = T(...)` above `line`. */
      function nearestTyped(
        src: readonly string[], line: number, name: string, corpus: Corpus, allowSelf = false,
      ): string | null {
        const prefix = allowSelf ? "(?:self\\.)?" : "";
        const annotated = new RegExp(`^\\s*${prefix}${name}\\s*:\\s*([^=#]+)`);
        const constructed = new RegExp(`^\\s*${prefix}${name}\\s*=\\s*([A-Za-z_][\\w.]*)\\s*\\(`);
        for (let i = line; i >= 0 && i > line - 400; i--) {
          const s = src[i] as string;
          const ann = annotated.exec(s);
          if (ann !== null) return annotationClass(ann[1] as string, corpus);
          const ctor = constructed.exec(s);
          if (ctor !== null) {
            const head = (ctor[1] as string).split(".").pop() as string;
            return /^[A-Z]/.test(head) && corpus.classes.has(head) ? head : null;
          }
        }
        return null;
      }

      /** A callable REFERENCE passed as an argument — bucket D's notion of a type. */
      function argCallable(expr: string, corpus: Corpus): string | null {
        const t = expr.trim();
        if (!/^[A-Za-z_][\w.]*$/.test(t)) return null;
        const head = t.split(".").pop() as string;
        if (corpus.classes.has(head)) return `class:${head}`;
        return corpus.defNames.has(head) ? `def:${head}` : null;
      }
      ```

- [ ] **7. The call-site sweep and the driver.** Append. Bucket membership is
      decided ONCE per row and the owning `(file, defLine, param)` is the
      aggregation key, so two residual rows inside one `def` count as two rows
      and one def — which is what makes the `rows` and `defs` columns differ.

      ```ts
      interface DefKey { file: string; defLine: number; defName: string; param: string }
      type Bucket = "A" | "D" | "E";

      /** Every call site of `key.defName`, and the type of the argument bound to `key.param`. */
      function sweepCallSites(
        corpus: Corpus, key: DefKey, params: readonly PyParam[], isMethod: boolean, bucket: Bucket,
      ): { types: string[]; sites: number; determinable: number } {
        const positional = params.findIndex((p) => p.name === key.param) - (isMethod ? 1 : 0);
        const types: string[] = [];
        let sites = 0; let determinable = 0;
        for (const [file, line, col] of corpus.callIndex.get(key.defName) ?? []) {
          const src = corpus.lines.get(file);
          if (src === undefined) continue;
          const text = src[line] as string;
          if (new RegExp(`def\\s+${key.defName}\\s*\\($`).test(text.slice(0, col + 1))) continue; // the def itself
          const span = bracketSpan(src, line, col);
          if (span === null) continue;
          sites++;
          const args = splitTopLevel(span.text);
          const kwarg = args.map((a) => new RegExp(`^${key.param}\\s*=\\s*([\\s\\S]+)$`).exec(a)).find((m) => m !== null);
          const positionals = args.filter((a) => !/^\w+\s*=[^=]/.test(a));
          const expr = kwarg?.[1] ?? (positional >= 0 ? positionals[positional] : undefined);
          if (expr === undefined) continue;
          const type = bucket === "D" ? argCallable(expr, corpus) : argType(expr, corpus, file, line);
          if (type !== null) { determinable++; types.push(type); }
        }
        return { types, sites, determinable };
      }

      function verdictOf(
        r: { types: string[]; sites: number; determinable: number }, corpus: Corpus,
      ): { verdict: Verdict; type: string | null } {
        if (r.sites === 0) return { verdict: "noCallSites", type: null };
        if (r.determinable === 0) return { verdict: "noDeterminable", type: null };
        const distinct = [...new Set(r.types)];
        if (distinct.length === 1) return { verdict: "exact", type: distinct[0] as string };
        const lca = lowestCommonAncestor(distinct, corpus);
        return lca === null ? { verdict: "disagree", type: null } : { verdict: "lub", type: lca };
      }

      /** Does `cls` or an ancestor declare `member`? The "would this row resolve" test. */
      function declaresMember(cls: string, member: string, corpus: Corpus): boolean {
        for (const c of ancestorsOf(cls, corpus)) {
          if (corpus.classes.get(c)?.methods.has(member) === true) return true;
        }
        return false;
      }
      ```

- [ ] **8. Bucketing, output, and the go/no-go line.** Append the driver. Bucket
      A is a bare-name receiver the classifier calls `paramUnannotated`; bucket
      D is `receiverKind === "bareCall"` whose `member` is an unannotated
      parameter of the enclosing def; bucket E is a `self.<field>` receiver
      where some `self.<field> = <name>` in the same file assigns from an
      unannotated parameter, and the owning def is that assignment's def, not
      the call's.

      ```ts
      const argv = process.argv.slice(2);
      const flag = (name: string): string | undefined => {
        const i = argv.indexOf(`--${name}`);
        return i === -1 ? undefined : argv[i + 1];
      };
      const rowsPath = flag("rows") as string;
      const corpusRoot = flag("corpus-root") as string;
      const corpusName = flag("corpus") ?? "corpus";
      const corpus = loadCorpus(corpusRoot);
      const view = {
        linesOf: (rel: string) => corpus.lines.get(rel) ?? [],
        isProjectClass: (n: string) => corpus.classes.has(n),
        isProjectDef: (n: string) => corpus.defNames.has(n),
      };

      const rows: DumpRow[] = readFileSync(rowsPath, "utf8").split("\n")
        .filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as DumpRow)
        .filter((r) => RESIDUAL.has(r.verdict));

      const bindingCounts: Record<string, number> = {};
      const bindingSamples: Record<string, string[]> = {};
      const owned = new Map<string, { key: DefKey; params: readonly PyParam[]; isMethod: boolean; rows: DumpRow[]; bucket: Bucket }>();
      const claim = (key: DefKey, params: readonly PyParam[], isMethod: boolean, row: DumpRow, bucket: Bucket): void => {
        const id = `${bucket}|${key.file}|${key.defLine}|${key.defName}|${key.param}`;
        const got = owned.get(id);
        if (got === undefined) owned.set(id, { key, params, isMethod, rows: [row], bucket });
        else got.rows.push(row);
      };

      for (const row of rows) {
        const src = corpus.lines.get(row.relPath);
        if (src === undefined) continue;
        const def = enclosingPythonDef(src, row.startLine);
        const receiver = row.receiver ?? "";
        if (BARE_KINDS.has(row.receiverKind) && /^[A-Za-z_]\w*$/.test(receiver)) {
          const attribution = classifyReceiverBinding(row, view);
          bindingCounts[attribution.binding] = (bindingCounts[attribution.binding] ?? 0) + 1;
          const samples = (bindingSamples[attribution.binding] ??= []);
          if (samples.length < 6) samples.push(`${row.relPath}:${row.startLine} ${row.callText.slice(0, 50)} <= ${attribution.detail}`);
          if (attribution.binding === "paramUnannotated" && def !== null) {
            claim({ file: row.relPath, defLine: def.line, defName: def.name, param: receiver }, def.params, def.isMethod, row, "A");
          }
          continue;
        }
        if (row.receiverKind === "bareCall" && def !== null) {
          const param = def.params.find((p) => p.name === row.member && !p.annotated && p.name !== "self" && p.name !== "cls");
          if (param !== undefined) {
            claim({ file: row.relPath, defLine: def.line, defName: def.name, param: param.name }, def.params, def.isMethod, row, "D");
          }
          continue;
        }
        const field = /^self\.(\w+)$/.exec(receiver);
        if (field === null) continue;
        for (let i = 0; i < src.length; i++) {
          const copy = new RegExp(`^\\s*self\\.${field[1]}\\s*=\\s*(\\w+)\\s*$`).exec(src[i] as string);
          if (copy === null) continue;
          const owner = enclosingPythonDef(src, i + 1);
          const param = owner?.params.find((p) => p.name === copy[1] && !p.annotated && p.name !== "self" && p.name !== "cls");
          if (owner != null && param !== undefined) {
            claim({ file: row.relPath, defLine: owner.line, defName: owner.name, param: param.name }, owner.params, owner.isMethod, row, "E");
          }
          break;
        }
      }
      ```

- [ ] **9. Emit.** Append the reporting tail. `unlockedExact` is the go/no-go
      number and it is printed on its own line so no reader has to add up a
      table.

      ```ts
      interface BucketReport {
        bucket: Bucket; defs: number; rows: number;
        byVerdict: Record<string, { defs: number; rows: number; resolvable: number }>;
        samples: string[];
      }
      const bucketReports: BucketReport[] = [];
      let unlockedExact = 0; let unlockedLub = 0;
      for (const bucket of ["A", "D", "E"] as const) {
        const entries = [...owned.values()].filter((e) => e.bucket === bucket);
        const byVerdict: Record<string, { defs: number; rows: number; resolvable: number }> = {};
        const samples: string[] = [];
        let rows = 0;
        for (const entry of entries) {
          rows += entry.rows.length;
          const swept = sweepCallSites(corpus, entry.key, entry.params, entry.isMethod, bucket);
          const { verdict, type } = verdictOf(swept, corpus);
          const slot = (byVerdict[verdict] ??= { defs: 0, rows: 0, resolvable: 0 });
          slot.defs++; slot.rows += entry.rows.length;
          if (type !== null) {
            const resolvable = entry.rows.filter((r) => bucket === "D" || declaresMember(type, r.member, corpus)).length;
            slot.resolvable += resolvable;
            if (verdict === "exact") unlockedExact += resolvable;
            unlockedLub += resolvable;
          }
          if (samples.length < 8) {
            samples.push(
              `${entry.key.file}:${entry.key.defLine + 1} def ${entry.key.defName}(${entry.key.param}) ` +
              `sites=${swept.sites} det=${swept.determinable} -> ${verdict}${type ?? ""} rows=${entry.rows.length}`,
            );
          }
        }
        bucketReports.push({ bucket, defs: entries.length, rows, byVerdict, samples });
      }

      const report = {
        corpus: corpusName, residualRows: rows.length,
        bareNameReceivers: Object.values(bindingCounts).reduce((n, c) => n + c, 0),
        binding: Object.fromEntries(PY_RECEIVER_BINDINGS.map((b) => [b, bindingCounts[b] ?? 0])),
        bindingSamples, buckets: bucketReports,
        goNoGo: { unlockedExact, unlockedLub, bar: 100, verdict: unlockedExact >= 100 ? "GO" : "NO-GO" },
      };
      const out = flag("json");
      if (out !== undefined) writeFileSync(out, JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report, null, 2));
      console.log(`\n${corpusName}: unlockedExact=${unlockedExact} unlockedLub=${unlockedLub} bar=100 -> ${report.goNoGo.verdict}`);
      ```

- [ ] **10. Run all five corpora and record.** Five invocations, one per corpus,
      real roots. Each is a single tool call under 8 minutes; polar is the slow
      one at roughly a minute.

      ```bash
      npx tsx scripts/py-e5-interprocedural-report.ts --corpus ugnest \
        --rows ~/.claude/jobs/dffe3647/tmp/e46b1/after-ugnest.ndjson \
        --corpus-root ~/Dev/Collaborate/ugnest --json /tmp/e5/ugnest.json
      npx tsx scripts/py-e5-interprocedural-report.ts --corpus flask \
        --rows ~/.claude/jobs/dffe3647/tmp/e46b1/after-flask.ndjson \
        --corpus-root ~/Dev/OpenSource/codegraph-test/flask --json /tmp/e5/flask.json
      npx tsx scripts/py-e5-interprocedural-report.ts --corpus httpx \
        --rows ~/.claude/jobs/dffe3647/tmp/e46b1/after-httpx.ndjson \
        --corpus-root ~/Dev/Tools/tea-rags-bench/corpora/httpx --json /tmp/e5/httpx.json
      npx tsx scripts/py-e5-interprocedural-report.ts --corpus netbox \
        --rows ~/.claude/jobs/dffe3647/tmp/e46b1/after-netbox.ndjson \
        --corpus-root ~/Dev/Tools/tea-rags-bench/corpora/netbox --json /tmp/e5/netbox.json
      npx tsx scripts/py-e5-interprocedural-report.ts --corpus polar \
        --rows ~/.claude/jobs/dffe3647/tmp/e46b1/after-polar.ndjson \
        --corpus-root ~/Dev/Tools/tea-rags-bench/corpora/polar --json /tmp/e5/polar.json
      ```

      **Reproduction gate.** The run must reproduce decision 1's binding table
      and decision 2's agreement tables. The expected totals are:
      `paramUnannotated` 5 (flask 1, netbox 4), `assignCallProject` 143,
      `paramAnnotated` 50, `unbound` 56, bare-name receivers 336, and
      `unlockedExact` summing to **5** over the five corpora. A deviation is a
      finding, not a failure — report the delta and which corpus moved, and do
      NOT edit the tables in this plan to match. The prototype these numbers
      came from is not in the repository; a small drift from a stricter
      production classifier is expected and is exactly what the reproduction
      gate exists to surface.

- [ ] **11. Open five rows per bucket by hand.** For each of `paramUnannotated`,
      `assignCallProject`, `paramAnnotated`, `loopTarget` and `unbound`, open
      the caller file at the row's line and confirm the classifier's verdict
      against the source. Record the five paths and what each turned out to be.
      A verdict the source contradicts is a classifier bug and blocks the
      commit.

- [ ] **12. Commit.** Two commits, both on the agent worktree branch, neither
      merged:

      ```text
      feat(scripts): classify residual receiver bindings ((e5).1)
      feat(scripts): report call-site agreement for unannotated params ((e5).1)
      ```

      Trailer on each, and nothing else:
      `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`

**Task report must contain:** the branch taken in step 0 and its SHA; the vitest
output from steps 1 and 4; the five commands from step 10 with their
`unlockedExact` lines; the binding table as produced; the reproduction-gate
delta against decision 1 (or "reproduces exactly"); the five hand-read rows from
step 11; and the two commit SHAs.

---

## Task E5.0b — oracle-debt re-scoring

**Files**

- EDIT `scripts/lib/py-oracle-core.ts` (carry the oracle's target on the row)
- EDIT `scripts/py-e4-family-report.ts` (only if it is the dump writer; see
  step 1)
- NEW `scripts/py-e5-oracle-debt.ts`
- NEW `tests/scripts/py-e5-oracle-debt.test.ts`

**Interfaces**

```ts
export const PY_DEBT_CLASSES = [
  "clsConstructor",
  "oracleWrongSelf",
  "oracleWrongMro",
] as const;
export type PyDebtClass = (typeof PY_DEBT_CLASSES)[number];

export interface PyDebtRow {
  relPath: string;
  startLine: number;
  member: string;
  receiverKind: string;
  verdict: string;
  chain?: { targetRelPath: string; targetSymbolId: string };
  oracleTargetRelPath?: string | null;
  oracleTargetSymbolId?: string | null;
}
export interface PyDebtPorts {
  /** Ancestors of a class short name, nearest first, from the run's hierarchy. */
  ancestorsOf: (className: string) => readonly string[];
  /** Does this symbolId name a `@classmethod` whose `def` line encloses the site? */
  isEnclosingClassmethod: (
    symbolId: string,
    relPath: string,
    startLine: number,
  ) => boolean;
}
export function classifyOracleDebt(
  row: PyDebtRow,
  ports: PyDebtPorts,
): PyDebtClass | null;
```

**Steps**

- [ ] **0. Worktree.** As Task E5.0a step 0.

- [ ] **1. Emit the oracle's target on the dump row — this blocks everything
      else.** `PyResidualRow` declares `oracleTargetRelPath` and
      `oracleTargetSymbolId` (`scripts/lib/py-residual-families.ts:36-37`) and
      no dump carries them. Prove it first and record the proof:

      ```bash
      head -1 ~/.claude/jobs/dffe3647/tmp/e46b1/after-polar.ndjson | jq -c 'keys_unsorted'
      npx tsx scripts/py-e4-family-report.ts --corpus polar \
        --rows ~/.claude/jobs/dffe3647/tmp/e46b1/after-polar.ndjson \
        --corpus-root ~/Dev/Tools/tea-rags-bench/corpora/polar | grep -E 'BareCall'
      ```

      The second command prints `sameFileBareCall` 0 and `crossFileBareCall`
      110, against D8's 140 / 31 — the same-file test is comparing against
      `undefined`. Then:

      - `PyOracleRow` (`scripts/lib/py-oracle-core.ts:211`) carries
        `chain?: OracleAnswer` and nothing for the oracle's own answer. Add
        `oracleTarget?: OracleAnswer` immediately after `chain`, with a comment
        saying it is the ORACLE's answer and that `chain` is the resolver's.
      - Find the construction site: `rg -n 'chainOutput:' scripts/` and take the
        one that also has the oracle reply in scope (it is the caller of
        `classifyPyVerdict`, which already receives `input.oracle`). Populate
        `oracleTarget` there from the same value the verdict was computed from.
        Do NOT add a second oracle call.
      - Where rows are serialised to NDJSON, emit the two FLAT fields the
        family classifier declares — `oracleTargetRelPath`,
        `oracleTargetSymbolId` — from `oracleTarget`, rather than renaming the
        classifier's interface. The classifier is shipped and other readers
        depend on those names.
      - No verdict logic changes. Re-run one corpus dump and diff the row count
        and every verdict tally against the pre-change dump: they must be
        identical, and only the two new keys may appear.

      **DONE 2026-09-11** — `fix(scripts)` + `test(scripts)`, dumps under
      `~/.claude/jobs/dffe3647/tmp/e50b/`. Both keys sit on `PyOracleRow` flat
      and always present, under the names `PyResidualRow` already declares,
      rather than a nested `oracleTarget` each dump driver would re-project;
      the value is the WITHDRAWN oracle `classifyPyVerdict` was handed, so no
      row can claim it was scored against a target the super-MRO blind spot had
      taken away.

      Corrected bare-call split, from dumps regenerated with the fixed host
      (`--oracle merged --dispatch --workers 8 --samples 500000`):

      | corpus | `sameFileBareCall` | `crossFileBareCall` | total | D8 (pre-E4.6) |
      | ------ | ------------------ | ------------------- | ----- | ------------- |
      | flask  | 0 → **5**          | 5 → **0**           | 5     | 11 / 0        |
      | polar  | 0 → **87**         | 110 → **23**        | 110   | 115 / 23      |

      netbox was NOT regenerated: its run was killed (SIGTERM, no output) under
      contention with two parallel executors, and re-running it buys nothing the
      gate needs — polar is D8's anchor and the only corpus carrying a non-zero
      `crossFileBareCall`. D8 has netbox at 9 / 0; a post-fix dump would confirm
      it, not correct it.

      `crossFileBareCall` reproduces D8's polar column (4 + 4 + 15) exactly,
      which is the check that the field carries the right value and not merely
      a value. The two families' TOTAL is invariant across the fix — only the
      partition moves — and every other family is unchanged: flask 7 of 9
      untouched, polar 9 of 11.

      Identity gate, stronger than the row/verdict diff the step asks for:
      stripping the two keys back off the post-fix dumps — the nested `legacy`
      twin included — reproduces the e46b1 dumps **byte-identically** on both
      corpora, 632 polar rows and all. Nothing else in any row moved.

- [ ] **2. RED — the three predicates.** Write
      `tests/scripts/py-e5-oracle-debt.test.ts` with one case per class plus one
      negative. Stub `PyDebtPorts` with literals; no corpus, no oracle.

      ```ts
      import { describe, expect, it } from "vitest";
      import { classifyOracleDebt } from "../../scripts/py-e5-oracle-debt.js";

      const ports = {
        ancestorsOf: (c: string) => (c === "CustomerRepository" ? ["RepositoryBase"] : []),
        isEnclosingClassmethod: (id: string) => id.endsWith("#from_session") || id.endsWith(".from_session"),
      };

      describe("classifyOracleDebt", () => {
        it("books a cls(...) row whose oracle target is the enclosing classmethod", () => {
          const row = {
            relPath: "kit/repository/base.py", startLine: 166, member: "cls",
            receiverKind: "bareCall", verdict: "missed",
            oracleTargetRelPath: "kit/repository/base.py",
            oracleTargetSymbolId: "RepositoryBase.from_session",
          };
          expect(classifyOracleDebt(row, ports)).toBe("clsConstructor");
        });

        it("books a Self-return row where the oracle answered an ANCESTOR of the chain's class", () => {
          const row = {
            relPath: "customer/service.py", startLine: 399, member: "update",
            receiverKind: "chain", verdict: "wrongFile",
            chain: { targetRelPath: "customer/repository.py", targetSymbolId: "CustomerRepository#update" },
            oracleTargetRelPath: "kit/repository/base.py",
            oracleTargetSymbolId: "RepositoryBase#update",
          };
          expect(classifyOracleDebt(row, ports)).toBe("oracleWrongSelf");
        });

        it("books an MRO row where neither target is an ancestor of the other", () => {
          const row = {
            relPath: "dcim/models/cables.py", startLine: 278, member: "save",
            receiverKind: "chain", verdict: "wrongFile",
            chain: { targetRelPath: "a.py", targetSymbolId: "Alpha#save" },
            oracleTargetRelPath: "b.py", oracleTargetSymbolId: "Beta#save",
          };
          expect(classifyOracleDebt(row, ports)).toBe("oracleWrongMro");
        });

        it("books nothing when the two engines agree", () => {
          const row = {
            relPath: "a.py", startLine: 1, member: "save", receiverKind: "chain", verdict: "missed",
            chain: { targetRelPath: "a.py", targetSymbolId: "Alpha#save" },
            oracleTargetRelPath: "a.py", oracleTargetSymbolId: "Alpha#save",
          };
          expect(classifyOracleDebt(row, ports)).toBeNull();
        });
      });
      ```

- [ ] **3. GREEN — the pass.** Create `scripts/py-e5-oracle-debt.ts`.

      ```ts
      /**
       * E5.0b — re-score the ORACLE-WRONG residual, downstream of the harness
       * (bd (e5).2).
       *
       * Three classes of residual row are the oracle being wrong rather than
       * the chain, and they inflate every recall denominator they sit in:
       * `cls(...)` constructors (32 rows — both engines answer the enclosing
       * classmethod because `cls` is a parameter whose definition line IS the
       * `def` line), `oracleWrongSelf` (14 polar rows — jedi resolves a
       * `-> Self` classmethod result to the DECLARING class), and
       * `oracleWrongMro` (11 netbox rows).
       *
       * This is a pass over DUMPS. It calls no oracle, changes no merge rule,
       * and emits `recallDebtAdjusted` BESIDE `recallMerged`, never in place of
       * it — the same discipline as `recallLegacy` / `recallMerged`. The merge
       * stays per FILE because jedi's per-process module cache makes it a
       * correctness constraint (`jedi_oracle.py:539`), so a per-CLASS-of-site
       * override is exactly the tiebreak the E4 spec forbids.
       */
      export const PY_DEBT_CLASSES = ["clsConstructor", "oracleWrongSelf", "oracleWrongMro"] as const;
      export type PyDebtClass = (typeof PY_DEBT_CLASSES)[number];

      export interface PyDebtRow {
        relPath: string; startLine: number; member: string; receiverKind: string; verdict: string;
        chain?: { targetRelPath: string; targetSymbolId: string };
        oracleTargetRelPath?: string | null;
        oracleTargetSymbolId?: string | null;
      }
      export interface PyDebtPorts {
        ancestorsOf: (className: string) => readonly string[];
        isEnclosingClassmethod: (symbolId: string, relPath: string, startLine: number) => boolean;
      }

      /** `"Cls#m"` / `"Cls.m"` → `["Cls", "m"]`; `null` when the id is not a member. */
      function splitCoordinate(symbolId: string): [string, string] | null {
        const hit = /^(.+?)[#.]([A-Za-z_]\w*)$/.exec(symbolId);
        return hit === null ? null : [(hit[1] as string).split("::").pop() as string, hit[2] as string];
      }

      export function classifyOracleDebt(row: PyDebtRow, ports: PyDebtPorts): PyDebtClass | null {
        const oracleId = row.oracleTargetSymbolId;
        if (oracleId == null) return null;
        if (
          row.receiverKind === "bareCall" && row.member === "cls" &&
          ports.isEnclosingClassmethod(oracleId, row.relPath, row.startLine)
        ) {
          return "clsConstructor";
        }
        const chainId = row.chain?.targetSymbolId;
        if (chainId === undefined || chainId === oracleId) return null;
        const chainSplit = splitCoordinate(chainId);
        const oracleSplit = splitCoordinate(oracleId);
        if (chainSplit === null || oracleSplit === null) return null;
        const [chainClass, chainMember] = chainSplit;
        const [oracleClass, oracleMember] = oracleSplit;
        if (chainMember !== oracleMember) return null;
        if (ports.ancestorsOf(chainClass).includes(oracleClass)) return "oracleWrongSelf";
        if (ports.ancestorsOf(oracleClass).includes(chainClass)) return null; // chain picked the base: chain's problem
        return "oracleWrongMro";
      }
      ```

      Then the driver: read a dump, classify every residual row, and print
      per-corpus `residual`, `debt` per class, `residualDebtAdjusted =
      residual − debt`, and `recallDebtAdjusted` recomputed on the shrunk
      denominator alongside the raw `recallMerged`. Both columns always. Wire
      `ancestorsOf` from the corpus class table Task E5.0a's report already
      builds — import `loadCorpus` rather than writing a second walker — and
      `isEnclosingClassmethod` by reading the target file at the symbol's `def`
      line and testing for a `@classmethod` decorator above it.

- [ ] **4. Run and reconcile against D9 and E4.4.** Run the pass over all five
      dumps. The counts it books must reconcile with the recorded ones:
      `clsConstructor` **32** (E4.4 plan decision 3, table row b),
      `oracleWrongSelf` **14** polar (D9, and the 14 sites are listed there by
      path and line), `oracleWrongMro` **11** netbox (D9's list). Report each as
      `booked / expected`. A shortfall is a predicate that is too narrow and
      must be reported with the rows it missed, not widened until the number
      matches.

      Rows the predicates cannot settle get a pyright quote — driven directly
      on the site list with `scripts/py-oracle/lsp_oracle.ts`, the same
      instrument D9 used for `OW:Self`'s 14 of 14. Cap: 60 sites. This is a
      measurement artefact, not a harness mode, and it does not become part of
      any run.

- [ ] **5. State what downstream subtracts.** Append to the task report, in
      these words or closer: E4.6-close subtracts polar's 14 `OW:Self` rows from
      its gross-lost column (D9 already books them as an instrument reading);
      E4.4 subtracts the 32 `cls(...)` rows from its 106-row family before
      claiming any gain, which its decision 3 already commits to; netbox's 11
      `OW:Mro` rows come off netbox's `chain` denominator. Print the corrected
      per-corpus denominators.

- [ ] **6. Commit.**

      ```text
      fix(scripts): emit the oracle target on residual dump rows ((e5).2)
      feat(scripts): re-score the oracle-wrong residual classes ((e5).2)
      ```

      Trailer: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`

**Task report must contain:** the step-1 proof that the two fields were absent
and the diff showing only they were added; the vitest output; the
`booked / expected` reconciliation for all three classes; the corrected
denominators per corpus; the pyright site count if any; and the commit SHAs.

---

## Task E5.0c — nested-def symbolId spelling in the jedi oracle — **DONE**

**Files**

- EDIT `scripts/py-oracle/jedi_oracle.py` (`compose_symbol_id`)
- NEW `scripts/py-oracle/test_compose_symbol_id.py`
- NEW `tests/scripts/py-compose-symbol-id.test.ts`
- EDIT `docs/superpowers/plans/2026-09-08-python-codegraph-e0-measurement.md`
  (one line in the Task 2 oracle contract)

**The defect.** `compose_symbol_id` joined the WHOLE enclosing scope with `"."`
and chose a separator only for the LAST hop, so a def nested in a method read
`Blueprint._merge_blueprint_funcs#extend` where the walker composes
`Blueprint#_merge_blueprint_funcs#extend`. Same file, same line, different
string — and the host compares symbolIds as strings, so the row was booked
`fileOnly`. Nothing about the oracle's TARGET was ever wrong. A per-file check
cannot see a separator, which is how this survived the fixture corpus, where
every def is one hop deep.

**The rule as shipped.** Each hop reads its separator off the node IT names,
which is what `name-of.ts` + `kernel/collect-symbols.ts` +
`DefaultSymbolIdComposer` do. The docstring names the walker as the source of
truth rather than restating the rule as if it were independent:

| hop                                       | separator                     | example                                     |
| ----------------------------------------- | ----------------------------- | ------------------------------------------- |
| no enclosing def or class                 | —                             | `promote`                                   |
| `class`                                   | `.` (Python `scopeSeparator`) | `Outer.Inner`                               |
| `def` with `staticmethod` / `classmethod` | `.`                           | `User.normalise`                            |
| any other `def`                           | `#`                           | `User#rename`, `outer#inner`, `Cls#m#inner` |

`defNodeKind` and `pinUncertain` are untouched, and `compose_symbol_id` is
called only inside the oracle's `inProject` branch, so no verdict logic moves: a
row can flip only where the spelling differed.

**Tests.** Seventeen shapes in `scripts/py-oracle/test_compose_symbol_id.py`
(plain `unittest`, no pytest), expectations MEASURED off the walker on the same
source rather than reasoned about. `tests/scripts/py-compose-symbol-id.test.ts`
spawns it through the same `uv` launcher `JEDI_LAUNCHER` uses and skips when
`uv` is absent, as `jedi-oracle-spawn.test.ts` does — a Python test nothing
spawns is a test nobody runs, which is the reason this defect lived. The frozen
`expected-oracle.json` is unchanged, the 20 pre-existing Python unit tests pass,
and `npx vitest run tests/scripts/` is 466/466.

**Gate, measured.**
`npx tsx scripts/py-codegraph-jedi-oracle.ts --corpus <c> --oracle merged --dispatch --workers 8 --json <out>`,
the unfixed oracle against the fixed one at the SAME tree, so only the oracle
differs.

| corpus | respelled defs | `fileOnly` | `match`        | every other verdict |
| ------ | -------------- | ---------- | -------------- | ------------------- |
| flask  | 18             | 6 -> 0     | 330 -> 336     | identical           |
| httpx  | 4              | 5 -> 1     | 477 -> 481     | identical           |
| netbox | 273            | 2 -> 0     | 7852 -> 7854   | identical           |
| ugnest | 0              | 0 -> 0     | 772, no move   | identical           |
| polar  | 128            | 34 -> 24   | 11942 -> 11952 | identical           |

22 rows in all, `chainDrift 0` and `dispatchDrift 0` on every run, and outside
the tally tables the two payloads are byte-identical. `respelled defs` counts
DEFINITIONS the fix spells differently (pure AST, both builds imported side by
side) and bounds what can move — most of netbox's 273 sit in test files the
harness does not score.

The 38 predicted off the E4.0.4 dumps is stale, not missed: those dumps predate
E4.4b, and the rows moved under it. What is left is a DIFFERENT family. polar's
remaining 24 are `dynamic` 18 / `chain` 3 / `super` 3 and httpx's remaining 1 is
`chain` — no `bareCall` among them, and `bareCall` is the receiver kind every
row this fix repaired carried.

Row level, not just tallies: a per-row dump under both builds differs on flask
in exactly 6 lines and on httpx in exactly 4, all `fileOnly -> match`, all in
the families the diagnosis named — `Blueprint#_merge_blueprint_funcs#extend`
(`src/flask/sansio/blueprints.py:402-410`) and
`DigestAuth#_build_auth_header#digest` (`httpx/_auth.py:268-291`).

**Determinism.** Two fixed-build polar runs agree on every column, `fileOnly` 24
and `match` 11952 both times.

**One row wobbles independently of this change.** httpx and netbox each carry a
site whose oracle answer alternates between `external` and `unknown` run to run
— the jedi per-process module-cache effect `jedi_oracle.py`'s striping comment
already records. Three runs of the UNFIXED oracle on httpx read `agreeExternal`
887 / 886 / 886, so it is visible on the baseline alone. The rows above are read
against the baseline run that drew the same way; against the other draw one row
moves between `agreeExternal` and `bothUnresolved` and `groundTruth` shifts by
one.

**A contaminated pair, and the rule it earns.** The oracle's Python process is
spawned by `askOracles` AFTER `walkCorpus` returns, not at launch. Swapping
`jedi_oracle.py` while a background run is still walking therefore decides which
build that run measures, and polar's walk is minutes long. The first polar pair
was swapped under exactly that way and reported identical tallies down to the
byte — which, on a corpus with 128 respelled defs, is the signature of one build
measured twice. Both were discarded and re-run with no tree writes in flight.
**Never write to a script a background harness run will later spawn.**

**Commits.** `d69dc589f` fix, `db71bb7ed` tests, plus this record and the E0
contract line.

---

## Task E5.1 — Python producer for the barrier fold — **GATED SHUT**

> **Gate.** This task executes only when Task E5.0a's `unlockedExact`, summed
> over the corpora it was run on, is **≥ 100**. The measured value is **5**.
> Step 0 below stops the task, and stopping is the correct outcome — the steps
> exist so a corpus that clears the bar re-opens the increment without a
> redesign.

**Files**

- EDIT `src/core/domains/language/python/walker/passes/python-def-signatures.ts`
- NEW
  `src/core/domains/language/python/walker/passes/python-known-target-args.ts`
- NEW
  `src/core/domains/language/python/walker/passes/python-class-field-params.ts`
- EDIT `src/core/domains/language/python/walker/passes.ts` (register both
  passes)
- NEW tests beside each pass

**Interfaces** — all three already exist and are not changed:

```ts
// contracts/types/codegraph-extraction.ts
ChunkExtraction.paramNames?: string[];                                   // :482
FileExtraction.knownTargetCallArgs?: KnownTargetCallArgs[];              // :266
FileExtraction.classFieldParamLinks?: Record<string, Record<string, ClassFieldParamLink>>;  // :282
```

**Steps**

- [ ] **0. GATE.** Read Task E5.0a's report. If `unlockedExact < 100`, write a
      one-paragraph report stating the number, the bar, and that the task did
      not execute, and STOP. Do not create a worktree. Do not write code.

- [ ] **1. Worktree.** Only past the gate. As Task E5.0a step 0.

- [ ] **2. Kill switch first.** `CODEGRAPH_PY_PARAM_TYPING`, read ONCE at
      composition in `python/index.ts` where the pass list is assembled, and
      gating the WALKER EMIT rather than the fold — `paramNames` has two
      existing narrower readers (`python/CLAUDE.md:407`), so filling it changes
      their inputs whether or not the fold runs. Absent ⇒ none of the three
      passes is in the list ⇒ `knownTargetCallArgs.size > 0` is false at the
      barrier for a Python-only run and every column is byte-identical. Same
      shape as `CODEGRAPH_PY_DYNAMIC_DISPATCH` parking E4.1.3.

- [ ] **3. RED then GREEN — `paramNames`.** `python-def-signatures.ts:36`
      currently states Python does NOT fill it. Write the failing test first (a
      `def f(self, a, b=1, *args, **kw)` chunk asserts
      `paramNames === ["self", "a", "b"]`), then fill it from the same signature
      node the pass already parses. **Truncate at the first `*` or `**`\*\* —
      the channel's contract says the array stops where positional
      correspondence breaks, and the fold indexes by position. Update the file's
      header comment: it is now a statement of fact that would become false.

- [ ] **4. RED then GREEN — `knownTargetCallArgs`.** New pass
      `python-known-target-args.ts`. Python's syntactically-known callee set:

      - `Cls(...)` where `Cls` is a class name the file's imports or its own
        declarations bind ⇒ target `"<Cls>#__init__"`;
      - `Cls.method(...)` on the same ⇒ target `"<Cls>.method"`;
      - a module-level `def` called by bare name that the import mapper already
        pins to a file ⇒ target `"<name>"`.

      `argTypes[i]` is a `TypeRef` when the argument is a constructor call of a
      known class, an annotated local, or an annotated parameter; `null`
      otherwise. A `null` never votes and never vetoes. Truncate the array at
      the first splat or keyword argument. Emit nothing for a call whose callee
      binds to no in-project name — the fold's existence gate would drop it
      anyway, and emitting it makes the channel proportional to the corpus
      instead of to its typed call sites.

- [ ] **5. RED then GREEN — `classFieldParamLinks`.** New pass
      `python-class-field-params.ts`. `self.<field> = <name>` inside an INSTANCE
      method where `<name>` is a parameter of that method, emitted as
      `{ [fqClass]: { [field]: { method, param } } }`. A field fed by two
      different `(method, param)` coordinates in one class is **DROPPED**, not
      last-write-wins — the Ruby channel's contract says so and the reason is
      that two origins mean two candidate types. `self` and `cls` are never the
      `param`.

- [ ] **6. Parity and gates.** Four columns, all on the same corpora: - **Ruby
      byte-identical.** Run the Ruby suite and one Ruby corpus tally; no Ruby
      file was touched, so any delta is a shared-code regression. - **Flag OFF
      is byte-identical.** Row dumps on all five Python corpora must match the
      pre-change dumps on
      `(relPath, startLine, callText) → (verdict, chainOutput, chain.targetSymbolId)`. -
      **Flag ON:** gross lost **0**, phantom flat, ugnest **0**, and the two
      `paramNames` narrower columns flat. - **The recall delta must be the
      measured one.** If E5.0a said N rows, the run books N. A larger number is
      not a bonus, it is an unmeasured mechanism firing and it blocks the commit
      until it is attributed.

- [ ] **7. Commit.** One commit per pass, subjects ending `((e5).3)`, trailer
      `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## Task E5.2 — parameter-bound callables — **GATED SHUT**

> **Gate.** Executes only when Task E5.0a's bucket D `resolvable` at exact
> agreement is **≥ 30** (the program's standing mass bar). Measured: **3**, all
> polar, all one shape — `dev/cli/commands/snap.py` passing the module-level
> `set_status` into `_dev_up` / `_start_api` / `_start_web`.

**Steps**

- [ ] **0. GATE.** Read Task E5.0a's report. If bucket D `resolvable` < 30,
      report the number and the bar and STOP.

- [ ] **1.** Past the gate, this is one more arm on Task E5.1's
      `python-known-target-args.ts`, not a new pass: a parameter whose call
      sites all pass the same project `def` or class REFERENCE gets a callable
      fact, and `bareCall` resolution consults it before `globalShortName`. The
      existing `dispatchArgs` mechanism (`resolution-runner.ts:522`, "bounded
      inter-proc join: a dispatch candidate-set passed as a callback argument
      fans out from the CALLEE") already covers the FAN side of this shape; E5.2
      is its 1:1 counterpart and must not double-emit where `dispatchArgs`
      already fires. Prove that with a row-level A/B before claiming a gain.

---

## Task E5-close

- [ ] **0. Worktree.** As Task E5.0a step 0.
- [ ] **1.** Append a "Measurement record" section to this file carrying, per
      corpus: the binding table as produced by Task E5.0a, the three agreement
      tables, `unlockedExact` / `unlockedLub`, and the reproduction-gate delta
      against decision 1.
- [ ] **2.** Append an "Oracle debt record" section carrying Task E5.0b's
      `booked / expected` reconciliation and the corrected denominators.
- [ ] **3.** State the two gate outcomes in one line each: E5.1 did not execute
      (`unlockedExact` = N, bar 100); E5.2 did not execute (bucket D resolvable
      = M, bar 30).
- [ ] **4.** Record the follow-up that is NOT an E5 bead: the cross-chunk
      call-result fold on the 143 `assignCallProject` rows (decision 7). It
      belongs to E4.6b's owner and wants its own attribution pass before it is
      scoped. Do not open a bead for it here.
- [ ] **5. Commit.**
      `docs(plans): record the E5.0 measurement and gate outcomes ((e5))`,
      trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

**Do NOT:** merge to main, push, run `bd`, reindex, or move the global npm link.
