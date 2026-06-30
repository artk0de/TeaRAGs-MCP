# Dynamic-Dispatch Fan-out Precision Narrowing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Narrow untyped Ruby short-name dispatch candidate sets (`x.account`
fans to 80 in-project definers) via a vocabulary + arity + visibility cascade in
a language-neutral kernel engine, so navigation reaches THE definition or an
honest hole, never N false candidates.

**Architecture:** A `DispatchCandidateNarrower` cascade + consumer-split
terminal in `domains/language/kernel` (neutral, mirrors `ConeDispatchResolver` +
injected primitives). New optional substrate fields (`SymbolDefinition.arity` /
`visibility`, `CallRef.argCount`) are populated by the Ruby walker and consumed
by the engine. `RubyDynamicDispatchResolver` injects a Ruby duck vocabulary and
routes its untyped fan-out tail through the engine. A query-side
edgeKind/confidence filter hides the irreducible residual from navigation while
analytics keeps the in-project edges.

**Tech Stack:** TypeScript, vitest, tree-sitter-ruby (walker), DuckDB (edge
columns `edge_kind` + `confidence` already persisted via migration 006).

## Global Constraints

- PRECISION refactor: the typed CHA cone (`edgeKind: "cone"` / `"poly-base"`,
  bead 2jet), `exact` edges, and EVERY non-fan-out receiver kind stay
  BYTE-IDENTICAL. Only the untyped short-name fan-out tail of
  `RubyDynamicDispatchResolver.resolveDispatch` (the `candidates.map(→edge)` at
  lines 108-120) changes.
- Existing business-logic tests stay green UNTOUCHED (move OK, rewrite NO). New
  entities (narrowers, kernel engine, navigation filter, walker capture) get NEW
  red-green unit tests.
- Conservatism invariant: a narrower drops a candidate ONLY on PROVEN
  incompatibility (`argCount` outside the arity envelope, or
  `visibility === "private"` under an explicit receiver). Missing `arity` /
  `visibility` / `argCount` ⇒ KEEP the candidate.
- Substrate fields are ADDITIVE OPTIONAL — zero change to any existing reader of
  `SymbolDefinition` / `CallRef` / `FileExtraction`.
- Consumer-split terminal: `survivors === 1` → one `dynamic` edge confidence
  `1.0` (navigation + analytics); `survivors > 1` → in-project fan-out
  confidence `discount/m` (analytics counts; navigation hides);
  `survivors === 0` → `[]`.
- Navigation filter: show `dynamic` edges only at `confidence === 1.0`; ALWAYS
  show `cone` / `exact` / `poly-base`.
- `dynamic` + `chain` + `ivar` receiver kinds all converge on the same untyped
  `candidates.map` tail — the single cascade covers all three; no per-kind code.
- External-safety: candidates are `isRubyPath`-filtered (in-project) before the
  cascade — the residual kept for analytics never creates external fanIn/fanOut.
- Each task = own commit (conventional commits; header ≤100, body/footer lines
  ≤100).

---

### Task 1: Neutral substrate contract fields

**Files:**

- Modify: `src/core/contracts/types/codegraph.ts` (add `AritySignature`;
  `SymbolDefinition.arity?` + `visibility?`; `CallRef.argCount?`)
- Test: `tests/core/contracts/types/arity-signature.test.ts`

**Interfaces:**

- Produces:
  - `AritySignature = { minRequired: number; maxPositional: number; hasSplat: boolean }`
  - `SymbolDefinition.arity?: AritySignature`
  - `SymbolDefinition.visibility?: "public" | "private" | "protected"`
  - `CallRef.argCount?: number`

**Context:** `SymbolDefinition` (currently
`{ symbolId, fqName, shortName, relPath, scope }`) is the `lookupByShortName`
row; `CallRef` is the call site. Both live in the highest-blast contract hub
(transitiveImpact 20) — the fields MUST be additive optional so no existing
reader changes.

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/contracts/types/arity-signature.test.ts
import { describe, expect, it } from "vitest";

import type {
  AritySignature,
  CallRef,
  SymbolDefinition,
} from "../../../../src/core/contracts/types/codegraph.js";

describe("xlnub substrate fields", () => {
  it("AritySignature carries the positional arity envelope", () => {
    const a: AritySignature = {
      minRequired: 1,
      maxPositional: 2,
      hasSplat: false,
    };
    expect(a.minRequired).toBe(1);
    expect(a.maxPositional).toBe(2);
    expect(a.hasSplat).toBe(false);
  });

  it("SymbolDefinition.arity/visibility are OPTIONAL (legacy row still valid)", () => {
    const legacy: SymbolDefinition = {
      symbolId: "A#m",
      fqName: "A#m",
      shortName: "m",
      relPath: "a.rb",
      scope: ["A"],
    };
    expect(legacy.arity).toBeUndefined();
    expect(legacy.visibility).toBeUndefined();
    const enriched: SymbolDefinition = {
      ...legacy,
      arity: { minRequired: 0, maxPositional: 0, hasSplat: false },
      visibility: "private",
    };
    expect(enriched.visibility).toBe("private");
  });

  it("CallRef.argCount is OPTIONAL", () => {
    const call: CallRef = {
      callText: "x.m(1)",
      receiver: "x",
      member: "m",
      startLine: 1,
      argCount: 1,
    };
    expect(call.argCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run tests/core/contracts/types/arity-signature.test.ts`
Expected: FAIL — `arity` / `visibility` / `argCount` not on the types.

- [ ] **Step 3: Add the fields**

In `src/core/contracts/types/codegraph.ts` add (near `SymbolDefinition`):

```ts
/** Positional-arity envelope of a method definition (bd xlnub). `maxPositional`
 *  is required+optional positional params; `hasSplat` (a `*args` rest param)
 *  makes the upper bound unbounded. Kwargs / block params do NOT affect it. */
export interface AritySignature {
  minRequired: number;
  maxPositional: number;
  hasSplat: boolean;
}
```

Extend `SymbolDefinition` with `arity?: AritySignature;` and
`visibility?: "public" | "private" | "protected";`. Extend `CallRef` with
`argCount?: number;` (positional argument count at the call site). All optional.

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run tests/core/contracts/types/arity-signature.test.ts`
Expected: PASS. Also `npx tsc --noEmit` clean (additive optional → no reader
breaks).

- [ ] **Step 5: Commit**

```bash
git add src/core/contracts/types/codegraph.ts tests/core/contracts/types/arity-signature.test.ts
git commit -m "feat(contracts): additive arity/visibility/argCount substrate for dispatch narrowing (xlnub)"
```

---

### Task 2: Ruby walker capture (def-site arity + visibility, call-site argCount)

**Files:**

- Modify: `src/core/domains/language/ruby/walker/walker.ts` (emit arity +
  visibility per method def; argCount per call)
- Modify: `src/core/domains/trajectory/codegraph/symbols/symbol-table.ts`
  (thread `arity` + `visibility` into the built `SymbolDefinition`)
- Modify the `FileExtraction` symbol record shape if the per-method record does
  not yet carry these (additive optional, in `contracts/types/codegraph.ts`)
- Test: `tests/core/domains/language/ruby/walker/ruby-walker-arity.test.ts`

**Interfaces:**

- Consumes: `AritySignature`, `SymbolDefinition.arity/visibility`,
  `CallRef.argCount` (Task 1).
- Produces: the walker now populates `argCount` on every `CallRef` it emits and
  attaches `arity` + `visibility` to every method symbol; `lookupByShortName`
  returns `SymbolDefinition` rows carrying `arity` + `visibility` where Ruby.

**Context — tree-sitter-ruby nodes:**

- Method def: `method` (instance) / `singleton_method` (class-level). Params are
  the `method_parameters` child; per-param node kinds: `identifier` = required
  positional; `optional_parameter` = positional with default; `splat_parameter`
  = `*args` (⇒ `hasSplat`); `keyword_parameter` / `hash_splat_parameter` =
  kwargs (IGNORE for positional arity); `block_parameter` = `&blk` (IGNORE). So
  `minRequired` = count of `identifier`; `maxPositional` = `identifier` +
  `optional_parameter` count; `hasSplat` = any `splat_parameter`.
- Visibility is STATEFUL in the class body, evaluated in source order: a bare
  `private` / `protected` / `public` call (an `identifier`/`call` with no args)
  switches the default for subsequent defs; the inline form `private def foo`
  and the symbol form `private :foo, :bar` mark specific methods. Track a
  `currentVisibility` (default `"public"`) while walking the class body in
  order.
- Call argCount: at a call node (`call` / `method_call`) the `argument_list`
  child's element count, EXCLUDING `block`/`do_block` and EXCLUDING `pair`
  (kwarg) nodes — positional args only. No `argument_list` ⇒ `argCount` 0.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/core/domains/language/ruby/walker/ruby-walker-arity.test.ts
import { describe, expect, it } from "vitest";

import { extractFromRubyFile } from "../../../../../../src/core/domains/language/ruby/walker/walker.js";

function symByShort(ex: ReturnType<typeof extractFromRubyFile>, short: string) {
  // locate the emitted method symbol by short name in whatever symbol surface
  // FileExtraction exposes (chunks[].symbolId / fileScope) — assert on its
  // attached arity/visibility.
  return ex; // implementer: return the concrete symbol record
}

describe("ruby walker arity/visibility/argCount capture (xlnub)", () => {
  it("required + optional + splat arity", () => {
    const src = `class A\n  def m(a, b = 1, *rest)\n  end\nend\n`;
    const ex = extractFromRubyFile({ relPath: "a.rb", source: src } as never);
    // expect the symbol A#m to carry arity { minRequired: 1, maxPositional: 2, hasSplat: true }
    // (implementer asserts on the real symbol record)
    expect(ex).toBeTruthy();
  });

  it("private mode switch marks subsequent defs private; public default before", () => {
    const src = `class A\n  def pub; end\n  private\n  def priv; end\nend\n`;
    // expect A#pub visibility "public", A#priv visibility "private"
  });

  it("inline private def form", () => {
    const src = `class A\n  private def secret; end\nend\n`;
    // expect A#secret visibility "private"
  });

  it("call-site positional argCount excludes block and kwargs", () => {
    const src = `class A\n  def go(x)\n    x.perform(1, 2, key: 3) { }\n  end\nend\n`;
    const ex = extractFromRubyFile({ relPath: "a.rb", source: src } as never);
    // expect the CallRef for member "perform" to carry argCount 2
    expect(ex).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run:
`npx vitest run tests/core/domains/language/ruby/walker/ruby-walker-arity.test.ts`
Expected: FAIL — fields unpopulated.

- [ ] **Step 3: Implement the capture**

In `walker.ts`: when emitting a `method` / `singleton_method` symbol, compute
`AritySignature` from its `method_parameters` (counts above) and attach the
current `visibility`; maintain `currentVisibility` across the class-body walk
(bare `private`/`protected`/`public` switch; inline `private def`; `private :x`
symbol form). When building each `CallRef`, set `argCount` from the call's
positional `argument_list` count. In `symbol-table.ts`, pass the walker's
`arity` + `visibility` through into the constructed `SymbolDefinition`. Add the
optional carrier field(s) to the `FileExtraction` symbol record if absent
(additive optional). Keep `collectRubyCalls` additive — do not restructure the
god-function; only attach the new fields where symbols/calls are already built.

- [ ] **Step 4: Run the tests, verify they pass; existing walker tests green**

Run: `npx vitest run tests/core/domains/language/ruby/walker/` Expected: new
tests PASS; ALL pre-existing ruby-walker tests still PASS UNTOUCHED.

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/language/ruby/walker/walker.ts \
  src/core/domains/trajectory/codegraph/symbols/symbol-table.ts \
  src/core/contracts/types/codegraph.ts \
  tests/core/domains/language/ruby/walker/ruby-walker-arity.test.ts
git commit -m "feat(chunker): ruby walker captures method arity/visibility + call argCount (xlnub)"
```

---

### Task 3: Kernel narrowing engine (neutral)

**Files:**

- Create: `src/core/domains/language/kernel/dispatch-narrowing.ts`
- Test: `tests/core/domains/language/kernel/dispatch-narrowing.test.ts`

**Interfaces:**

- Consumes: `CallRef`, `CallContext`, `SymbolDefinition`, `DispatchEdge`,
  `AritySignature` (Task 1).
- Produces:
  - `interface DispatchCandidateNarrower { narrow(call, candidates, ctx): SymbolDefinition[] }`
  - `class ArityNarrower implements DispatchCandidateNarrower`
  - `class VisibilityNarrower implements DispatchCandidateNarrower`
  - `class DuckVocabularyNarrower implements DispatchCandidateNarrower` (ctor:
    `ReadonlySet<string>`)
  - `function resolveNarrowedFanout(call, candidates, ctx, narrowers, discount): DispatchEdge[]`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/core/domains/language/kernel/dispatch-narrowing.test.ts
import { describe, expect, it } from "vitest";

import type {
  CallRef,
  SymbolDefinition,
} from "../../../../../src/core/contracts/types/codegraph.js";
import {
  ArityNarrower,
  DuckVocabularyNarrower,
  resolveNarrowedFanout,
  VisibilityNarrower,
} from "../../../../../src/core/domains/language/kernel/dispatch-narrowing.js";

const def = (
  id: string,
  arity?: SymbolDefinition["arity"],
  visibility?: SymbolDefinition["visibility"],
): SymbolDefinition => ({
  symbolId: id,
  fqName: id,
  shortName: id.split("#")[1] ?? id,
  relPath: `${id}.rb`,
  scope: [],
  arity,
  visibility,
});
const call = (member: string, argCount?: number): CallRef => ({
  callText: `x.${member}`,
  receiver: "x",
  member,
  startLine: 1,
  argCount,
});
const ctx = {} as never;

describe("ArityNarrower", () => {
  it("drops a candidate whose minRequired exceeds argCount", () => {
    const cands = [
      def("A#m", { minRequired: 2, maxPositional: 2, hasSplat: false }),
      def("B#m", { minRequired: 0, maxPositional: 1, hasSplat: false }),
    ];
    expect(
      new ArityNarrower()
        .narrow(call("m", 1), cands, ctx)
        .map((c) => c.symbolId),
    ).toEqual(["B#m"]);
  });
  it("drops a candidate whose argCount exceeds maxPositional without splat", () => {
    const cands = [
      def("A#m", { minRequired: 0, maxPositional: 1, hasSplat: false }),
      def("B#m", { minRequired: 0, maxPositional: 0, hasSplat: true }),
    ];
    expect(
      new ArityNarrower()
        .narrow(call("m", 3), cands, ctx)
        .map((c) => c.symbolId),
    ).toEqual(["B#m"]);
  });
  it("keeps candidates with no recorded arity OR a call with no argCount", () => {
    const cands = [
      def("A#m"),
      def("B#m", { minRequired: 5, maxPositional: 5, hasSplat: false }),
    ];
    expect(
      new ArityNarrower().narrow(call("m", undefined), cands, ctx).length,
    ).toBe(2); // no argCount → keep all
    expect(
      new ArityNarrower().narrow(call("m", 0), [def("A#m")], ctx).length,
    ).toBe(1); // no arity → keep
  });
});

describe("VisibilityNarrower", () => {
  it("drops private candidates under explicit receiver, keeps protected/public/unknown", () => {
    const cands = [
      def("A#m", undefined, "private"),
      def("B#m", undefined, "protected"),
      def("C#m", undefined, "public"),
      def("D#m"),
    ];
    expect(
      new VisibilityNarrower()
        .narrow(call("m"), cands, ctx)
        .map((c) => c.symbolId),
    ).toEqual(["B#m", "C#m", "D#m"]);
  });
});

describe("DuckVocabularyNarrower", () => {
  it("empties the set when member is in the vocabulary", () => {
    const n = new DuckVocabularyNarrower(new Set(["to_s", "each"]));
    expect(n.narrow(call("to_s"), [def("A#to_s")], ctx)).toEqual([]);
    expect(n.narrow(call("perform"), [def("A#perform")], ctx).length).toBe(1);
  });
});

describe("resolveNarrowedFanout terminal", () => {
  const arity0 = { minRequired: 0, maxPositional: 0, hasSplat: false };
  it("1 survivor → one edge confidence 1.0", () => {
    const edges = resolveNarrowedFanout(
      call("m", 1),
      [
        def("A#m", { minRequired: 1, maxPositional: 1, hasSplat: false }),
        def("B#m", arity0),
      ],
      ctx,
      [new ArityNarrower()],
      0.3,
    );
    expect(edges).toEqual([
      {
        sourceSymbolId: null,
        targetRelPath: "A#m.rb",
        targetSymbolId: "A#m",
        edgeKind: "dynamic",
        confidence: 1.0,
      },
    ]);
  });
  it("m>1 survivors → m edges confidence discount/m", () => {
    const edges = resolveNarrowedFanout(
      call("m"),
      [def("A#m"), def("B#m")],
      ctx,
      [],
      0.3,
    );
    expect(edges.map((e) => e.confidence)).toEqual([0.15, 0.15]);
    expect(edges.every((e) => e.edgeKind === "dynamic")).toBe(true);
  });
  it("0 survivors → []", () => {
    expect(
      resolveNarrowedFanout(
        call("to_s"),
        [def("A#to_s")],
        ctx,
        [new DuckVocabularyNarrower(new Set(["to_s"]))],
        0.3,
      ),
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run:
`npx vitest run tests/core/domains/language/kernel/dispatch-narrowing.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the engine**

```ts
// src/core/domains/language/kernel/dispatch-narrowing.ts
import type {
  CallContext,
  CallRef,
  DispatchEdge,
  SymbolDefinition,
} from "../../../contracts/types/codegraph.js";

/** A candidate filter in the untyped-dispatch narrowing cascade (bd xlnub).
 *  Drops a candidate ONLY on PROVEN incompatibility; missing evidence ⇒ keep. */
export interface DispatchCandidateNarrower {
  narrow(
    call: CallRef,
    candidates: SymbolDefinition[],
    ctx: CallContext,
  ): SymbolDefinition[];
}

/** Keep `c` iff its positional arity can accept `call.argCount`. */
export class ArityNarrower implements DispatchCandidateNarrower {
  narrow(call: CallRef, candidates: SymbolDefinition[]): SymbolDefinition[] {
    const n = call.argCount;
    if (n === undefined) return candidates;
    return candidates.filter((c) => {
      const a = c.arity;
      if (!a) return true;
      if (n < a.minRequired) return false;
      if (!a.hasSplat && n > a.maxPositional) return false;
      return true;
    });
  }
}

/** Explicit-receiver call cannot reach a `private` method → drop those. */
export class VisibilityNarrower implements DispatchCandidateNarrower {
  narrow(_call: CallRef, candidates: SymbolDefinition[]): SymbolDefinition[] {
    return candidates.filter((c) => c.visibility !== "private");
  }
}

/** Members in the language duck/runtime vocabulary are never short-name
 *  resolvable to a meaningful in-project target → empty the whole fan-out. */
export class DuckVocabularyNarrower implements DispatchCandidateNarrower {
  constructor(private readonly vocab: ReadonlySet<string>) {}
  narrow(call: CallRef, candidates: SymbolDefinition[]): SymbolDefinition[] {
    return this.vocab.has(call.member) ? [] : candidates;
  }
}

const edgeFor = (c: SymbolDefinition, confidence: number): DispatchEdge => ({
  sourceSymbolId: null,
  targetRelPath: c.relPath,
  targetSymbolId: c.symbolId,
  edgeKind: "dynamic",
  confidence,
});

/** Run the cascade, then the consumer-split terminal: 1 survivor → one edge
 *  confidence 1.0; m>1 → m edges confidence discount/m; 0 → []. */
export function resolveNarrowedFanout(
  call: CallRef,
  candidates: SymbolDefinition[],
  ctx: CallContext,
  narrowers: DispatchCandidateNarrower[],
  discount: number,
): DispatchEdge[] {
  let survivors = candidates;
  for (const narrower of narrowers) {
    survivors = narrower.narrow(call, survivors, ctx);
    if (survivors.length === 0) return [];
  }
  if (survivors.length === 1) return [edgeFor(survivors[0], 1.0)];
  const confidence = discount / survivors.length;
  return survivors.map((c) => edgeFor(c, confidence));
}
```

Add `dispatch-narrowing` exports to the kernel barrel if one exists
(`domains/language/kernel/index.ts`).

- [ ] **Step 4: Run the tests, verify they pass**

Run:
`npx vitest run tests/core/domains/language/kernel/dispatch-narrowing.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/language/kernel/dispatch-narrowing.ts \
  tests/core/domains/language/kernel/dispatch-narrowing.test.ts
git commit -m "feat(language): neutral dispatch-candidate narrowing kernel engine (xlnub)"
```

---

### Task 4: Ruby integration — route the untyped fan-out through the engine

**Files:**

- Create:
  `src/core/domains/language/ruby/resolver/strategies/ruby-duck-vocabulary.ts`
  (`RUBY_DUCK_VOCAB: ReadonlySet<string>`)
- Modify:
  `src/core/domains/language/ruby/resolver/strategies/ruby-dynamic-dispatch.ts`
  (replace the `candidates.map` tail, lines 108-120, with the engine)
- Test:
  `tests/core/domains/language/ruby/resolver/strategies/ruby-dynamic-dispatch.test.ts`
  (add a `describe` for narrowing; existing cases UNTOUCHED)

**Interfaces:**

- Consumes: `resolveNarrowedFanout`, `ArityNarrower`, `VisibilityNarrower`,
  `DuckVocabularyNarrower` (Task 3); `SymbolDefinition.arity/visibility` +
  `CallRef.argCount` (populated by Task 2).
- Produces: `RubyDynamicDispatchResolver.resolveDispatch` returns the narrowed
  consumer-split edge set on the untyped tail.

**Context:** Only the final tail changes. Everything above line 107 (the
typed/constant/relation/index/external guards) is byte-identical — those are the
byte-identity oracle. `RUBY_DUCK_VOCAB` = Ruby Object/Kernel/Enumerable methods
that never resolve to a meaningful in-project target: `to_s`, `to_str`,
`inspect`, `hash`, `==`, `eql?`, `equal?`, `freeze`, `frozen?`, `dup`, `clone`,
`tap`, `then`, `itself`, `each`, `map`, `to_a`, `to_h`, `to_proc`, `call`,
`name`, `class`, `send` (extend during review against the forensic generic
dominators).

- [ ] **Step 1: Write the failing tests (new describe block)**

```ts
// add to ruby-dynamic-dispatch.test.ts — do NOT modify existing cases
describe("untyped fan-out narrowing (xlnub)", () => {
  it("arity narrows to a single survivor → one edge confidence 1.0", () => {
    // symbol table: two `perform` defs, arities (1) and (2,2); call x.perform(1,2)
    // expect ONE edge to the arity-(2,2) def, confidence 1.0
  });
  it("duck-vocabulary member → no edges", () => {
    // call x.to_s with N in-project to_s defs → []
  });
  it("irreducible residual (m>1) → m edges confidence discount/m", () => {
    // call x.account with 3 same-arity public account defs → 3 edges, confidence discount/3
  });
  it("private candidates dropped under explicit receiver", () => {
    // x.helper where one helper is private, one public, same arity → only public survives
  });
});
```

- [ ] **Step 2: Run, verify the new cases fail; existing cases still pass**

Run:
`npx vitest run tests/core/domains/language/ruby/resolver/strategies/ruby-dynamic-dispatch.test.ts`
Expected: new cases FAIL (still unconditional fan-out); existing cases PASS.

- [ ] **Step 3: Implement — replace the tail**

In `ruby-duck-vocabulary.ts`:

```ts
export const RUBY_DUCK_VOCAB: ReadonlySet<string> = new Set([
  "to_s",
  "to_str",
  "inspect",
  "hash",
  "==",
  "eql?",
  "equal?",
  "freeze",
  "frozen?",
  "dup",
  "clone",
  "tap",
  "then",
  "itself",
  "each",
  "map",
  "to_a",
  "to_h",
  "to_proc",
  "call",
  "name",
  "class",
  "send",
]);
```

In `ruby-dynamic-dispatch.ts`, replace lines 108-120 with:

```ts
const candidates = ctx.symbolTable
  .lookupByShortName(call.member)
  .filter((def) => isRubyPath(def.relPath));
if (candidates.length === 0) return [];
const discount =
  this.cfg.dynamicReceiverConfidence ?? DYNAMIC_RECEIVER_CONFIDENCE_DEFAULT;
return resolveNarrowedFanout(call, candidates, ctx, this.narrowers, discount);
```

Construct the narrower cascade once in the resolver constructor:

```ts
private readonly narrowers = [
  new DuckVocabularyNarrower(RUBY_DUCK_VOCAB),
  new ArityNarrower(),
  new VisibilityNarrower(),
];
```

(Import the three narrowers + `resolveNarrowedFanout` from
`domains/language/kernel/dispatch-narrowing.js`; import `RUBY_DUCK_VOCAB` from
the new file. `ResolverConfig` / `shared.ts` are NOT touched — the cascade is
resolver-local, avoiding the isHub ripple.)

- [ ] **Step 4: Run, verify all pass**

Run: `npx vitest run tests/core/domains/language/ruby/resolver/` Expected: new +
existing ruby resolver tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/language/ruby/resolver/strategies/ruby-duck-vocabulary.ts \
  src/core/domains/language/ruby/resolver/strategies/ruby-dynamic-dispatch.ts \
  tests/core/domains/language/ruby/resolver/strategies/ruby-dynamic-dispatch.test.ts
git commit -m "feat(trajectory): route ruby untyped fan-out through narrowing cascade (xlnub)"
```

---

### Task 5: Navigation edgeKind/confidence filter

**Files:**

- Modify: `src/core/contracts/types/codegraph.ts` (`CallerEdge` + `CalleeEdge`
  gain `edgeKind?` + `confidence?`)
- Modify: the DuckDB graphDb `getCallers` / `getCallees` / `getCalleeEdges` SQL
  to `SELECT edge_kind, confidence` (columns exist via migration 006)
- Modify: `src/core/api/internal/facades/graph-facade.ts` (`getCallers` /
  `getCallees` filter; `tracePath` frontier filter)
- Test: `tests/core/api/internal/facades/graph-facade-navfilter.test.ts`

**Interfaces:**

- Consumes: persisted `edge_kind` + `confidence` columns; the narrowed edges
  from Task 4.
- Produces: navigation hides `dynamic` edges with `confidence < 1.0`; always
  shows `cone` / `exact` / `poly-base`.

**Context:** `graph-facade.getCallers` does `edges.slice(0, limit)` with no
filter (lines 108-117). The filter goes between fetch and slice.
`MethodEdgeKind` already exists in `codegraph.ts`. The persisted columns are
read in the graphDb SQL — add them to the SELECT and surface on
`CallerEdge`/`CalleeEdge`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/api/internal/facades/graph-facade-navfilter.test.ts
import { describe, expect, it } from "vitest";

import { isNavigationVisibleEdge } from "../../../../../src/core/api/internal/facades/graph-facade.js";

describe("navigation edge filter (xlnub)", () => {
  const cases = [
    { edgeKind: "exact", confidence: 1.0, visible: true },
    { edgeKind: "cone", confidence: 0.33, visible: true },
    { edgeKind: "poly-base", confidence: 1.0, visible: true },
    { edgeKind: "dynamic", confidence: 1.0, visible: true }, // narrowed-unique
    { edgeKind: "dynamic", confidence: 0.5, visible: false }, // irreducible residual
    { edgeKind: undefined, confidence: undefined, visible: true }, // legacy edge → visible
  ];
  for (const c of cases) {
    it(`${c.edgeKind}@${c.confidence} → ${c.visible ? "shown" : "hidden"}`, () => {
      expect(isNavigationVisibleEdge(c)).toBe(c.visible);
    });
  }
});
```

- [ ] **Step 2: Run, verify it fails**

Run:
`npx vitest run tests/core/api/internal/facades/graph-facade-navfilter.test.ts`
Expected: FAIL — `isNavigationVisibleEdge` not exported.

- [ ] **Step 3: Implement the filter**

Export from `graph-facade.ts`:

```ts
/** Navigation hides the irreducible untyped-dispatch residual (bd xlnub):
 *  a `dynamic` edge is shown only when uniquely narrowed (confidence 1.0).
 *  Every other edge kind (cone/exact/poly-base) and legacy edges with no
 *  edgeKind are always shown. */
export function isNavigationVisibleEdge(e: {
  edgeKind?: string;
  confidence?: number;
}): boolean {
  if (e.edgeKind !== "dynamic") return true;
  return (e.confidence ?? 1) >= 1;
}
```

Apply it in `getCallers` / `getCallees` BEFORE the slice:

```ts
const edges = (await handle.graphDb.getCallers(req.symbolId)).filter(
  isNavigationVisibleEdge,
);
return { callers: edges.slice(0, req.limit ?? DEFAULT_LIMIT) };
```

Add `edgeKind?` + `confidence?` to `CallerEdge` / `CalleeEdge` and
`SELECT edge_kind AS "edgeKind", confidence` in the graphDb `getCallers` /
`getCallees` SQL. For `tracePath`, apply `isNavigationVisibleEdge` to the
`getCalleeEdges` frontier so traced paths never traverse a hidden residual
(surface `edge_kind`/`confidence` in that query too).

- [ ] **Step 4: Run, verify it passes; existing graph tests green**

Run:
`npx vitest run tests/core/api/internal/facades/ tests/core/adapters/duckdb/`
Expected: new test PASS; existing caller/callee/trace tests PASS UNTOUCHED.

- [ ] **Step 5: Commit**

```bash
git add src/core/api/internal/facades/graph-facade.ts \
  src/core/contracts/types/codegraph.ts \
  src/core/adapters/duckdb/ \
  tests/core/api/internal/facades/graph-facade-navfilter.test.ts
git commit -m "feat(api): edgeKind/confidence-aware navigation filter hides dispatch residual (xlnub)"
```

---

## Live validation (final, USER-GATED — NOT a task)

After all tasks land + green, on explicit user authorization: build + link the
worktree, reconnect MCP, reindex the 4 corpora (huginn / octokit /
bench-graphql-ruby / bench-mastodon). Confirm:

- `dynamic` edge count DROPS where narrowable (`perform`/`call`/`merge` →
  narrowed-unique); `exactRatio` rises PARTIALLY (account-class residual stays
  for analytics).
- `get_callers` / `get_callees` on a narrowed-unique member returns THE single
  target; on an irreducible member (`account`) returns the hole (analytics fanIn
  unchanged).
- Typed-cone / `exact` / every other receiver kind's `resolved` counts UNCHANGED
  on all 4 corpora; octokit (already clean, `exactRatio` 0.844) UNCHANGED.

## Self-Review notes (author)

- Spec coverage: substrate (Task 1+2), cascade V/A/Vis (Task 3+4),
  consumer-split terminal (Task 3), navigation filter (Task 5), neutral kernel
  placement (Task 3), scripting-neutral substrate (Task 1, Ruby-populated Task
  2). Out-of- scope items (receiver-name convention, Python/JS/Bash population,
  pageRank confidence-weighting) are intentionally absent.
- Type consistency: `AritySignature { minRequired, maxPositional, hasSplat }`,
  `resolveNarrowedFanout(call, candidates, ctx, narrowers, discount)`,
  `isNavigationVisibleEdge({edgeKind, confidence})` are used identically across
  tasks.
- Conservatism invariant encoded in Task 3 ArityNarrower (`undefined` → keep)
  and VisibilityNarrower (only `private` dropped).
