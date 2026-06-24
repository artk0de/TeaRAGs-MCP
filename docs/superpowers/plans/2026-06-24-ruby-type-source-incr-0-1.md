# Ruby Type-Source Mechanism (Incr 0 + 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. (Chaining: the dinopowers wrapper
> redirects to `dinopowers:executing-plans`.)

**Goal:** Refactor Ruby receiver type-inference into a pluggable two-layer
mechanism (TypeSource adapters → source-agnostic propagation engine) and use it
to raise dynamic-edge recall on annotated code via multi-hop YARD chain-call
threading.

**Architecture:** Layer 1 — `RubyInlineTypeSource` / `RubySidecarTypeSource`
adapters emit normalized `RubyTypeFact`s (param/return/ivar/local). Layer 2 —
`TypeFactStore` merges with precedence + normalizes union/container. Layer 3 —
`type-propagation.ts` threads a seed type through chain calls at resolve time
(first unknown hop STOPS, no fabrication). Existing `SymbolResolutionStrategy`
chain + `collectRubyCalls` god-method stay untouched; new behavior enters via a
new strategy in the `strategies/` registry.

**Tech Stack:** TypeScript (NodeNext ESM), tree-sitter-ruby, vitest. No new
runtime dependency (Sorbet/RBS parsing — later increments — must stay
Ruby-runtime-free).

## Global Constraints

- Spec:
  `docs/superpowers/specs/2026-06-24-ruby-type-source-mechanism-design.md`.
- **Behavior-preserving Increment 0**: relocate code; existing business-logic
  tests stay GREEN UNTOUCHED (move/re-point imports OK, rewrite NO);
  `resolveSuccessRate` / `byReceiverKind` must NOT move. New entities (store,
  registry, adapters) get NEW red-green tests.
- **`contracts/types/codegraph.ts` is the highest blast-radius file (fanIn 68,
  transitiveImpact 118)** — every change to it is ADDITIVE-ONLY (no field
  removal/rename), isolated in its own task, with explicit type/unit coverage.
  Increment 0 touches it ZERO; the only contract edit is Increment 1 Task 1.1
  (additive).
- **Typed-array registry, NOT self-registration**
  (`.claude/rules/resolver-architecture.md` rule #3) — `INLINE_TYPE_SOURCES` is
  a `readonly RubyInlineTypeSource[]`.
- **Barrel imports across subdomain boundaries**
  (`.claude/rules/barrel-files.md`); deep imports OK within `ruby/`.
- **Domain-qualified names** (`.claude/rules/naming.md`): `RubyTypeFact`,
  `RubyChainTypeSymbolResolutionStrategy`, not `TypeFact` / `ChainStrategy`.
- **Typed errors only** (`.claude/rules/typed-errors.md`): no
  `throw new Error(...)`; invariant violations may use plain `Error`.
- Gating env preserved: `CODEGRAPH_RB_LOCAL_TYPE_TRACKING` (existing). New chain
  depth cap env: `CODEGRAPH_RB_CHAIN_MAX_HOPS` (default 4).
- Commit convention: `type(scope): subject` ≤100 chars; scope `trajectory` for
  behavior, `refactor` type for Increment 0 relocation tasks. End commit body
  with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
  Commit only — never push/merge without explicit ask.
- Build/reindex are user-gated (single-worktree build OK to verify;
  reindex/force-reindex ALWAYS user-gated). Live `resolveSuccessRate` validation
  tasks are explicit checkpoints, not auto-run.

---

## Increment 0 — Refactor seam (behavior-preserving)

Net effect: byte-identical walker output, proven by the existing
`tests/core/domains/language/ruby/walker/ruby-walker.test.ts` (localBindings
suites) and `ruby-resolver*.test.ts` staying GREEN with only import-path edits.

## Task 0.1: Source + type-ref contracts

**Files:**

- Modify: `src/core/contracts/types/language.ts` — append `RubyTypeRef` ONLY
  (pure data, zero domain dep; `CallContext` references it in Task 1.1, an
  intra-`contracts/` reference, legal).
- Create: `src/core/domains/language/ruby/walker/type-sources/types.ts` —
  `RubyTypeFact` + the source interfaces. They bind `RubyExtractInput` (declared
  in `ruby/walker/walker.ts:59`, a DOMAIN type), so they MUST NOT live in
  `contracts/` (`contracts/` -x-> `domains/` is a hard layer violation). They
  import `RubyTypeRef` from contracts (domain→contracts, legal) and
  `RubyExtractInput` from `../walker.js` (intra-domain, legal).
- Test:
  `tests/core/domains/language/ruby/walker/type-sources/types.contract.test.ts`
  (new)

**Interfaces:**

- Produces (contracts): `RubyTypeRef`.
- Produces (domain `type-sources/types.ts`): `RubyTypeFact`,
  `RubyInlineTypeSource`, `RubySidecarTypeSource`, `ProjectTypeSourceContext`.

- [ ] **Step 1: Write the failing contract test** (type-level + a structural
      assertion the symbols exist and a fact round-trips through a trivial
      source)

```ts
// tests/core/domains/language/ruby/walker/type-sources/types.contract.test.ts
import { describe, expect, it } from "vitest";

import type { RubyTypeRef } from "../../../../../../../../src/core/contracts/types/language.js";
import type {
  RubyInlineTypeSource,
  RubyTypeFact,
} from "../../../../../../../../src/core/domains/language/ruby/walker/type-sources/types.js";

describe("RubyTypeFact contract", () => {
  it("models class/instance/union/container type refs", () => {
    const klass: RubyTypeRef = { form: "class", name: "User" };
    const inst: RubyTypeRef = { form: "instance", name: "User" };
    const union: RubyTypeRef = { form: "union", members: [klass, inst] };
    const arr: RubyTypeRef = {
      form: "container",
      element: { form: "instance", name: "Post" },
    };
    expect([klass.form, inst.form, union.form, arr.form]).toEqual([
      "class",
      "instance",
      "union",
      "container",
    ]);
  });

  it("an inline source emits position-scoped param facts", () => {
    const src: RubyInlineTypeSource = {
      name: "fixture",
      extract: () => [
        {
          kind: "param",
          symbolScope: ["Octokit", "Client"],
          methodName: "repo",
          name: "id",
          line: 10,
          type: { form: "instance", name: "Repository" },
        },
      ],
    };
    const facts: RubyTypeFact[] = src.extract({} as never);
    expect(facts[0]).toMatchObject({ kind: "param", name: "id", line: 10 });
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run:
`npx vitest run tests/core/domains/language/ruby/walker/type-sources/types.contract.test.ts`
Expected: FAIL — `RubyTypeRef` / `RubyTypeFact` / `RubyInlineTypeSource` not
exported.

- [ ] **Step 3a: Append `RubyTypeRef` to `contracts/types/language.ts`** (pure
      data — nothing else goes in contracts)

```ts
/**
 * Normalized receiver-type reference emitted by a Ruby type source (YARD /
 * Sorbet / RBS). `class` vs `instance` mirrors {@link LocalBinding.valueKind};
 * `union` fans out to a CHA cone; `container` carries an element type for
 * `Array<Post>` / `Relation<X>` element flow. Lives in contracts because
 * `CallContext.structuredReturnTypes` (Task 1.1) references it.
 */
export type RubyTypeRef =
  | { form: "class" | "instance"; name: string }
  | { form: "union"; members: RubyTypeRef[] }
  | { form: "container"; element: RubyTypeRef };
```

- [ ] **Step 3b: Create the domain types file**
      `src/core/domains/language/ruby/walker/type-sources/types.ts`

```ts
import type { RubyTypeRef } from "../../../../../contracts/types/language.js";
import type { RubyExtractInput } from "../walker.js";

/** One receiver-type fact a source attributes to a symbol coordinate. */
export interface RubyTypeFact {
  kind: "param" | "return" | "ivar" | "local" | "attr";
  /** Enclosing class/module FQ scope, e.g. ["Octokit","Client"]. */
  symbolScope: string[];
  /** Owning def short name (param/return/local). Undefined for class-level ivar/attr. */
  methodName?: string;
  /** Param / ivar / local var name. Undefined for `return`. */
  name?: string;
  /** 1-based source line for position-scoped inline facts; undefined for sidecar/name-keyed facts. */
  line?: number;
  type: RubyTypeRef;
}

/** A type source colocated in the `.rb` file (YARD comments, Sorbet `sig {}` / `T.let`). */
export interface RubyInlineTypeSource {
  readonly name: string;
  extract(input: RubyExtractInput): RubyTypeFact[];
}

/** A type source living in separate signature files (`sig/*.rbs`, `sorbet/rbi/`). */
export interface RubySidecarTypeSource {
  readonly name: string;
  extractProject(ctx: ProjectTypeSourceContext): RubyTypeFact[];
}

/** Inputs a sidecar source receives once per project (pre-pass). */
export interface ProjectTypeSourceContext {
  /** Absolute project root. */
  projectRoot: string;
  /** Relative paths of the `.rb` files being indexed (join target by FQ name). */
  rubyFiles: readonly string[];
}
```

> Verify the relative import depths against the real files before committing
> (`RubyExtractInput` is `export`ed from `ruby/walker/walker.ts`; adjust the
> `../` count if the new file's nesting differs). Do NOT redefine
> `RubyExtractInput` — import it.

- [ ] **Step 4: Run it, verify it passes**

Run:
`npx vitest run tests/core/domains/language/ruby/walker/type-sources/types.contract.test.ts && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/contracts/types/language.ts src/core/domains/language/ruby/walker/type-sources/types.ts tests/core/domains/language/ruby/walker/type-sources/types.contract.test.ts
git commit -m "feat(contracts): RubyTypeRef + ruby type-source interfaces (domain)"
```

## Task 0.2: TypeFactStore (pass-through parity)

The store is the new orchestrator. In Increment 0 it reproduces today's exact
outputs from facts; precedence/normalization land in Increment 1.

**Files:**

- Create: `src/core/domains/language/ruby/walker/type-fact-store.ts`
- Test: `tests/core/domains/language/ruby/walker/type-fact-store.test.ts` (new)

**Interfaces:**

- Consumes: `RubyTypeFact`, `LocalBinding` (codegraph.ts).
- Produces: `class RubyTypeFactStore` with

  `localBindingsForChunk(startLine: number, endLine: number): Record<string, LocalBinding[]>`,
  `returnTypeByMethod(): Record<string, string>` (parity with today's
  `functionReturnTypes`), and
  `static fromFacts(facts: RubyTypeFact[]): RubyTypeFactStore`.

- [ ] **Step 1: Write the failing test** (a `param` fact inside a chunk range
      becomes a `LocalBinding`; a `return` fact becomes a `functionReturnTypes`
      entry — matching today's shapes)

```ts
import { describe, expect, it } from "vitest";

import { RubyTypeFactStore } from "../../../../../../src/core/domains/language/ruby/walker/type-fact-store.js";
import type { RubyTypeFact } from "../../../../../../src/core/domains/language/ruby/walker/type-sources/types.js";

describe("RubyTypeFactStore parity", () => {
  it("param fact -> position-scoped LocalBinding", () => {
    const facts: RubyTypeFact[] = [
      {
        kind: "param",
        symbolScope: ["C"],
        methodName: "m",
        name: "user",
        line: 5,
        type: { form: "instance", name: "User" },
      },
    ];
    const store = RubyTypeFactStore.fromFacts(facts);
    expect(store.localBindingsForChunk(3, 20)).toEqual({
      user: [{ line: 5, type: "User" }],
    });
  });

  it("class-valued param keeps valueKind", () => {
    const store = RubyTypeFactStore.fromFacts([
      {
        kind: "local",
        symbolScope: ["C"],
        methodName: "m",
        name: "k",
        line: 7,
        type: { form: "class", name: "User" },
      },
    ]);
    expect(store.localBindingsForChunk(1, 99).k[0]).toEqual({
      line: 7,
      type: "User",
      valueKind: "class",
    });
  });

  it("return fact -> functionReturnTypes entry", () => {
    const store = RubyTypeFactStore.fromFacts([
      {
        kind: "return",
        symbolScope: ["C"],
        methodName: "build",
        type: { form: "instance", name: "Post" },
      },
    ]);
    expect(store.returnTypeByMethod()).toEqual({ build: "Post" });
  });
});
```

- [ ] **Step 2: Run it, verify it fails** — `RubyTypeFactStore` not found.

- [ ] **Step 3: Implement the store (parity rules only)**

```ts
import type { LocalBinding } from "../../../../contracts/types/codegraph.js";
import type { RubyTypeRef } from "../../../../contracts/types/language.js";
import type { RubyTypeFact } from "./type-sources/types.js";

/** Flatten a RubyTypeRef to the bare class name today's LocalBinding.type holds (Incr 0 parity). */
function refToName(ref: RubyTypeRef): string | undefined {
  if (ref.form === "class" || ref.form === "instance") return ref.name;
  if (ref.form === "container") return refToName(ref.element); // element wins (today's Array<Post> -> Post)
  return undefined; // union: deferred to Incr 1 (no single name)
}

export class RubyTypeFactStore {
  private constructor(private readonly facts: readonly RubyTypeFact[]) {}

  static fromFacts(facts: RubyTypeFact[]): RubyTypeFactStore {
    return new RubyTypeFactStore(facts);
  }

  localBindingsForChunk(
    startLine: number,
    endLine: number,
  ): Record<string, LocalBinding[]> {
    const out: Record<string, LocalBinding[]> = {};
    for (const f of this.facts) {
      if (f.kind !== "param" && f.kind !== "local") continue;
      if (f.line === undefined || f.line < startLine || f.line > endLine)
        continue;
      const name = f.name;
      const type = refToName(f.type);
      if (!name || type === undefined) continue;
      const binding: LocalBinding = { line: f.line, type };
      if (f.type.form === "class") binding.valueKind = "class";
      (out[name] ??= []).push(binding);
    }
    for (const list of Object.values(out)) list.sort((a, b) => a.line - b.line);
    return out;
  }

  returnTypeByMethod(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const f of this.facts) {
      if (f.kind !== "return" || !f.methodName) continue;
      const type = refToName(f.type);
      if (type !== undefined) out[f.methodName] = type;
    }
    return out;
  }
}
```

- [ ] **Step 4: Run it, verify it passes.**

Run:
`npx vitest run tests/core/domains/language/ruby/walker/type-fact-store.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/language/ruby/walker/type-fact-store.ts tests/core/domains/language/ruby/walker/type-fact-store.test.ts
git commit -m "feat(trajectory): RubyTypeFactStore parity orchestrator (Incr 0)"
```

## Task 0.3: Relocate YARD parsers behind `RubyYardTypeSource`

**Files:**

- Create: `src/core/domains/language/ruby/walker/type-sources/yard.ts`
- Modify: `src/core/domains/language/ruby/walker/local-bindings.ts` (remove
  relocated parsers; re-export shims if any other caller imports them, else
  delete)
- Test: existing `tests/core/domains/language/ruby/walker/ruby-walker.test.ts`
  (re-point imports only) +
  `tests/core/domains/language/ruby/walker/type-sources/yard.test.ts` (new, for
  the adapter wrapper)

**Interfaces:**

- Produces: `const rubyYardTypeSource: RubyInlineTypeSource` (name `"yard"`).
  Internally moves `collectYardParamTypes`, `collectYardReturnTypes`,
  `parseYardBracketType`, `YARD_CONST`, `YARD_ELEMENT_CONTAINER` VERBATIM, and
  adapts their output into `RubyTypeFact[]`.

- [ ] **Step 1: Move the parser functions verbatim** into `type-sources/yard.ts`
      (cut from `local-bindings.ts`; do NOT alter regexes or logic — relocation,
      not rewrite).

- [ ] **Step 2: Add the adapter that converts existing parser output to facts**

```ts
import type { RubyExtractInput } from "../../../../../contracts/types/ast.js"; // adjust to real RubyExtractInput home
import type {
  RubyInlineTypeSource,
  RubyTypeFact,
  RubyTypeRef,
} from "../../../../../contracts/types/language.js";

// ...relocated collectYardParamTypes / collectYardReturnTypes live above in this file...

/** Bracket type string ("User", "Array<Post>", "Acme::Post") -> RubyTypeRef. */
function yardBracketToRef(raw: string): RubyTypeRef | undefined {
  // delegates to the relocated parseYardBracketType + container regex; container -> element ref.
  // Keep the SAME acceptance as today (bare const + the 5 hardcoded containers); union deferred to Incr 1.
  // returns { form: "instance", name } or { form: "container", element } or undefined.
}

export const rubyYardTypeSource: RubyInlineTypeSource = {
  name: "yard",
  extract(input: RubyExtractInput): RubyTypeFact[] {
    const facts: RubyTypeFact[] = [];
    // @param: collectYardParamTypes(input.code) -> Map<defLine, Record<param, bracketStr>>
    for (const [defLine, params] of collectYardParamTypes(input.code)) {
      for (const [name, raw] of Object.entries(params)) {
        const type = yardBracketToRef(raw);
        if (type)
          facts.push({
            kind: "param",
            symbolScope: [],
            methodName: undefined,
            name,
            line: defLine,
            type,
          });
      }
    }
    // @return: collectYardReturnTypes(input.code) -> Record<methodName, bracketStr>
    for (const [methodName, raw] of Object.entries(
      collectYardReturnTypes(input.code),
    )) {
      const type = yardBracketToRef(raw);
      if (type)
        facts.push({ kind: "return", symbolScope: [], methodName, type });
    }
    return facts;
  },
};
```

> The `symbolScope` is left `[]` in Increment 0 (today's YARD param/return
> tables are keyed by def line / bare method name, not by class scope — parity).
> Scope population is an Increment 1 concern only where the engine needs FQ
> disambiguation.

- [ ] **Step 3: Re-point existing imports** in `ruby-walker.test.ts` and any
      `local-bindings.ts` callers to the new location. Do NOT change any
      `it`/`describe`/assertion bodies. Validate `it`/`describe` count is `>=`
      the base branch (relocation rule).

- [ ] **Step 4: Run the existing walker suite + new adapter test, verify GREEN**

Run: `npx vitest run tests/core/domains/language/ruby/walker/` Expected: PASS —
existing YARD localBindings tests unchanged and green.

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/language/ruby/walker/type-sources/yard.ts src/core/domains/language/ruby/walker/local-bindings.ts tests/core/domains/language/ruby/walker/
git commit -m "refactor(trajectory): relocate YARD parsers behind RubyYardTypeSource"
```

## Task 0.4: Relocate AST inference behind `RubyAstInferenceTypeSource`

**Files:**

- Create: `src/core/domains/language/ruby/walker/type-sources/ast-inference.ts`
- Modify: `src/core/domains/language/ruby/walker/local-bindings.ts` (relocate
  `constInstanceType`, `INSTANCE_RETURNING_METHODS`,
  `RELATION_RETURNING_METHODS`, single/multi assignment + copy-prop logic in
  `collectLocalBindingsForChunk`)
- Test: existing walker suite (re-point) +
  `tests/core/domains/language/ruby/walker/type-sources/ast-inference.test.ts`
  (new)

**Interfaces:**

- Produces: `const rubyAstInferenceTypeSource: RubyInlineTypeSource` (name
  `"ast"`). Emits `local` facts (`var = X.new`, `var = Model.find`, copy-prop,
  multi-assign) with `valueKind` mapped to `{ form: "class" | "instance" }`.

- [ ] **Step 1: Move `constInstanceType` + the returning-method sets + the
      per-chunk assignment walk** verbatim into `ast-inference.ts`. Keep
      position-awareness identical.

- [ ] **Step 2: Adapt the walk to emit `RubyTypeFact[]` (`kind: "local"`)** —
      one fact per inferred binding, `line` = assignment line, `type.form` =
      `"class"` when the binding's `valueKind` is class else `"instance"`.

- [ ] **Step 3: Re-point existing `local-bindings (type inference)` test
      imports**; assertions unchanged; verify count `>=` base.

- [ ] **Step 4: Run walker suite, verify GREEN.**

Run: `npx vitest run tests/core/domains/language/ruby/walker/`

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/language/ruby/walker/type-sources/ast-inference.ts src/core/domains/language/ruby/walker/local-bindings.ts tests/core/domains/language/ruby/walker/
git commit -m "refactor(trajectory): relocate AST type inference behind RubyAstInferenceTypeSource"
```

## Task 0.5: Registry + rewire `extractFromRubyFile`

**Files:**

- Create: `src/core/domains/language/ruby/walker/type-sources/index.ts`
- Modify: `src/core/domains/language/ruby/walker/walker.ts`
  (`extractFromRubyFile`)
- Modify: `src/core/domains/language/ruby/index.ts` (compose — if sources need
  composition wiring)
- Test: existing `extractFromRubyFile` suites (re-point) +
  `tests/core/domains/language/ruby/walker/type-sources/index.test.ts` (registry
  shape)

**Interfaces:**

- Produces:
  `export const INLINE_TYPE_SOURCES: readonly RubyInlineTypeSource[] = [rubyYardTypeSource, rubyAstInferenceTypeSource];`
- Consumes: `RubyTypeFactStore`.

- [ ] **Step 1: Write the registry test** (array contains both sources, in
      precedence-stable order yard-then-ast for Incr 0 parity)

```ts
import { describe, expect, it } from "vitest";

import { INLINE_TYPE_SOURCES } from "../../../../../../../src/core/domains/language/ruby/walker/type-sources/index.js";

describe("INLINE_TYPE_SOURCES", () => {
  it("registers yard + ast adapters as a typed array", () => {
    expect(INLINE_TYPE_SOURCES.map((s) => s.name)).toEqual(["yard", "ast"]);
  });
});
```

- [ ] **Step 2: Run it, verify it fails.**

- [ ] **Step 3: Create the registry + rewire `extractFromRubyFile`** to: gather
      facts from every `INLINE_TYPE_SOURCES.extract(input)` (gated by
      `localTypeTrackingEnabled()` exactly as today), build a
      `RubyTypeFactStore`, then call `store.localBindingsForChunk(start,end)`
      per chunk and `store.returnTypeByMethod()` for
      `FileExtraction.functionReturnTypes`. The persisted shapes are identical
      to today's.

```ts
// inside extractFromRubyFile, replacing the inline collectYard* + collectLocalBindingsForChunk wiring:
const facts = localTypeTrackingEnabled()
  ? INLINE_TYPE_SOURCES.flatMap((s) => s.extract(input))
  : [];
const store = RubyTypeFactStore.fromFacts(facts);
// per chunk:
const localBindings = store.localBindingsForChunk(
  chunk.startLine,
  chunk.endLine,
);
if (Object.keys(localBindings).length > 0)
  chunkExtraction.localBindings = localBindings;
// file level:
const functionReturnTypes = store.returnTypeByMethod();
if (Object.keys(functionReturnTypes).length > 0)
  fileExtraction.functionReturnTypes = functionReturnTypes;
```

- [ ] **Step 4: Run the FULL ruby suite + tsc, verify GREEN with zero behavior
      change.**

Run: `npx vitest run tests/core/domains/language/ruby/ && npx tsc --noEmit`
Expected: PASS — every existing walker/resolver assertion green, untouched.

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/language/ruby/walker/type-sources/index.ts src/core/domains/language/ruby/walker/walker.ts src/core/domains/language/ruby/index.ts tests/core/domains/language/ruby/walker/type-sources/index.test.ts
git commit -m "refactor(trajectory): drive extractFromRubyFile via INLINE_TYPE_SOURCES + store"
```

## Task 0.6: Increment 0 live-parity checkpoint (USER-GATED)

**Files:** none (validation only).

- [ ] **Step 1: Full unit suite + type check.** Run:
      `npm test && npx tsc --noEmit`. Expected: all green.
- [ ] **Step 2: Request build + reconnect** (single active worktree → build
      allowed to verify; ask for `/mcp reconnect`).
- [ ] **Step 3: USER-GATED self-test reindex** — on explicit "reindex":
      `tea-rags index-codebase --project tea-rags-worktree --wait-enrichments --force --json`.
      Capture `codegraphResolve.byReceiverKind` + `resolveSuccessRate`.
- [ ] **Step 4: Assert ZERO delta** vs the pre-refactor baseline (Increment 0 is
      behavior-preserving). Any movement is a regression → STOP, do not proceed
      to Increment 1.

---

## Increment 1 — YARD to the limit

## Task 1.1: Additive contract extension (codegraph.ts)

**Files:**

- Modify: `src/core/contracts/types/codegraph.ts` (ADDITIVE-ONLY)
- Test: `tests/core/contracts/types/codegraph-ivar-return.contract.test.ts`
  (new)

**Interfaces:**

- Produces (additive):
  `CallContext.ivarTypes?: Record<string, Record<string, string>>` (scope → ivar
  → typeName), and
  `CallContext.structuredReturnTypes?: Record<string, RubyTypeRef>` (FQ method →
  ref, the engine's richer return map alongside the existing flat
  `functionReturnTypes`). `FileExtraction.ivarTypes?` mirror for persistence.

> **Constraint:** add fields, never remove/rename. `functionReturnTypes` stays
> as-is for backward compatibility; `structuredReturnTypes` is the superset the
> engine reads.

- [ ] **Step 1: Write the failing additive-shape test** (construct a
      `CallContext` literal carrying the new optional fields; assert old fields
      still accepted).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Append the optional fields** to `CallContext` and
      `FileExtraction` with doc comments referencing this plan. `RubyTypeRef` is
      imported from `language.ts` — confirm no contract→domain cycle (it lives
      in `contracts/`, legal).
- [ ] **Step 4: Run test + tsc, verify pass.** Run:
      `npx vitest run tests/core/contracts/types/codegraph-ivar-return.contract.test.ts && npx tsc --noEmit`.
- [ ] **Step 5: Commit** —
      `feat(contracts): additive ivarTypes + structuredReturnTypes on CallContext`.

## Task 1.2: Store precedence + union/container normalization

**Files:**

- Modify: `src/core/domains/language/ruby/walker/type-fact-store.ts`
- Test:
  `tests/core/domains/language/ruby/walker/type-fact-store-precedence.test.ts`
  (new)

**Interfaces:**

- Produces: `RubyTypeFactStore` gains
  `structuredReturnType(scope: string[], method: string): RubyTypeRef | undefined`,
  `ivarType(scope: string[], ivar: string): RubyTypeRef | undefined`, and
  precedence ordering driven by source name. Constructor now takes
  `(facts, sourceOrder: readonly string[])`; default order
  `["sorbet","rbs","yard","ast"]`.

- [ ] **Step 1: Failing test** — two facts for the same coordinate from `yard`
      and `ast`; assert `yard` wins (precedence). A `union` ref survives
      normalization (not flattened to a single name). A `container` exposes its
      element via `structuredReturnType`.
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement** precedence (group facts by coordinate, pick min
      index in `sourceOrder`) + retain full `RubyTypeRef` (do NOT collapse
      union). `localBindingsForChunk` keeps emitting bare names for non-union
      refs (parity); union refs are surfaced only through the structured lookups
      the engine reads.
- [ ] **Step 4: Verify pass.**
- [ ] **Step 5: Commit** —
      `feat(trajectory): TypeFactStore precedence + union/container normalization`.

## Task 1.3: Propagation engine — single-hop parity

Build the engine FIRST at behavior parity with today's `localType` resolution,
so wiring it changes nothing measurable; multi-hop is the next task.

**Files:**

- Create: `src/core/domains/language/ruby/resolver/type-propagation.ts`
- Test: `tests/core/domains/language/ruby/resolver/type-propagation.test.ts`
  (new)

**Interfaces:**

- Consumes: `CallContext`, `RubyTypeRef`, `resolveLocalBinding` (codegraph.ts),
  `resolveTypeInstanceMethod` / `resolveTypeStaticMethod`
  (strategies/shared.ts).
- Produces:
  `function typeOfReceiver(receiver: string, atLine: number, ctx: CallContext): RubyTypeRef | undefined`
  and
  `function resolveChainReceiver(call, ctx, cfg): SymbolResolutionTarget | "drop" | undefined`.

- [ ] **Step 1: Failing test** — a receiver with a local binding
      `var = User.new`; `typeOfReceiver("var", line, ctx)` returns
      `{ form: "instance", name: "User" }`; an unbound receiver returns
      `undefined`.
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement single-hop** — local binding → `RubyTypeRef`; `@ivar`
      → `ctx.ivarTypes` lookup; no chain walking yet (a dotted receiver returns
      `undefined` so the existing chain owners are unaffected).
- [ ] **Step 4: Verify pass + full ruby suite green.**
- [ ] **Step 5: Commit** —
      `feat(trajectory): receiver type-propagation engine (single-hop parity)`.

## Task 1.4: Capability 1 — multi-hop chain threading

**Files:**

- Modify: `src/core/domains/language/ruby/resolver/type-propagation.ts`
- Test:
  `tests/core/domains/language/ruby/resolver/type-propagation-chain.test.ts`
  (new)

- [ ] **Step 1: Failing test** — given `ctx.structuredReturnTypes` with
      `User#account → Account` and `Account#owner → User`, and a seed
      `u : User`, `typeOfReceiver("u.account.owner", line, ctx)` returns
      `{ form: "instance", name: "User" }`. An unknown middle hop
      (`u.account.mystery.x`) returns `undefined` (STOP, no fabrication).
      Respect `CODEGRAPH_RB_CHAIN_MAX_HOPS` (default 4) — a chain longer than
      the cap returns `undefined`.
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement the recursive walk** — split the receiver into head +
      `.link` segments; seed head via single-hop; for each link resolve
      `returnTypeOf(currentType, link, ctx)` using `structuredReturnTypes` + the
      DSL association map (reuse `dsl/index.ts`) + ancestor MRO
      (`ctx.classAncestors`); first `undefined` STOPS. Cap hops at the env
      value.

```ts
function returnTypeOf(
  recv: RubyTypeRef,
  member: string,
  ctx: CallContext,
): RubyTypeRef | undefined {
  if (recv.form !== "class" && recv.form !== "instance") return undefined; // union/container handled by callers (Task 1.6/1.7)
  const key = `${recv.name}#${member}`;
  const direct = ctx.structuredReturnTypes?.[key];
  if (direct) return direct;
  const assoc = lookupAssociationType(recv.name, member, ctx); // dsl/index.ts Rails map (belongs_to/has_many)
  if (assoc) return assoc;
  // ancestor MRO: walk ctx.classAncestors[recv.name] for an inherited return type
  for (const anc of ctx.classAncestors?.[recv.name] ?? []) {
    const inherited = ctx.structuredReturnTypes?.[`${anc}#${member}`];
    if (inherited) return inherited;
  }
  return undefined;
}
```

- [ ] **Step 4: Verify pass + full ruby suite green (no regression on single-hop
      owners).**
- [ ] **Step 5: Commit** —
      `feat(trajectory): multi-hop chain-call receiver type threading`.

## Task 1.5: Wire `RubyChainTypeSymbolResolutionStrategy`

**Files:**

- Create:
  `src/core/domains/language/ruby/resolver/strategies/ruby-chain-type.ts`
- Modify: `src/core/domains/language/ruby/resolver/strategies/index.ts`
  (register)
- Modify: `src/core/domains/language/ruby/resolver/ruby-resolver.ts` (chain
  order — add the strategy between `localType` and the dynamic-dispatch pass;
  verify with the existing `RubyCallResolver#constructor` strategy list)
- Test:
  `tests/core/domains/language/ruby/resolver/strategies/ruby-chain-type.test.ts`
  (new)

**Interfaces:**

- Produces:
  `class RubyChainTypeSymbolResolutionStrategy implements SymbolResolutionStrategy`
  (name `"chainType"`). `attempt(call, ctx)` returns `resolved(target)` for a
  known terminal chain type, `DROP` when the terminal type is known but the
  method is absent in its file, `CONTINUE` when the chain type is unknown (so
  existing dynamic fan-out still runs).

- [ ] **Step 1: Failing test** — model `event.user.account` chain via
      `ctx.structuredReturnTypes`; assert the strategy resolves `account`'s
      member to the right file/symbol; assert an unresolved chain returns
      `CONTINUE` (NOT a fabricated edge).

```ts
// shape mirrors ruby-local-type.test.ts harness (symbol-table + ctx builder)
```

- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement the strategy** — only engage when `call.receiver` is a
      dotted chain (contains `.`) AND not already owned by an earlier pass; call
      `typeOfReceiver`; on a known terminal `RubyTypeRef` of form
      class/instance, delegate to `resolveTypeInstanceMethod` /
      `resolveTypeStaticMethod` (shared.ts) → `resolved`/`DROP`; else
      `CONTINUE`.

```ts
import {
  CONTINUE,
  DROP,
  resolved,
} from "../../../../../contracts/resolution.js";
import type {
  CallContext,
  CallRef,
} from "../../../../../contracts/types/codegraph.js";
import type {
  SymbolResolutionOutcome,
  SymbolResolutionStrategy,
} from "../../../../../contracts/types/language.js";
import { typeOfReceiver } from "../type-propagation.js";
import {
  resolveTypeInstanceMethod,
  resolveTypeStaticMethod,
  type ResolverConfig,
} from "./shared.js";

export class RubyChainTypeSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "chainType";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const r = call.receiver;
    if (!r || !r.includes(".")) return CONTINUE; // only multi-segment chains
    const t = typeOfReceiver(r, call.startLine, ctx);
    if (!t || (t.form !== "class" && t.form !== "instance")) return CONTINUE;
    const resolve =
      t.form === "class" ? resolveTypeStaticMethod : resolveTypeInstanceMethod;
    const target = resolve(t.name, call.member, ctx, this.cfg.mode);
    return target ? resolved(target) : DROP;
  }
}
```

- [ ] **Step 4: Register + order** in `strategies/index.ts` and the
      `RubyCallResolver` chain (after `localType`, before dynamic fan-out). Run
      full ruby suite. Expected: green; chain receivers that previously fell to
      discounted dynamic fan-out now resolve terminally where the type is known.
- [ ] **Step 5: Commit** —
      `feat(trajectory): RubyChainTypeSymbolResolutionStrategy via propagation engine`.

## Task 1.6: Capability 2 — container/element + block-param types

**Files:**

- Modify: `src/core/domains/language/ruby/walker/type-sources/ast-inference.ts`
  (block-param inference) + `type-fact-store.ts` (container element exposure)
- Modify: `src/core/domains/language/ruby/resolver/type-propagation.ts`
  (`.first`/`.last`/`[i]` element unwrap)
- Modify: `src/core/domains/language/ruby/resolver/strategies/shared.ts` ONLY if
  `receiverIsIndexAccess` suppression needs a typed-element bypass (guarded —
  keep suppression when element type unknown)
- Test:
  `tests/core/domains/language/ruby/resolver/type-propagation-container.test.ts`
  (new)

- [ ] **Step 1: Failing test** — `posts : Array<Post>` (container ref);
      `posts.first.title` resolves `Post#title`; `posts.each { |p| p.title }`
      infers block param `p : Post` and resolves `Post#title`; an untyped
      `arr[i].x` still returns `undefined` (suppression preserved).
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement** — container element unwrap on element-returning
      members (`first`/`last`/`[]`/`sample`); block-param fact emission in the
      ast source for `each`/`map`/`select` over a container-typed receiver; lift
      `receiverIsIndexAccess` suppression in the chain strategy ONLY when
      `typeOfReceiver` yields a known element type.
- [ ] **Step 4: Verify pass + full ruby suite green (index-access suppression
      for untyped containers unchanged).**
- [ ] **Step 5: Commit** —
      `feat(trajectory): container element + block-param receiver types`.

## Task 1.7: Capability 3 — union `[A,B]` → cone fan-out

**Files:**

- Modify: `src/core/domains/language/ruby/resolver/type-propagation.ts` (return
  union refs)
- Modify:
  `src/core/domains/language/ruby/resolver/strategies/ruby-chain-type.ts` (union
  → fan-out path) OR a sibling `DispatchResolverComponent` if fan-out must carry
  per-edge confidence (mirror `RubyDynamicDispatchResolver`)
- Test:
  `tests/core/domains/language/ruby/resolver/type-propagation-union.test.ts`
  (new)

- [ ] **Step 1: Failing test** — `@param x [Repository, String]`; in-project
      member resolves to the `Repository` cone member as a `cone` edge with
      confidence `1/N`; `String` (external) contributes no in-project edge; cone
      size > `coneMax` collapses per existing rule.
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement** — when `typeOfReceiver` yields
      `{ form: "union", members }`, route to a fan-out that reuses the existing
      cone machinery (`coneMax`, `1/N` confidence) over the in-project members
      (filter externals via `isRubyPath` + `resolveConstant`). Since the
      single-target `SymbolResolutionStrategy` chain cannot carry confidence,
      emit union fan-out through the `DispatchResolverComponent` path (compose
      behind `resolveDispatch` like `RubyDynamicDispatchResolver`), NOT inside
      the chain strategy.
- [ ] **Step 4: Verify pass + full ruby suite green.**
- [ ] **Step 5: Commit** — `feat(trajectory): union param type cone fan-out`.

## Task 1.8: Capability 4 — exotic YARD tags (LAST, droppable)

**Files:**

- Modify: `src/core/domains/language/ruby/walker/type-sources/yard.ts`
- Test:
  `tests/core/domains/language/ruby/walker/type-sources/yard-exotic.test.ts`
  (new)

- [ ] **Step 1: Failing test** — `@type [User]` local var → `local` fact;
      `@!attribute [r] name @return [String]` → ivar/attr fact;
      `@option opts [Integer] :page` → param-ish fact for the option key (scoped
      conservatively).
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement** parsing for `@type`, `@!attribute`, `@option` with
      the same bracket-type acceptance as `@param`. Conservative: only emit when
      the bracket type passes `YARD_CONST`/container regex.
- [ ] **Step 4: Verify pass + full ruby suite green.**
- [ ] **Step 5: Commit** —
      `feat(trajectory): exotic YARD tags (@type/@!attribute/@option)`.

## Task 1.9: octokit fixture validation (USER-GATED)

**Files:** none (measurement only).

- [ ] **Step 1: Register fixture** — clone `octokit/octokit.rb` locally;
      register a project alias `octokit` (do NOT index yet).
- [ ] **Step 2: Baseline** — with `CODEGRAPH_RB_LOCAL_TYPE_TRACKING=false`,
      USER-GATED reindex; capture dynamic-edge `resolveSuccessRate` +
      `byReceiverKind`.
- [ ] **Step 3: With chain threading ON** (default env), USER-GATED reindex;
      capture the same.
- [ ] **Step 4: Report the delta** (before/after dynamic-edge
      resolveSuccessRate). Acceptance: positive recall delta with no precision
      regression on the tea-rags self-test index (`byReceiverKind` for
      known-owned receivers unchanged).
- [ ] **Step 5: Record** the measured numbers in the spec's Validation section +
      beads epic.

---

## Self-Review (filled)

- **Spec coverage:** Layers 1–3 → Tasks 0.1–0.5 (sources/store/registry) +
  1.3–1.5 (engine/strategy). Four Incr-1 capabilities → Tasks 1.4/1.6/1.7/1.8.
  Precedence → 1.2. Additive contract → 1.1. Validation harness → 0.6 + 1.9. No
  spec section is unmapped.
- **Placeholder scan:** the only intentionally-light bodies are the relocated
  parser internals (moved verbatim — re-pasting 200 lines would invite drift)
  and `yardBracketToRef` (delegates to the relocated `parseYardBracketType`);
  both reference concrete existing symbols. No "TBD"/"add error
  handling"/"similar to Task N".
- **Type consistency:** `RubyTypeRef` / `RubyTypeFact` / `RubyTypeFactStore` /
  `typeOfReceiver` / `RubyChainTypeSymbolResolutionStrategy` used identically
  across tasks. `LocalBinding` matches codegraph.ts:384
  (`{line,type,valueKind?}`). `structuredReturnTypes` introduced in 1.1,
  consumed in 1.4/1.5.

## Beads

Create epic `ruby-type-source-mechanism` with Task 0.1–1.9 as children (labels:
`architecture`, `api`, `metrics`). Sidecar: `bd worktree create` or write the
absolute main `.beads/` path into `<worktree>/.beads/redirect` (worktree bd is
otherwise broken). Sorbet (Incr 2) + RBS (Incr 3) are separate epics with their
own specs.
