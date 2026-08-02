# Filter Presets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. If executing in this repo, prefer the
> `dinopowers:executing-plans` wrapper.

**Goal:** Add named, adaptive **filter presets** referenced through the existing
`filter` param (`{ presets: "a,b" }`), wire hygiene-only defaults onto rerank
presets, and teach the tea-rags skills to apply specific filters in
inventory/reference modes.

**Architecture:** A filter preset is a lightweight data declaration
(`FilterPresetDef`) of raw-signal conditions whose thresholds may be adaptive
collection percentiles. Conditions compile to a Qdrant pre-filter at SEARCH
stage, resolving percentiles from collection Stats with a static fallback.
Per-trajectory registries (`*_FILTER_PRESETS`) are assembled and
`requires`-gated in `composition.ts`, mirroring rerank-preset assembly. Hygiene
presets (`production`/`coreLogic`) become rerank-preset defaults; specific risk
presets stay skill-applied.

**Tech Stack:** TypeScript (ESM, NodeNext), Vitest, Qdrant filter DSL, existing
`contracts`/`domains/trajectory`/`domains/explore`/`api/internal` layering.

**Spec:** `docs/superpowers/specs/2026-06-15-filter-presets-design.md` — read it
before starting.

**Paired beads epic:** `tea-rags-mcp-t2ma` (21 tasks T1–T21; Stream 2 tasks
depend on T16). Two streams: **Stream 1** (Tasks 1–16, engine+registry+hygiene
defaults, one `feat(presets)!`) strictly before **Stream 2** (Tasks 17–21, skill
teaching).

**Project rules in force:** TDD red-first (`.claude/rules` + global); typed
errors only (`typed-errors.md`); barrel files at every subdomain
(`barrel-files.md`); no Zod in `contracts/` (`domain-boundaries.md`); deep-silo
commits carry a `Why:` line (`silo-pairing.md`); no rewriting passing
business-logic tests (`test-patterns.md`); commit scope `presets` (minor/feat)
per `commit-rules.md`.

---

## File Structure

**New files (Stream 1):**

- `src/core/contracts/types/filter-preset.ts` — `FilterSpec`, `FilterThreshold`,
  `AdaptiveFilterCondition`, `FilterPresetDef` (pure types).
- `src/core/domains/trajectory/filter-presets/compiler.ts` —
  `compileFilterPreset(def, stats, level)` → `QdrantFilter`. Pure,
  cross-trajectory.
- `src/core/domains/trajectory/{static,git}/filter-presets/*.ts` + `index.ts` —
  catalog + barrels.
- `src/core/domains/trajectory/codegraph/symbols/filter-presets/*.ts` +
  `index.ts` — catalog + barrel (gated).
- `src/core/domains/trajectory/composite/filter-presets/*.ts` + `index.ts` —
  catalog + barrel + `buildCompositeFilterPresets()`.
- `tests/core/domains/trajectory/filter-presets/compiler.test.ts`,
  `tests/core/domains/trajectory/registry-filter-presets.test.ts`, and per-area
  catalog/resolution tests.

**Modified files (Stream 1):**

- `src/core/contracts/signal-utils.ts` — add `toPhysicalPayloadKey()` (shared
  logical→physical).
- `src/core/contracts/types/reranker.ts` — `RerankPreset.filter?: FilterSpec`.
- `src/core/contracts/index.ts` — export new filter-preset types.
- `src/core/domains/ingest/infra/collection-stats.ts` — reuse
  `toPhysicalPayloadKey`; extend percentile-reference walk +
  `validateSignalDependencies` to cover filter presets.
- `src/core/domains/trajectory/registry.ts` +
  `src/core/contracts/types/trajectory.ts` — filter-preset registry +
  `resolveFilterPresets()`.
- `src/core/domains/trajectory/git/payload-signals.ts`,
  `src/core/domains/trajectory/codegraph/symbols/payload-signals.ts` —
  `percentilesToCompute` for filter-referenced `pN`.
- `src/core/domains/trajectory/{static,git,codegraph/symbols,composite}/**/rerank/presets/*.ts`
  — hygiene `filter` defaults.
- `src/core/api/internal/ops/explore-ops.ts` — resolve `{presets}` + replace
  semantics + stats at search stage.
- `src/core/api/internal/composition.ts` — assemble + gate filter-preset
  registry.
- `src/core/api/internal/infra/schema-builder.ts` — `filter` param union + names
  enum/resource.
- `src/core/domains/explore/errors.ts` (or `api/errors.ts`) —
  `UnknownFilterPresetError` typed error.

**Modified files (Stream 2):**
`.claude-plugin/tea-rags/skills/{risk-assessment,refactoring-scan,data-driven-generation,extract-project-patterns,analytics-rerank,filter-building,bug-hunt,explore}/SKILL.md`.

---

## Stream 1 — Engine + registry + hygiene defaults

### Task 1: Contract types for filter presets

**Files:**

- Create: `src/core/contracts/types/filter-preset.ts`
- Modify: `src/core/contracts/index.ts`
- Test: none (types only — verified by `tsc` and downstream tasks)

- [ ] **Step 1: Create the types file**

```ts
// src/core/contracts/types/filter-preset.ts
import type { QdrantFilter } from "../../adapters/qdrant/types.js";

/** Percentile keys resolvable from collection Stats. */
export type FilterPercentile = "p10" | "p25" | "p50" | "p75" | "p90" | "p95";

/** A range threshold: a literal number, or an adaptive collection percentile with a mandatory cold-start fallback. */
export type FilterThreshold =
  | number
  | { percentile: FilterPercentile; fallback: number };

/** One raw-signal condition. `signal` is the LOGICAL payload key (e.g. "git.chunk.commitCount", "codegraph.file.instability", "isTest"). */
export interface AdaptiveFilterCondition {
  signal: string;
  op: "gte" | "lte" | "eq";
  /** number/FilterThreshold for range ops (gte/lte); string/boolean for eq match. */
  value: FilterThreshold | string | boolean;
  /** default "must". "should" compiles to a nested must:[{should:[...]}] group (at-least-one-required). */
  occur?: "must" | "should" | "must_not";
}

/** A named, gateable bundle of filter conditions. NOT a RerankPreset (no weights/tools/overlayMask). */
export interface FilterPresetDef {
  readonly name: string;
  readonly description: string;
  /** trajectory keys that must all be registered for this preset to be available, e.g. ["codegraph.symbols"]. */
  readonly requires?: readonly string[];
  readonly conditions: readonly AdaptiveFilterCondition[];
}

/** Value of the user-facing `filter` param and of RerankPreset.filter: raw Qdrant filter OR a named-presets reference. */
export type FilterSpec = QdrantFilter | { presets: string };
```

- [ ] **Step 2: Export from the contracts barrel**

Add to `src/core/contracts/index.ts` (follow the existing
`export type { ... } from "./types/<x>.js";` pattern):

```ts
export type {
  FilterSpec,
  FilterPresetDef,
  AdaptiveFilterCondition,
  FilterThreshold,
  FilterPercentile,
} from "./types/filter-preset.js";
```

- [ ] **Step 3: Verify compile**

Run: `npx tsc --noEmit` Expected: PASS (no errors).

- [ ] **Step 4: Commit**

```bash
git add src/core/contracts/types/filter-preset.ts src/core/contracts/index.ts
git commit -m "feat(contracts): filter-preset types (FilterSpec, FilterPresetDef, AdaptiveFilterCondition)"
```

---

### Task 2: Shared logical→physical payload-key helper

The codegraph logical→physical mapping is currently inline in
`collection-stats.ts` `readPayloadPath` (regex `^codegraph\.(file|chunk)\.(.+)$`
→ `codegraph.symbols.$1.$2`). Extract a pure key-mapping helper so the filter
compiler and stats share ONE source (spec §"Logical vs physical key").

**Files:**

- Modify: `src/core/contracts/signal-utils.ts`
- Test: `tests/core/contracts/signal-utils.test.ts` (append; create if absent)

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/contracts/signal-utils.test.ts
import { describe, expect, it } from "vitest";

import { toPhysicalPayloadKey } from "../../../src/core/contracts/signal-utils.js";

describe("toPhysicalPayloadKey", () => {
  it("maps codegraph logical file key to nested symbols path", () => {
    expect(toPhysicalPayloadKey("codegraph.file.instability")).toBe(
      "codegraph.symbols.file.instability",
    );
  });
  it("maps codegraph logical chunk key to nested symbols path", () => {
    expect(toPhysicalPayloadKey("codegraph.chunk.fanIn")).toBe(
      "codegraph.symbols.chunk.fanIn",
    );
  });
  it("passes git keys through unchanged", () => {
    expect(toPhysicalPayloadKey("git.file.commitCount")).toBe(
      "git.file.commitCount",
    );
  });
  it("passes top-level static keys through unchanged", () => {
    expect(toPhysicalPayloadKey("isTest")).toBe("isTest");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/contracts/signal-utils.test.ts` Expected: FAIL —
`toPhysicalPayloadKey is not a function`.

- [ ] **Step 3: Implement the helper**

Append to `src/core/contracts/signal-utils.ts`:

```ts
/**
 * Map a LOGICAL payload key to its PHYSICAL Qdrant path.
 * Codegraph signals are stored nested as `codegraph.symbols.{scope}.X` but
 * addressed logically as `codegraph.{scope}.X`. git/static keys are already physical.
 * Single source for both collection-stats and the filter-preset compiler.
 */
export function toPhysicalPayloadKey(logicalKey: string): string {
  const m = /^codegraph\.(file|chunk)\.(.+)$/.exec(logicalKey);
  return m ? `codegraph.symbols.${m[1]}.${m[2]}` : logicalKey;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/contracts/signal-utils.test.ts` Expected: PASS.

- [ ] **Step 5: Refactor collection-stats to reuse it**

In `src/core/domains/ingest/infra/collection-stats.ts` `readPayloadPath`,
replace the inline codegraph regex branch with a call to `toPhysicalPayloadKey`
(import from `../../../contracts/signal-utils.js`). Keep behavior identical —
this is a no-behavior-change dedup.

Run: `npx vitest run tests/core/domains/ingest` and confirm existing stats tests
stay green.

- [ ] **Step 6: Commit**

```bash
git add src/core/contracts/signal-utils.ts tests/core/contracts/signal-utils.test.ts src/core/domains/ingest/infra/collection-stats.ts
git commit -m "refactor(signals): extract toPhysicalPayloadKey shared by stats and filter compiler"
```

---

### Task 3: Filter-preset compiler (conditions → QdrantFilter)

The heart of the feature. Compiles `FilterPresetDef.conditions` to a
`QdrantFilter`, resolving adaptive percentiles from Stats (global `perSignal`),
applying fallback, mapping logical→physical keys, and compiling `occur:"should"`
to a nested `must:[{should:[...]}]` group (spec §"Compilation semantics").

**Files:**

- Create: `src/core/domains/trajectory/filter-presets/compiler.ts`
- Test: `tests/core/domains/trajectory/filter-presets/compiler.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/core/domains/trajectory/filter-presets/compiler.test.ts
import { describe, expect, it } from "vitest";

import type { FilterPresetDef } from "../../../../../src/core/contracts/index.js";
import type { CollectionSignalStats } from "../../../../../src/core/contracts/types/trajectory.js";
import { compileFilterPreset } from "../../../../../src/core/domains/trajectory/filter-presets/compiler.js";

const statsWith = (
  key: string,
  pcts: Record<number, number>,
): CollectionSignalStats =>
  ({
    perSignal: new Map([[key, { percentiles: pcts }]]),
  }) as unknown as CollectionSignalStats;

describe("compileFilterPreset", () => {
  it("compiles a literal gte condition into a must range", () => {
    const def: FilterPresetDef = {
      name: "x",
      description: "",
      conditions: [{ signal: "git.chunk.churnRatio", op: "gte", value: 0.8 }],
    };
    expect(compileFilterPreset(def, undefined, "chunk")).toEqual({
      must: [{ key: "git.chunk.churnRatio", range: { gte: 0.8 } }],
    });
  });

  it("resolves an adaptive percentile from stats", () => {
    const def: FilterPresetDef = {
      name: "x",
      description: "",
      conditions: [
        {
          signal: "git.file.commitCount",
          op: "gte",
          value: { percentile: "p75", fallback: 9 },
        },
      ],
    };
    const stats = statsWith("git.file.commitCount", { 75: 14 });
    expect(compileFilterPreset(def, stats, "file")).toEqual({
      must: [{ key: "git.file.commitCount", range: { gte: 14 } }],
    });
  });

  it("falls back when stats are cold / percentile absent", () => {
    const def: FilterPresetDef = {
      name: "x",
      description: "",
      conditions: [
        {
          signal: "git.file.commitCount",
          op: "gte",
          value: { percentile: "p75", fallback: 9 },
        },
      ],
    };
    expect(compileFilterPreset(def, undefined, "file")).toEqual({
      must: [{ key: "git.file.commitCount", range: { gte: 9 } }],
    });
  });

  it("maps codegraph logical key to physical path", () => {
    const def: FilterPresetDef = {
      name: "x",
      description: "",
      conditions: [{ signal: "codegraph.file.isHub", op: "eq", value: true }],
    };
    expect(compileFilterPreset(def, undefined, "file")).toEqual({
      must: [{ key: "codegraph.symbols.file.isHub", match: { value: true } }],
    });
  });

  it("compiles must_not eq into must_not match", () => {
    const def: FilterPresetDef = {
      name: "x",
      description: "",
      conditions: [
        { signal: "isTest", op: "eq", value: true, occur: "must_not" },
      ],
    };
    expect(compileFilterPreset(def, undefined, "chunk")).toEqual({
      must_not: [{ key: "isTest", match: { value: true } }],
    });
  });

  it("compiles a should-group into a nested must:[{should}] (at-least-one)", () => {
    const def: FilterPresetDef = {
      name: "x",
      description: "",
      conditions: [
        {
          signal: "git.file.recencyWeightedFreq",
          op: "gte",
          value: { percentile: "p50", fallback: 1 },
        },
        {
          signal: "git.file.bugFixRate",
          op: "gte",
          value: { percentile: "p75", fallback: 30 },
          occur: "should",
        },
        {
          signal: "git.file.churnVolatility",
          op: "gte",
          value: { percentile: "p75", fallback: 25 },
          occur: "should",
        },
      ],
    };
    expect(compileFilterPreset(def, undefined, "file")).toEqual({
      must: [
        { key: "git.file.recencyWeightedFreq", range: { gte: 1 } },
        {
          should: [
            { key: "git.file.bugFixRate", range: { gte: 30 } },
            { key: "git.file.churnVolatility", range: { gte: 25 } },
          ],
        },
      ],
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
`npx vitest run tests/core/domains/trajectory/filter-presets/compiler.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the compiler**

```ts
// src/core/domains/trajectory/filter-presets/compiler.ts
import type {
  QdrantFilter,
  QdrantFilterCondition,
} from "../../../adapters/qdrant/types.js";
import { toPhysicalPayloadKey } from "../../../contracts/signal-utils.js";
import type {
  AdaptiveFilterCondition,
  FilterPresetDef,
  FilterThreshold,
} from "../../../contracts/types/filter-preset.js";
import type {
  CollectionSignalStats,
  FilterLevel,
} from "../../../contracts/types/trajectory.js";

function resolveThreshold(
  value: FilterThreshold,
  logicalKey: string,
  stats?: CollectionSignalStats,
): number {
  if (typeof value === "number") return value;
  const pct = Number(value.percentile.slice(1));
  const resolved = stats?.perSignal.get(logicalKey)?.percentiles?.[pct];
  return resolved ?? value.fallback;
}

function toCondition(
  c: AdaptiveFilterCondition,
  stats?: CollectionSignalStats,
): QdrantFilterCondition {
  const key = toPhysicalPayloadKey(c.signal);
  if (c.op === "eq") {
    return { key, match: { value: c.value as string | boolean } };
  }
  const n = resolveThreshold(c.value as FilterThreshold, c.signal, stats);
  return { key, range: c.op === "gte" ? { gte: n } : { lte: n } };
}

/**
 * Compile a filter preset's conditions to a QdrantFilter.
 * - adaptive `{percentile, fallback}` resolves from global `stats.perSignal[logicalKey]`, fallback on miss
 * - logical codegraph keys map to physical `codegraph.symbols.*` paths
 * - `occur:"should"` conditions group into a nested `must:[{should:[...]}]` (at-least-one-required)
 */
export function compileFilterPreset(
  def: FilterPresetDef,
  stats: CollectionSignalStats | undefined,
  level: FilterLevel,
): QdrantFilter {
  void level; // reserved for future per-level threshold selection; thresholds are global today
  const must: QdrantFilterCondition[] = [];
  const mustNot: QdrantFilterCondition[] = [];
  const should: QdrantFilterCondition[] = [];
  for (const c of def.conditions) {
    const occur = c.occur ?? "must";
    const cond = toCondition(c, stats);
    if (occur === "must") must.push(cond);
    else if (occur === "must_not") mustNot.push(cond);
    else should.push(cond);
  }
  const filter: QdrantFilter = {};
  const mustGroup: QdrantFilterCondition[] = [...must];
  if (should.length > 0)
    mustGroup.push({ should } as unknown as QdrantFilterCondition);
  if (mustGroup.length > 0) filter.must = mustGroup;
  if (mustNot.length > 0) filter.must_not = mustNot;
  return filter;
}
```

> Note: verify `QdrantFilterCondition` admits a nested `{ should: [...] }`
> member. If the type is strict, widen it minimally in
> `adapters/qdrant/types.ts` (a nested filter clause is valid Qdrant) — add a
> `NestedFilterClause` union member; do NOT cast away the type in production
> code beyond this controlled widening.

- [ ] **Step 4: Run tests to verify they pass**

Run:
`npx vitest run tests/core/domains/trajectory/filter-presets/compiler.test.ts`
Expected: PASS (all 6).

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/trajectory/filter-presets/compiler.ts tests/core/domains/trajectory/filter-presets/compiler.test.ts src/core/adapters/qdrant/types.ts
git commit -m "feat(filters): filter-preset compiler with adaptive percentiles and should-group nesting"
```

---

### Task 4: Static filter presets catalog

**Files:**

- Create:
  `src/core/domains/trajectory/static/filter-presets/{production,core-logic,security-paths}.ts`,
  `.../index.ts`
- Test: `tests/core/domains/trajectory/static/filter-presets.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/domains/trajectory/static/filter-presets.test.ts
import { describe, expect, it } from "vitest";

import { compileFilterPreset } from "../../../../../src/core/domains/trajectory/filter-presets/compiler.js";
import { STATIC_FILTER_PRESETS } from "../../../../../src/core/domains/trajectory/static/filter-presets/index.js";

const byName = (n: string) => STATIC_FILTER_PRESETS.find((p) => p.name === n)!;

describe("static filter presets", () => {
  it("production excludes tests, docs, and block chunks", () => {
    expect(
      compileFilterPreset(byName("production"), undefined, "chunk"),
    ).toEqual({
      must_not: [
        { key: "isTest", match: { value: true } },
        { key: "isDocumentation", match: { value: true } },
        { key: "chunkType", match: { value: "block" } },
      ],
    });
  });
  it("coreLogic requires function|class and excludes tests", () => {
    const f = compileFilterPreset(byName("coreLogic"), undefined, "chunk");
    expect(f.must).toContainEqual({
      key: "chunkType",
      match: { any: ["function", "class"] },
    });
    expect(f.must_not).toContainEqual({
      key: "isTest",
      match: { value: true },
    });
  });
  it("securityPaths is registered with no trajectory requirement", () => {
    expect(byName("securityPaths").requires).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run:
`npx vitest run tests/core/domains/trajectory/static/filter-presets.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the three presets + barrel**

```ts
// src/core/domains/trajectory/static/filter-presets/production.ts
import type { FilterPresetDef } from "../../../../contracts/types/filter-preset.js";

export const productionFilterPreset: FilterPresetDef = {
  name: "production",
  description:
    "Production code only — excludes tests, documentation, and catch-all block chunks.",
  conditions: [
    { signal: "isTest", op: "eq", value: true, occur: "must_not" },
    { signal: "isDocumentation", op: "eq", value: true, occur: "must_not" },
    { signal: "chunkType", op: "eq", value: "block", occur: "must_not" },
  ],
};
```

```ts
// src/core/domains/trajectory/static/filter-presets/core-logic.ts
import type { FilterPresetDef } from "../../../../contracts/types/filter-preset.js";

export const coreLogicFilterPreset: FilterPresetDef = {
  name: "coreLogic",
  description:
    "Only function/class chunks, excluding tests — the meaningful units of code.",
  conditions: [
    // chunkType ∈ {function,class} — eq with array value compiles to match:{any:[...]}
    {
      signal: "chunkType",
      op: "eq",
      value: ["function", "class"] as unknown as string,
    },
    { signal: "isTest", op: "eq", value: true, occur: "must_not" },
  ],
};
```

> The compiler's `eq` branch emits `match: { value }`. For the
> `chunkType ∈ {a,b}` case, extend `toCondition`'s `eq` branch: when `value` is
> an array, emit `match: { any: value }`. Add that branch in Task 3's compiler
> (and a unit test) OR include it here with a compiler tweak + test. Keep ONE
> compiler; if you reach this task before noticing, return to the compiler, add
> the array→`any` branch with a RED test, then resume.

```ts
// src/core/domains/trajectory/static/filter-presets/security-paths.ts
import type { FilterPresetDef } from "../../../../contracts/types/filter-preset.js";

// Static analog of the pathRisk derived signal. Uses segment-boundary path tokens
// (NOT naive substring — see audit bug tea-rags-mcp-21wd) via Qdrant text match on relativePath.
export const securityPathsFilterPreset: FilterPresetDef = {
  name: "securityPaths",
  description:
    "Files on security-sensitive paths (auth, crypto, secrets, tokens, credentials, permissions).",
  conditions: [
    // Implemented as a should-group of relativePath text matches; see resolver note below.
    { signal: "relativePath", op: "eq", value: "auth", occur: "should" },
    { signal: "relativePath", op: "eq", value: "crypto", occur: "should" },
    { signal: "relativePath", op: "eq", value: "secret", occur: "should" },
    { signal: "relativePath", op: "eq", value: "token", occur: "should" },
    { signal: "relativePath", op: "eq", value: "password", occur: "should" },
    { signal: "relativePath", op: "eq", value: "credential", occur: "should" },
    { signal: "relativePath", op: "eq", value: "permission", occur: "should" },
  ],
};
```

> **securityPaths needs path text-matching, not exact eq.** Qdrant
> `match: { text: "..." }` does tokenized substring match on the indexed path.
> Add a `op: "contains"` variant to `AdaptiveFilterCondition` (Task 1 type) and
> a compiler branch emitting `match: { text: value }`, OR reuse the existing
> `globToTextFilter` used by the `pathPattern` static filter
> (`adapters/qdrant/filters/glob.ts`). Preferred: a `contains` op compiling to
> `match: { text }`, grouped via `should` (at-least-one). Update Task 1 type +
> Task 3 compiler + tests accordingly before finishing this task. This keeps
> securityPaths free of the substring-FP class (text match is token-based, not
> raw substring).

```ts
// src/core/domains/trajectory/static/filter-presets/index.ts
import type { FilterPresetDef } from "../../../../contracts/types/filter-preset.js";
import { coreLogicFilterPreset } from "./core-logic.js";
import { productionFilterPreset } from "./production.js";
import { securityPathsFilterPreset } from "./security-paths.js";

export {
  productionFilterPreset,
  coreLogicFilterPreset,
  securityPathsFilterPreset,
};
export const STATIC_FILTER_PRESETS: FilterPresetDef[] = [
  productionFilterPreset,
  coreLogicFilterPreset,
  securityPathsFilterPreset,
];
```

- [ ] **Step 4: Run to verify pass**

Run:
`npx vitest run tests/core/domains/trajectory/static/filter-presets.test.ts`
Expected: PASS. Adjust the `coreLogic`/`securityPaths` expectations to match the
final compiler shape (`any` / `text`).

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/trajectory/static/filter-presets tests/core/domains/trajectory/static/filter-presets.test.ts src/core/contracts/types/filter-preset.ts src/core/domains/trajectory/filter-presets/compiler.ts tests/core/domains/trajectory/filter-presets/compiler.test.ts
git commit -m "feat(filters): static filter presets (production, coreLogic, securityPaths) + array/contains compiler ops"
```

---

### Task 5: Git filter presets catalog

**Files:**

- Create:
  `src/core/domains/trajectory/git/filter-presets/{fresh-legacy-edits,fragile-silo,panic-zone,god-methods}.ts`,
  `.../index.ts`
- Test: `tests/core/domains/trajectory/git/filter-presets.test.ts`

- [ ] **Step 1: Write the failing test** (assert names, `requires: ["git"]`, and
      compiled shape for two representatives)

```ts
// tests/core/domains/trajectory/git/filter-presets.test.ts
import { describe, expect, it } from "vitest";

import { compileFilterPreset } from "../../../../../src/core/domains/trajectory/filter-presets/compiler.js";
import { GIT_FILTER_PRESETS } from "../../../../../src/core/domains/trajectory/git/filter-presets/index.js";

const byName = (n: string) => GIT_FILTER_PRESETS.find((p) => p.name === n)!;

describe("git filter presets", () => {
  it("all require the git trajectory", () => {
    for (const p of GIT_FILTER_PRESETS) expect(p.requires).toContain("git");
  });
  it("godMethods: chunk churnRatio >= 0.8 AND file commitCount >= p50", () => {
    const f = compileFilterPreset(byName("godMethods"), undefined, "chunk");
    expect(f.must).toContainEqual({
      key: "git.chunk.churnRatio",
      range: { gte: 0.8 },
    });
    expect(f.must).toContainEqual({
      key: "git.file.commitCount",
      range: { gte: 5 },
    }); // fallback
  });
  it("panicZone: recency required + at-least-one of bugFix/volatility", () => {
    const f = compileFilterPreset(byName("panicZone"), undefined, "file");
    expect(f.must).toContainEqual({
      key: "git.file.recencyWeightedFreq",
      range: { gte: 1 },
    });
    expect(f.must).toContainEqual({
      should: [
        { key: "git.file.bugFixRate", range: { gte: 30 } },
        { key: "git.file.churnVolatility", range: { gte: 25 } },
      ],
    });
  });
});
```

- [ ] **Step 2: Run to verify fail** —
      `npx vitest run tests/core/domains/trajectory/git/filter-presets.test.ts`
      → module not found.

- [ ] **Step 3: Implement the four presets + barrel** (data from spec catalog)

```ts
// fresh-legacy-edits.ts
import type { FilterPresetDef } from "../../../../contracts/types/filter-preset.js";

export const freshLegacyEditsFilterPreset: FilterPresetDef = {
  name: "freshLegacyEdits",
  description:
    "Old files with a very recent edit — fresh changes in legacy code.",
  requires: ["git"],
  conditions: [
    {
      signal: "git.file.ageDays",
      op: "gte",
      value: { percentile: "p75", fallback: 60 },
    },
    { signal: "git.chunk.ageDays", op: "lte", value: 7 },
  ],
};
// fragile-silo.ts
export const fragileSiloFilterPreset: FilterPresetDef = {
  name: "fragileSilo",
  description:
    "Single-owner files whose chunks churn — bus-factor + instability.",
  requires: ["git"],
  conditions: [
    { signal: "git.file.blameContributorCount", op: "lte", value: 1 },
    {
      signal: "git.chunk.commitCount",
      op: "gte",
      value: { percentile: "p75", fallback: 5 },
    },
  ],
};
// panic-zone.ts
export const panicZoneFilterPreset: FilterPresetDef = {
  name: "panicZone",
  description: "Recently active files with a bug-fix or volatility spike.",
  requires: ["git"],
  conditions: [
    {
      signal: "git.file.recencyWeightedFreq",
      op: "gte",
      value: { percentile: "p50", fallback: 1 },
    },
    {
      signal: "git.file.bugFixRate",
      op: "gte",
      value: { percentile: "p75", fallback: 30 },
      occur: "should",
    },
    {
      signal: "git.file.churnVolatility",
      op: "gte",
      value: { percentile: "p75", fallback: 25 },
      occur: "should",
    },
  ],
};
// god-methods.ts
export const godMethodsFilterPreset: FilterPresetDef = {
  name: "godMethods",
  description:
    "Chunks that absorb most of a busy file's churn — behavioral god-methods.",
  requires: ["git"],
  conditions: [
    { signal: "git.chunk.churnRatio", op: "gte", value: 0.8 },
    {
      signal: "git.file.commitCount",
      op: "gte",
      value: { percentile: "p50", fallback: 5 },
    },
  ],
};
```

```ts
// index.ts
import type { FilterPresetDef } from "../../../../contracts/types/filter-preset.js";
import { fragileSiloFilterPreset } from "./fragile-silo.js";
import { freshLegacyEditsFilterPreset } from "./fresh-legacy-edits.js";
import { godMethodsFilterPreset } from "./god-methods.js";
import { panicZoneFilterPreset } from "./panic-zone.js";

export {
  freshLegacyEditsFilterPreset,
  fragileSiloFilterPreset,
  panicZoneFilterPreset,
  godMethodsFilterPreset,
};
export const GIT_FILTER_PRESETS: FilterPresetDef[] = [
  freshLegacyEditsFilterPreset,
  fragileSiloFilterPreset,
  panicZoneFilterPreset,
  godMethodsFilterPreset,
];
```

- [ ] **Step 4: Run to verify pass** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/trajectory/git/filter-presets tests/core/domains/trajectory/git/filter-presets.test.ts
git commit -m "feat(filters): git filter presets (freshLegacyEdits, fragileSilo, panicZone, godMethods)"
```

---

### Task 6: Codegraph filter presets catalog (gated)

**Files:**

- Create:
  `src/core/domains/trajectory/codegraph/symbols/filter-presets/{hubs,dead-candidates,unstable-core}.ts`,
  `.../index.ts`
- Test: `tests/core/domains/trajectory/codegraph/symbols/filter-presets.test.ts`

- [ ] **Step 1: Write the failing test** — assert
      `requires: ["codegraph.symbols"]`, and `hubs` compiles to physical
      `codegraph.symbols.file.isHub` match; `deadCandidates` includes the lgt4
      caveat in its description.

```ts
import { describe, expect, it } from "vitest";

import { CODEGRAPH_FILTER_PRESETS } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/filter-presets/index.js";
import { compileFilterPreset } from "../../../../../../src/core/domains/trajectory/filter-presets/compiler.js";

const byName = (n: string) =>
  CODEGRAPH_FILTER_PRESETS.find((p) => p.name === n)!;
describe("codegraph filter presets", () => {
  it("all require codegraph.symbols", () => {
    for (const p of CODEGRAPH_FILTER_PRESETS)
      expect(p.requires).toContain("codegraph.symbols");
  });
  it("hubs compiles to physical isHub match", () => {
    expect(compileFilterPreset(byName("hubs"), undefined, "file")).toEqual({
      must: [{ key: "codegraph.symbols.file.isHub", match: { value: true } }],
    });
  });
  it("deadCandidates documents the lgt4 false-positive caveat", () => {
    expect(byName("deadCandidates").description.toLowerCase()).toContain(
      "false positive",
    );
  });
});
```

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement presets + barrel**

```ts
// hubs.ts
export const hubsFilterPreset: FilterPresetDef = {
  name: "hubs",
  description: "Architectural hub files (fanIn above the collection p95).",
  requires: ["codegraph.symbols"],
  conditions: [{ signal: "codegraph.file.isHub", op: "eq", value: true }],
};
// dead-candidates.ts
export const deadCandidatesFilterPreset: FilterPresetDef = {
  name: "deadCandidates",
  description:
    "Function chunks with zero call-graph fan-in — dead-code candidates. Hypothesis generator with false positives (method-edge resolution is approximate, tea-rags-mcp-lgt4); not a verdict.",
  requires: ["codegraph.symbols"],
  conditions: [
    { signal: "codegraph.chunk.fanIn", op: "eq", value: 0 },
    { signal: "chunkType", op: "eq", value: "function" },
  ],
};
// unstable-core.ts
export const unstableCoreFilterPreset: FilterPresetDef = {
  name: "unstableCore",
  description:
    "Highly unstable files with enough edges for the ratio to be meaningful.",
  requires: ["codegraph.symbols"],
  conditions: [
    {
      signal: "codegraph.file.instability",
      op: "gte",
      value: { percentile: "p90", fallback: 0.9 },
    },
    {
      signal: "codegraph.file.connectionCount",
      op: "gte",
      value: { percentile: "p50", fallback: 5 },
    },
  ],
};
```

> `deadCandidates` mixes a codegraph `eq 0` (numeric) with a static
> `chunkType eq function`. The compiler `eq` branch emits `match: { value }` for
> both — numeric `0` is a valid Qdrant match value. Confirm in the test.

Barrel `index.ts` exports `CODEGRAPH_FILTER_PRESETS`.

- [ ] **Step 4: Run to verify pass.**

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/trajectory/codegraph/symbols/filter-presets tests/core/domains/trajectory/codegraph/symbols/filter-presets.test.ts
git commit -m "feat(filters): codegraph filter presets (hubs, deadCandidates, unstableCore)"
```

---

### Task 7: Composite filter presets catalog + gating builder

**Files:**

- Create:
  `src/core/domains/trajectory/composite/filter-presets/{battle-tested,abandoned-hotspots}.ts`,
  `.../index.ts`
- Test: `tests/core/domains/trajectory/composite/filter-presets.test.ts`

- [ ] **Step 1: Write the failing test** — `buildCompositeFilterPresets`
      includes both when `["git","codegraph.symbols"]` registered, drops them
      when `git` absent.

```ts
import { describe, expect, it } from "vitest";

import { buildCompositeFilterPresets } from "../../../../../src/core/domains/trajectory/composite/filter-presets/index.js";

describe("composite filter presets gating", () => {
  it("includes battleTested + abandonedHotspots when git registered", () => {
    const names = buildCompositeFilterPresets(
      new Set(["git", "codegraph.symbols", "static"]),
    ).map((p) => p.name);
    expect(names).toEqual(
      expect.arrayContaining(["battleTested", "abandonedHotspots"]),
    );
  });
  it("drops them when git is not registered", () => {
    expect(buildCompositeFilterPresets(new Set(["static"]))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement presets + gating builder**

```ts
// battle-tested.ts — requires ["git"]
export const battleTestedFilterPreset: FilterPresetDef = {
  name: "battleTested",
  description: "Old, low-bug, multi-author files — trustworthy reference code.",
  requires: ["git"],
  conditions: [
    {
      signal: "git.file.ageDays",
      op: "gte",
      value: { percentile: "p50", fallback: 30 },
    },
    {
      signal: "git.file.bugFixRate",
      op: "lte",
      value: { percentile: "p25", fallback: 10 },
    },
    { signal: "git.file.blameContributorCount", op: "gte", value: 2 },
  ],
};
// abandoned-hotspots.ts — requires ["git"]
export const abandonedHotspotsFilterPreset: FilterPresetDef = {
  name: "abandonedHotspots",
  description:
    "High-churn files that are also old — accumulated, unattended debt.",
  requires: ["git"],
  conditions: [
    {
      signal: "git.file.commitCount",
      op: "gte",
      value: { percentile: "p75", fallback: 9 },
    },
    {
      signal: "git.file.ageDays",
      op: "gte",
      value: { percentile: "p75", fallback: 42 },
    },
  ],
};
```

```ts
// index.ts
import type { FilterPresetDef } from "../../../../contracts/types/filter-preset.js";
import { abandonedHotspotsFilterPreset } from "./abandoned-hotspots.js";
import { battleTestedFilterPreset } from "./battle-tested.js";

export { battleTestedFilterPreset, abandonedHotspotsFilterPreset };
const ALL_COMPOSITE_FILTER_PRESETS: readonly FilterPresetDef[] = [
  battleTestedFilterPreset,
  abandonedHotspotsFilterPreset,
];
/** Filter analog of buildCompositePresets — drop a preset unless every `requires` key is registered. */
export function buildCompositeFilterPresets(
  registeredKeys: ReadonlySet<string>,
): FilterPresetDef[] {
  return ALL_COMPOSITE_FILTER_PRESETS.filter((p) =>
    (p.requires ?? []).every((k) => registeredKeys.has(k)),
  );
}
```

- [ ] **Step 4: Run to verify pass.**

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/trajectory/composite/filter-presets tests/core/domains/trajectory/composite/filter-presets.test.ts
git commit -m "feat(filters): composite filter presets (battleTested, abandonedHotspots) + gating builder"
```

---

### Task 8: Filter-preset registry + resolveFilterPresets on TrajectoryRegistry

Give the registry a name→def map (gated) and a method that resolves a `presets`
CSV to a merged `QdrantFilter` using the compiler + stats.

**Files:**

- Modify: `src/core/contracts/types/trajectory.ts` (registry interface),
  `src/core/domains/trajectory/registry.ts`
- Test: `tests/core/domains/trajectory/registry-filter-presets.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";

import { TrajectoryRegistry } from "../../../../src/core/domains/trajectory/index.js";

// ... construct a registry with static+git filter presets registered (mirror existing registry test setup)
describe("registry.resolveFilterPresets", () => {
  it("resolves a single name to its compiled filter", () => {
    const f = registry.resolveFilterPresets("production", undefined, "chunk");
    expect(f?.must_not).toContainEqual({
      key: "isTest",
      match: { value: true },
    });
  });
  it("AND-merges multiple CSV names", () => {
    const f = registry.resolveFilterPresets(
      "production,godMethods",
      undefined,
      "chunk",
    );
    expect(f?.must).toContainEqual({
      key: "git.chunk.churnRatio",
      range: { gte: 0.8 },
    });
    expect(f?.must_not).toContainEqual({
      key: "isTest",
      match: { value: true },
    });
  });
  it("throws UnknownFilterPresetError on an unknown name", () => {
    expect(() =>
      registry.resolveFilterPresets("nope", undefined, "chunk"),
    ).toThrow(/nope/);
  });
  it("throws on empty / all-empty segments", () => {
    expect(() =>
      registry.resolveFilterPresets(" , ", undefined, "chunk"),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement**

- Add the typed error in `src/core/domains/explore/errors.ts` (extends
  `ExploreError` → `InputValidationError` family per `typed-errors.md`):
  `UnknownFilterPresetError(name: string)`.
- Add a `filterPresets: Map<string, FilterPresetDef>` to the registry, populated
  at construction from the merged gated list (passed in by composition — Task
  13).
- Implement:

```ts
resolveFilterPresets(
  csv: string,
  stats: CollectionSignalStats | undefined,
  level: FilterLevel = "chunk",
): QdrantFilter | undefined {
  const names = csv.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (names.length === 0) throw new EmptyFilterPresetError(csv);
  let merged: QdrantFilter | undefined;
  for (const name of names) {
    const def = this.filterPresets.get(name);
    if (!def) throw new UnknownFilterPresetError(name);
    merged = mergeQdrantFilters(merged, compileFilterPreset(def, stats, level));
  }
  return merged;
}
```

- Add `filterPresetNames(): string[]` (for SchemaBuilder).
- Mirror the method on the registry interface in
  `contracts/types/trajectory.ts`.

- [ ] **Step 4: Run to verify pass.**

- [ ] **Step 5: Commit** (touches `domains/explore/errors.ts` — deep-silo;
      include a `Why:` line)

```bash
git add src/core/domains/trajectory/registry.ts src/core/contracts/types/trajectory.ts src/core/domains/explore/errors.ts tests/core/domains/trajectory/registry-filter-presets.test.ts
git commit -m "feat(filters): registry.resolveFilterPresets (CSV → merged QdrantFilter) + typed errors

Why: registry owns filter-preset resolution alongside buildMergedFilter so the
search stage has one merge authority. UnknownFilterPresetError lives in the
explore error hierarchy (silo file) to keep facade validation typed.
Trade-off: registry gains a stats-dependent method, but stats are passed in
per-call (no new field coupling)."
```

---

### Task 9: percentilesToCompute wiring + validateSignalDependencies extension

Filter presets reference `pN` of raw signals. Those percentiles must be computed
at index time (search-stage resolution has no lazy machinery). Declare them and
validate at composition.

**Files:**

- Modify: `src/core/domains/trajectory/git/payload-signals.ts`,
  `src/core/domains/trajectory/codegraph/symbols/payload-signals.ts`
- Modify: `src/core/domains/ingest/infra/collection-stats.ts`
  (`collectReferencedPercentiles` + `validateSignalDependencies` signature)
- Test: `tests/core/domains/ingest/collection-stats-filter-deps.test.ts`

- [ ] **Step 1: Write the failing test** —
      `validateSignalDependencies(signals, filterPresets)` throws when a filter
      preset references a `pN` the support signal doesn't declare; passes when
      declared.

```ts
import { describe, expect, it } from "vitest";

import type { FilterPresetDef } from "../../../../src/core/contracts/index.js";
import type { PayloadSignalDescriptor } from "../../../../src/core/contracts/types/trajectory.js";
import { validateSignalDependencies } from "../../../../src/core/domains/ingest/infra/collection-stats.js";

describe("validateSignalDependencies — filter percentiles", () => {
  const sig = (key: string, pcts: number[]): PayloadSignalDescriptor =>
    ({
      key,
      type: "number",
      stats: { percentilesToCompute: pcts },
    }) as PayloadSignalDescriptor;
  const preset: FilterPresetDef = {
    name: "x",
    description: "",
    conditions: [
      {
        signal: "git.file.commitCount",
        op: "gte",
        value: { percentile: "p75", fallback: 9 },
      },
    ],
  };
  it("throws when p75 of the support signal is not declared", () => {
    expect(() =>
      validateSignalDependencies([sig("git.file.commitCount", [25])], [preset]),
    ).toThrow(/p75|commitCount/);
  });
  it("passes when p75 is declared", () => {
    expect(() =>
      validateSignalDependencies([sig("git.file.commitCount", [75])], [preset]),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement**

- Extend `validateSignalDependencies` to accept an optional
  `filterPresets: FilterPresetDef[]`. After the existing confidence walk,
  iterate each preset's conditions; for every `{percentile}` value, require the
  referenced signal (by logical key) to declare that `pN` in `stats.labels` keys
  OR `stats.percentilesToCompute`. Throw the existing dependency error type with
  a clear message.
- Add the needed `percentilesToCompute` entries:
  - `git/payload-signals.ts`: `commitCount` → ensure p50, p75; `ageDays` → p50,
    p75; `bugFixRate` → p25, p75; `recencyWeightedFreq` → p50; `churnVolatility`
    → p75. (`blameContributorCount` uses literal thresholds — no `pN` needed.)
  - `codegraph/symbols/payload-signals.ts`: `instability` → p90;
    `connectionCount` → p50. (`isHub` boolean, `fanIn` literal 0 — no `pN`.)
- Confirm whether a `pN` already covered by a signal's `stats.labels` (e.g.
  `commitCount` labels include p75) needs no duplicate — declare only the
  missing ones.

- [ ] **Step 4: Run to verify pass** + run existing collection-stats tests
      green.

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/trajectory/git/payload-signals.ts src/core/domains/trajectory/codegraph/symbols/payload-signals.ts src/core/domains/ingest/infra/collection-stats.ts tests/core/domains/ingest/collection-stats-filter-deps.test.ts
git commit -m "feat(signals): declare filter-referenced percentiles + validate them at composition"
```

> **Reindex note:** new `percentilesToCompute` entries change computed Stats.
> After merge+relink, the tea-rags self-index needs `force_reindex` to populate
> the new percentiles; until then filter thresholds use `fallback`. Real
> projects pick them up on the next full/incremental stats recompute.

---

### Task 10: RerankPreset.filter field

**Files:**

- Modify: `src/core/contracts/types/reranker.ts`
- Test: none (additive optional type; consumed in Tasks 11–12)

- [ ] **Step 1: Add the field**

```ts
import type { FilterSpec } from "./filter-preset.js";

export interface RerankPreset {
  // ...existing fields
  /** Default population for this ranking. Replace semantics: an explicit `filter` param overrides it. */
  readonly filter?: FilterSpec;
}
```

- [ ] **Step 2: Verify compile** — `npx tsc --noEmit` PASS.

- [ ] **Step 3: Commit**

```bash
git add src/core/contracts/types/reranker.ts
git commit -m "feat(contracts): RerankPreset.filter optional default population"
```

---

### Task 11: Search-stage resolution — {presets} + replace semantics + stats

Resolve the `filter` param: if it is `{ presets }`, compile via the registry
with collection Stats; apply replace semantics against the rerank preset's
default `filter`; AND with typed params.

**Files:**

- Modify: `src/core/api/internal/ops/explore-ops.ts` (`buildFilter` +
  `embedAndDispatch` to thread stats + resolved preset)
- Test: `tests/core/api/internal/explore-ops-filter.test.ts`

- [ ] **Step 1: Write the failing test** — drive `buildFilter` (extract a pure
      helper if needed) for: raw passthrough; `{presets:"production"}` →
      compiled; preset default applied when no param; param replaces default;
      `filter:{}` clears default.

```ts
// Pseudostructure — mirror existing explore-ops test harness (mock registry + reranker)
describe("ExploreOps filter resolution", () => {
  it("passes a raw filter through unchanged (merged with typed params)", () => {
    /* ... */
  });
  it("resolves {presets:'production'} via registry + stats", () => {
    /* ... */
  });
  it("applies the rerank preset's default filter when no param is given", () => {
    /* ... */
  });
  it("explicit filter param replaces the preset default", () => {
    /* ... */
  });
  it("filter:{} clears the preset default (unfiltered)", () => {
    /* ... */
  });
});
```

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement**

- Add a pure helper `resolveFilterSpec(spec, presetDefault, stats, level)`:
  - `effective = spec ?? presetDefault` (replace).
  - if `effective` is `{}` → return undefined (cleared).
  - if `"presets" in effective` →
    `registry.resolveFilterPresets(effective.presets, stats, level)`.
  - else → raw `effective` (existing path).
- In `buildFilter`, obtain the resolved rerank preset
  (`this.reranker.getFullPreset(name, tool)?.filter`) and the current
  `collectionStats` (already loaded via `ensureStats`; expose a getter on
  Reranker or pass through `ExploreOps`). Compute the resolved filter, then
  `registry.buildMergedFilter(typedParams, resolvedFilter, level)`.
- Ensure `ensureStats` has run before `buildFilter` so percentiles are
  available; if stats are absent, the compiler uses fallbacks (already handled).

- [ ] **Step 4: Run to verify pass** + existing explore-ops tests green.

- [ ] **Step 5: Commit** (deep-silo `explore-ops.ts` → `Why:` line)

```bash
git add src/core/api/internal/ops/explore-ops.ts tests/core/api/internal/explore-ops-filter.test.ts
git commit -m "feat(explore): resolve {presets} filter at search stage with replace semantics

Why: the filter is built before rerank, so preset-default + {presets} resolution
must happen here with collection Stats in hand. Replace (not merge) keeps the
default-argument mental model. Trade-off: ExploreOps now reads reranker preset
metadata + stats for filter build, a small coupling justified by single merge site."
```

---

### Task 12: Wire hygiene filter defaults onto rerank presets

Set `filter: { presets: "production" }` / `{ presets: "coreLogic" }` on the
rerank presets per the spec default table. Composite overrides mirror their
trajectory presets.

**Files:**

- Modify:
  `git/rerank/presets/{proven,ownership,bug-hunt,tech-debt,hotspots,dangerous,security-audit,recent,stable,...}.ts`
  (only those getting a default),
  `static/rerank/presets/{decomposition,refactoring}.ts`,
  `codegraph`/`composite` presets (`blastRadius`, `architecturalHub`,
  `entryPoint`, composite overrides).
- Test: `tests/core/domains/trajectory/preset-filter-defaults.test.ts`

- [ ] **Step 1: Write the failing test** — assert the exact default-table
      mapping, and the landmines (`relevance`, `documentationRelevance`,
      `onboarding`, `codeReview`, `recent`, `stable` have NO `filter`).

```ts
import { describe, expect, it } from "vitest";

import { GIT_PRESETS } from "../../../../src/core/domains/trajectory/git/rerank/presets/index.js";

// + static + composite preset lists
const all = [
  /* GIT_PRESETS, STATIC_PRESETS, composite */
];
const find = (n: string) => all.find((p) => p.name === n)!;
describe("rerank preset hygiene defaults", () => {
  it.each([
    ["proven", "production"],
    ["ownership", "production"],
    ["bugHunt", "production"],
    ["techDebt", "production"],
    ["hotspots", "production"],
    ["dangerous", "production"],
    ["securityAudit", "production"],
    ["blastRadius", "production"],
    ["architecturalHub", "production"],
    ["entryPoint", "production"],
    ["decomposition", "coreLogic"],
    ["refactoring", "coreLogic"],
  ])("%s defaults to %s", (name, preset) => {
    expect(find(name).filter).toEqual({ presets: preset });
  });
  it.each([
    "relevance",
    "documentationRelevance",
    "onboarding",
    "codeReview",
    "recent",
    "stable",
  ])("%s has no default filter", (name) => {
    expect(find(name).filter).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement** — add
      `readonly filter = { presets: "production" } as const;` (or `"coreLogic"`)
      to each listed preset class. For composite overrides
      (`HotspotsCompositePreset`, `TechDebtCompositePreset`,
      `DangerousCompositePreset`, `OwnershipCompositePreset`,
      `SecurityAuditCompositePreset`, `CodeReviewCompositePreset`) mirror the
      trajectory preset's default (codeReview composite → none, matching
      codeReview landmine).

- [ ] **Step 4: Run to verify pass** + full preset test suite green.

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/trajectory/*/rerank/presets src/core/domains/trajectory/composite/presets tests/core/domains/trajectory/preset-filter-defaults.test.ts
git commit -m "feat(presets): hygiene filter defaults on risk/structural rerank presets"
```

---

### Task 13: Composition assembly + gating

**Files:**

- Modify: `src/core/api/internal/composition.ts`
- Test: `tests/core/api/composition-filter-presets.test.ts`

- [ ] **Step 1: Write the failing test** — composition exposes a gated
      filter-preset list: codegraph presets present only when
      `codegraph.symbols` registered; composite presets only when their
      `requires` met.

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement** — in `createComposition`, build:

```ts
const registeredKeys = new Set(registry.getRegisteredKeys());
const filterPresets = [
  ...STATIC_FILTER_PRESETS,
  ...(registeredKeys.has("git") ? GIT_FILTER_PRESETS : []),
  ...(registeredKeys.has("codegraph.symbols") ? CODEGRAPH_FILTER_PRESETS : []),
  ...buildCompositeFilterPresets(registeredKeys),
];
```

Pass `filterPresets` into the `TrajectoryRegistry` (constructor or setter) so
`resolveFilterPresets`/`filterPresetNames` see them. Call
`validateSignalDependencies(allPayloadSignalDescriptors, filterPresets)` (Task 9
signature). Expose `filterPresetNames` for SchemaBuilder.

> Trajectory-owned `*_FILTER_PRESETS` are imported by composition, mirroring how
> presets are assembled. Per domain-boundary rules composition is the
> composition root and may import from trajectories.

- [ ] **Step 4: Run to verify pass.**

- [ ] **Step 5: Commit**

```bash
git add src/core/api/internal/composition.ts tests/core/api/composition-filter-presets.test.ts
git commit -m "feat(api): assemble + gate filter-preset registry in composition"
```

---

### Task 14: SchemaBuilder filter param union + names discovery

**Files:**

- Modify: `src/core/api/internal/infra/schema-builder.ts`
- Test: `tests/core/api/schema-builder-filter.test.ts`

- [ ] **Step 1: Write the failing test** — the generated `filter` schema accepts
      a raw object AND `{ presets: string }`;
      `buildFilterPresetNames()`/resource lists the registered names.

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement** — extend the `filter` Zod schema to a union
      `z.union([rawFilterSchema, z.object({ presets: z.string() })])`. Surface
      filter-preset names in the param `.describe(...)` and as an MCP resource
      (mirror how preset names are exposed). CSV-of-enum is not natively
      expressible — keep `presets` a `z.string()`; segment validation happens at
      resolution (Task 8). Edit strictly test-first (file recently churned).

- [ ] **Step 4: Run to verify pass.**

- [ ] **Step 5: Commit**

```bash
git add src/core/api/internal/infra/schema-builder.ts tests/core/api/schema-builder-filter.test.ts
git commit -m "feat(mcp): filter param union (raw | {presets}) + filter-preset name discovery"
```

---

### Task 15: End-to-end error handling

**Files:**

- Modify: `src/core/api/internal/facades/explore-facade.ts` (or the validator
  layer) — surface `UnknownFilterPresetError` / `EmptyFilterPresetError` through
  the MCP error middleware.
- Test: `tests/core/api/explore-filter-errors.test.ts`

- [ ] **Step 1: Write the failing test** — a search with
      `filter:{presets:"nope"}` throws `UnknownFilterPresetError`;
      `filter:{presets:""}` throws `EmptyFilterPresetError`; both are typed (not
      plain `Error`).

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement** — ensure the errors thrown in `resolveFilterPresets`
      propagate as typed `InputValidationError` subclasses (no try/catch in MCP
      handlers per `typed-errors.md`; rely on `errorHandlerMiddleware`). Add
      validation messages naming the offending segment + listing valid names.

- [ ] **Step 4: Run to verify pass.**

- [ ] **Step 5: Commit**

```bash
git add src/core/api/internal/facades/explore-facade.ts tests/core/api/explore-filter-errors.test.ts
git commit -m "feat(api): typed errors for unknown/empty filter preset names"
```

---

### Task 16: Changelog, version bump, full gate

**Files:**

- Modify: `CHANGELOG`/release notes, `package.json` version (minor — `feat`).

- [ ] **Step 1: Run the full quality gate**

Run: `npx vitest run` then `npx tsc --noEmit` then `npx eslint .` Expected: all
green, 0 type errors, 0 lint errors.

- [ ] **Step 2: Changelog entry** — `feat(presets)`: named filter presets via
      `filter:{presets}`, hygiene defaults on risk/structural rerank presets
      (BREAKING-adjacent: those presets now exclude tests/docs/block — note it
      as behavior change). Specific filter presets available via `{presets}` and
      skill-applied.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG* package.json
git commit -m "chore(release): filter presets feat(presets)"
```

- [ ] **Step 4: MCP integration validation** — follow `.claude/CLAUDE.md` npm
      link workflow: build + link worktree, reconnect MCP,
      `force_reindex project=tea-rags` (new percentiles), then exercise
      `semantic_search filter:{presets:"production"}` and `rerank:"techDebt"`
      (hygiene default applied), confirm overlays/results. Record outcomes.

---

## Stream 2 — Skill teaching (depends on Stream 1 merged + linked)

Each task edits one SKILL.md. No vitest; acceptance = the skill's documented
calls match the per-skill policy (spec §"Skill integration"). Per "no silent
skill patches", each edit states what/why/how in the commit body.

### Task 17: risk-assessment — apply specific filters per dimension

**Files:** `.claude-plugin/tea-rags/skills/risk-assessment/SKILL.md`

- [ ] **Step 1** — In the per-dimension scan (currently `rank_chunks` ×4
      presets), add `filter:{presets:"<specific>"}` per dimension:
      hotspots→`godMethods`, techDebt→`abandonedHotspots`,
      dangerous→`fragileSilo`, bugHunt-dim→`panicZone`. Document: empty
      dimension → report "clean", do NOT widen. Note the manual two-pass dedup
      can be reduced since populations are pre-narrowed (keep it as a fallback,
      don't delete the guidance wholesale).
- [ ] **Step 2** — Verify the skill still resolves scope (pathPattern) and that
      `{presets}` composes (AND) with pathPattern.
- [ ] **Step 3: Commit**
      `docs(skills): risk-assessment applies specific filter presets per dimension`.

### Task 18: refactoring-scan — godMethods/coreLogic with empty-widen

**Files:** `.claude-plugin/tea-rags/skills/refactoring-scan/SKILL.md`

- [ ] **Step 1** — Apply `{presets:"godMethods"}` (or `coreLogic`) to the scan;
      if a query is present and the strict result is empty, widen to `coreLogic`
      only and note the widening.
- [ ] **Step 2: Commit**
      `docs(skills): refactoring-scan applies godMethods/coreLogic with empty-widen`.

### Task 19: reference-lookup skills — battleTested with relaxation

**Files:** `.claude-plugin/tea-rags/skills/data-driven-generation/SKILL.md`,
`.claude-plugin/tea-rags/skills/extract-project-patterns/SKILL.md`

- [ ] **Step 1** — Where these use `proven`, add `{presets:"battleTested"}`; on
      empty, relax specific → `production` and annotate (a reference is
      required).
- [ ] **Step 2: Commit**
      `docs(skills): reference-lookup skills apply battleTested with relax-on-empty`.

### Task 20: meta/teaching skills — document filter presets

**Files:** `.claude-plugin/tea-rags/skills/analytics-rerank/SKILL.md`,
`.claude-plugin/tea-rags/skills/filter-building/SKILL.md`

- [ ] **Step 1 (analytics-rerank)** — Document the named filter presets,
      `{presets}` shorthand, adaptive-percentile semantics, and the
      inventory-vs-query narrowing rule. Replace the manual
      `securityAudit + pathPattern:"**/auth/**"` example with
      `securityAudit + {presets:"securityPaths"}`.
- [ ] **Step 2 (filter-building)** — Document the `{presets}` shorthand and how
      it AND-composes with typed params + raw filter; cross-reference the
      catalog.
- [ ] **Step 3: Commit**
      `docs(skills): document filter presets in analytics-rerank + filter-building`.

### Task 21: query-driven skills — bug-hunt audit-mode note, explore unchanged

**Files:** `.claude-plugin/tea-rags/skills/bug-hunt/SKILL.md`,
`.claude-plugin/tea-rags/skills/explore/SKILL.md`

- [ ] **Step 1 (bug-hunt)** — Keep `rerank:"bugHunt"` ranking UNCHANGED
      (preserves fresh-bug recall). Add a short "audit mode (optional)" note:
      `{presets:"panicZone"}` for query-absent risk scans, with the explicit
      warning that symptom search must NOT hard-narrow. (Open decision: this
      note vs. deferring entirely to risk-assessment — default to including a
      brief note.)
- [ ] **Step 2 (explore)** — Add a one-line note that filter presets are
      available but explore stays broad (no specific filter); no behavioral
      change.
- [ ] **Step 3: Commit**
      `docs(skills): bug-hunt audit-mode note + explore filter-preset note`.

---

## Self-Review (completed by plan author)

**Spec coverage:** interface (T1, T11, T14) · RerankPreset.filter + replace
(T10, T11) · FilterPresetDef + adaptive conditions + should-nesting (T1, T3) ·
adaptive resolution + global percentile (T3) · percentilesToCompute + validation
(T9) · logical→physical (T2, T3) · directory layout + barrels (T4–T7) · catalog
incl. securityPaths (T4–T7) · hygiene defaults table (T12) · skill integration
full taxonomy (T17–T21) · SchemaBuilder union (T14) · rollout B2 + reindex note
(T9, T16) · error handling (T8, T15) · testing (each task). The per-language
percentile follow-up (spec §infra-req-1) is intentionally NOT in this plan
(documented follow-up).

**Placeholder scan:** the two compiler-extension notes (array→`any`,
`contains`→`text`) in Task 4 are explicit "return to the compiler and add with a
RED test" instructions, not deferrals — the array/contains ops are real, named,
and tested.

**Type consistency:**
`FilterSpec`/`FilterPresetDef`/`AdaptiveFilterCondition`/`FilterThreshold` (T1)
used identically in T3/T8/T10/T11; `compileFilterPreset(def, stats, level)` and
`resolveFilterPresets(csv, stats, level)` signatures stable across
T3/T8/T11/T13; `toPhysicalPayloadKey` (T2) used in T3 + collection-stats.

---

## Beads epic

Before Task 1, create the paired epic and tasks:

```bash
bd dolt pull
bd create "Filter presets: adaptive {presets} filter param + hygiene defaults + skill teaching" --type=epic --priority=1
# Stream 1 tasks (T1–T16) depend on the epic; T17–T21 (Stream 2) depend on T16 (stream 1 complete).
```

Label Stream 1 tasks `presets`/`filters`/`api` as appropriate; Stream 2 tasks
`beads`/`skills`. Add a blocking dep from each Stream 2 task to the Stream 1
completion task (T16).
