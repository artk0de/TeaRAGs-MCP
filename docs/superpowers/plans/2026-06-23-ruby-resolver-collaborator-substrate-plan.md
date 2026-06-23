# Ruby Call-Resolver Collaborator Substrate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decompose `RubyCallResolver`'s two inline responsibilities
(`resolveDispatch` composition, `targetsExternalImport` classification) into
generic cross-language engines + injected per-language collaborators, with Ruby
as the pilot — behaviour byte-identical.

**Architecture:** Generic engines live in `domains/language/`
(`resolveDispatchViaComponents` in `resolver-chain.ts`; `ExternalCallClassifier`
in `external-classifier.ts`); the injected interface `ExternalVocabulary` lives
in `contracts/types/language.ts` beside the existing `ConeTypeLocator` (and
reuses the existing `DispatchResolverComponent`). Mirrors the cone-dispatch
precedent. The external bare-call vocabulary becomes a facet of each framework
module (`RubyFrameworkVocabulary` = `entries` + `runtimeBuiltins` +
`hasExternalMember`), composed via a typed `FRAMEWORKS` registry + an
`isExternalBareCall` fold.

**Tech Stack:** TypeScript (ESM), vitest, tree-sitter (not touched here).

## Global Constraints

- Behaviour byte-identical — the codegraph resolve metric (`byReceiverKind` /
  `resolveSuccessRate`) must NOT move. This is a structural refactor, NOT a
  behaviour change.
- `CallResolver` (`contracts/types/codegraph.ts:546`) and its mirror
  `LanguageSymbolResolver` (`contracts/types/language.ts:339`) signatures are
  IMMUTABLE (the 5-language seam). The ONLY additive contract change allowed:
  the new `ExternalVocabulary` interface.
- Business-logic tests are IMMUTABLE: move OK, rewrite NO.
  `ruby-resolver-dispatch.test.ts` + `ruby-resolver-external-import.test.ts` +
  `ruby-resolver.test.ts` are the regression net — they MUST stay green
  untouched through the whole migration.
- No `eslint-disable`; never lower coverage thresholds; no `v8 ignore` as a
  shortcut.
- TDD for net-new units (red→green; new entities get new tests). Relocation
  steps (moving code between files, behaviour identical) write NO new tests
  during the move and do NOT rewrite existing business-logic tests (rule
  `feedback_refactor_migration_test_order`).
- Conventional commits: `refactor(trajectory)` / `feat(contracts)` /
  `docs(<scope>)`; header ≤100 chars; the Task 5 `ruby-resolver.ts` hub commit
  needs a silo-pairing `Why:` line.
- Worktree `.claude/worktrees/ruby-dsl-decomposition` at main `c5af636b`.
  Ephemeral branch — do NOT push. commit ≠ merge ≠ push.
- Quality gates per task: `npx vitest run` green, `tsc` 0 errors, ESLint 0 (the
  pre-commit hook runs tests + coverage + type-check in parallel).
- Live huginn validation is OPTIONAL and post-merge (behaviour-identical
  refactor — the metric must not move); NOT a required plan task; no duplicate
  measurement.

## File Structure

| File                                                               | Responsibility                                                                         | Task |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ---- |
| `contracts/types/language.ts`                                      | +`ExternalVocabulary` interface (additive)                                             | 1    |
| `domains/language/external-classifier.ts` (NEW)                    | `ExternalCallClassifier` — null-vs-qualified branch over an injected vocab             | 1    |
| `domains/language/resolver-chain.ts`                               | +`resolveDispatchViaComponents` (sibling of `resolveViaChain`)                         | 2    |
| `domains/language/ruby/dsl/types.ts`                               | `RubyDslModule` → `RubyFrameworkVocabulary` (+`runtimeBuiltins`, +`hasExternalMember`) | 3    |
| `domains/language/ruby/dsl/framework-module.ts` (NEW)              | `defineFrameworkVocabulary` factory (membership logic, once)                           | 3    |
| `domains/language/ruby/dsl/kernel-builtins.ts` (NEW, relocated)    | `RUBY_KERNEL_BUILTINS` data, dsl home                                                  | 3    |
| `domains/language/ruby/dsl/ruby-core.ts`                           | `RUBY_CORE_VOCABULARY` (owns `RUBY_KERNEL_BUILTINS`)                                   | 3    |
| `domains/language/ruby/dsl/rails.ts`                               | `RAILS_VOCABULARY` (owns `RAILS_RUNTIME_BUILTINS`)                                     | 3    |
| `domains/language/ruby/dsl/activesupport.ts`                       | `ACTIVESUPPORT_VOCABULARY`                                                             | 3    |
| `domains/language/ruby/dsl/catalogue.ts`                           | `FRAMEWORKS` typed array; `composeEntries`; `isExternalBareCall` fold                  | 3    |
| `domains/language/ruby/dsl/index.ts`                               | barrel exports                                                                         | 3    |
| `domains/language/ruby/resolver/ruby-external-vocabulary.ts` (NEW) | `RubyExternalVocabulary` — dsl↔resolver bridge                                         | 4    |
| `domains/language/ruby/resolver/ruby-resolver.ts`                  | facade delegates (HUB — only 2 methods + ctor)                                         | 5    |
| `domains/language/ruby/resolver/kernel-builtins.ts`                | DELETED (absorbed)                                                                     | 6    |
| `.claude/rules/resolver-architecture.md` (NEW)                     | the resolver rule                                                                      | 7    |

---

### Task 1: `ExternalVocabulary` interface + `ExternalCallClassifier` engine

**Files:**

- Modify: `src/core/contracts/types/language.ts` (add interface beside
  `ConeTypeLocator`)
- Create: `src/core/domains/language/external-classifier.ts`
- Test: `tests/core/domains/language/external-classifier.test.ts`

**Interfaces:**

- Consumes: `CallRef`, `CallContext` from `contracts/types/codegraph.js`.
- Produces:
  `interface ExternalVocabulary { isBareCallExternal(member: string): boolean; isQualifiedReceiverExternal(receiver: string, ctx: CallContext): boolean }`;
  `class ExternalCallClassifier` with
  `targetsExternal(call: CallRef, ctx: CallContext): boolean`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/domains/language/external-classifier.test.ts
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
} from "../../../../src/core/contracts/types/codegraph.js";
import type { ExternalVocabulary } from "../../../../src/core/contracts/types/language.js";
import { ExternalCallClassifier } from "../../../../src/core/domains/language/external-classifier.js";

const ctx = {} as CallContext;
const fakeVocab: ExternalVocabulary = {
  isBareCallExternal: (m) => m === "render",
  isQualifiedReceiverExternal: (r) => r === "Net::HTTP",
};

describe("ExternalCallClassifier", () => {
  const classifier = new ExternalCallClassifier(fakeVocab);

  it("routes a bare call (receiver null) to isBareCallExternal", () => {
    const ext: CallRef = {
      callText: "render",
      receiver: null,
      member: "render",
      startLine: 1,
    };
    const proj: CallRef = {
      callText: "my_helper",
      receiver: null,
      member: "my_helper",
      startLine: 1,
    };
    expect(classifier.targetsExternal(ext, ctx)).toBe(true);
    expect(classifier.targetsExternal(proj, ctx)).toBe(false);
  });

  it("routes a qualified call (receiver set) to isQualifiedReceiverExternal", () => {
    const gem: CallRef = {
      callText: "Net::HTTP.get",
      receiver: "Net::HTTP",
      member: "get",
      startLine: 1,
    };
    const proj: CallRef = {
      callText: "User.find",
      receiver: "User",
      member: "find",
      startLine: 1,
    };
    expect(classifier.targetsExternal(gem, ctx)).toBe(true);
    expect(classifier.targetsExternal(proj, ctx)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/domains/language/external-classifier.test.ts`
Expected: FAIL — `Cannot find module '.../external-classifier.js'` /
`ExternalVocabulary` not exported.

- [ ] **Step 3: Add the `ExternalVocabulary` interface**

Append to `src/core/contracts/types/language.ts`, immediately after the
`ConeTypeLocator` interface (≈ line 106):

```ts
/**
 * The language-specific predicates the generic `ExternalCallClassifier`
 * (`domains/language/external-classifier.ts`) needs to decide whether an
 * UNRESOLVED call targets an external library / framework runtime rather than an
 * in-project resolver miss. The engine owns the language-neutral receiver-shape
 * branch (bare call vs qualified receiver); these two predicates own the
 * language-specific decisions (which bare member names are framework vocabulary,
 * and whether a qualified receiver resolves in-project). One implementation per
 * language (`RubyExternalVocabulary`, …). Mirrors `ConeTypeLocator`.
 */
export interface ExternalVocabulary {
  /** Is this no-receiver member a framework/runtime/builtin name (zero project defs)? */
  isBareCallExternal(member: string): boolean;
  /** Does this qualified receiver name a gem/stdlib symbol (no in-project target)? */
  isQualifiedReceiverExternal(receiver: string, ctx: CallContext): boolean;
}
```

- [ ] **Step 4: Implement the engine**

```ts
// src/core/domains/language/external-classifier.ts
import type { CallContext, CallRef } from "../../contracts/types/codegraph.js";
import type { ExternalVocabulary } from "../../contracts/types/language.js";

/**
 * Language-neutral external-call classifier (bd tea-rags-mcp-cai0). For an
 * UNRESOLVED call, decides whether it targets an external library / framework
 * runtime (→ excluded from the resolveSuccessRate denominator as
 * `callsExternalSkipped`) rather than an in-project resolver miss.
 *
 * The engine owns the one genuinely language-neutral fact: a call either has no
 * receiver (bare call → consult the bare-call vocabulary) or a qualified
 * receiver (→ consult the qualified-receiver predicate). The two
 * language-specific predicates are injected via `ExternalVocabulary`, so no
 * language's lexical conventions (what counts as a "constant" receiver, which
 * member names are framework macros) leak into this shared core. Mirrors
 * `ConeDispatchResolver` (engine = structure, locator = language primitives).
 */
export class ExternalCallClassifier {
  constructor(private readonly vocab: ExternalVocabulary) {}

  targetsExternal(call: CallRef, ctx: CallContext): boolean {
    return call.receiver === null
      ? this.vocab.isBareCallExternal(call.member)
      : this.vocab.isQualifiedReceiverExternal(call.receiver, ctx);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/core/domains/language/external-classifier.test.ts`
Expected: PASS (both tests).

- [ ] **Step 6: Commit**

```bash
git add src/core/contracts/types/language.ts src/core/domains/language/external-classifier.ts tests/core/domains/language/external-classifier.test.ts
git commit -m "feat(contracts): ExternalVocabulary interface + generic ExternalCallClassifier engine"
```

---

### Task 2: `resolveDispatchViaComponents` engine

**Files:**

- Modify: `src/core/domains/language/resolver-chain.ts` (add function + import)
- Test: `tests/core/domains/language/resolver-chain.test.ts` (append describe;
  create file if absent)

**Interfaces:**

- Consumes: `DispatchResolverComponent`, `CallRef`, `CallContext`,
  `DispatchEdge`.
- Produces:
  `resolveDispatchViaComponents(components: readonly DispatchResolverComponent[], call: CallRef, ctx: CallContext): DispatchEdge[]`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/domains/language/resolver-chain.test.ts  (append; if the file does not exist, create with these imports)
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  DispatchEdge,
} from "../../../../src/core/contracts/types/codegraph.js";
import type { DispatchResolverComponent } from "../../../../src/core/contracts/types/language.js";
import { resolveDispatchViaComponents } from "../../../../src/core/domains/language/resolver-chain.js";

const call = {
  callText: "x.m",
  receiver: "x",
  member: "m",
  startLine: 1,
} as CallRef;
const ctx = {} as CallContext;
const edge = (rel: string): DispatchEdge => ({
  sourceSymbolId: null,
  targetRelPath: rel,
  targetSymbolId: null,
  edgeKind: "dynamic",
  confidence: 1,
});
const component = (edges: DispatchEdge[]): DispatchResolverComponent => ({
  resolveDispatch: () => edges,
});

describe("resolveDispatchViaComponents", () => {
  it("returns the first non-empty component result (precedence = array order)", () => {
    const result = resolveDispatchViaComponents(
      [component([]), component([edge("a.rb")]), component([edge("b.rb")])],
      call,
      ctx,
    );
    expect(result).toEqual([edge("a.rb")]);
  });

  it("returns [] when every component is empty", () => {
    expect(
      resolveDispatchViaComponents([component([]), component([])], call, ctx),
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/domains/language/resolver-chain.test.ts`
Expected: FAIL — `resolveDispatchViaComponents` is not exported.

- [ ] **Step 3: Implement the engine**

Add to `src/core/domains/language/resolver-chain.ts`. Extend the import line and
append the function:

```ts
// extend the existing top import:
import type {
  CallContext,
  CallRef,
  DispatchEdge,
  SymbolResolutionTarget,
} from "../../contracts/types/codegraph.js";
import type {
  DispatchResolverComponent,
  SymbolResolutionStrategy,
} from "../../contracts/types/language.js";
```

```ts
/**
 * Drive an ordered list of dispatch components, returning the first NON-EMPTY
 * fan-out. The order IS the precedence (a component earlier in the array wins).
 * This is the fan-out mirror of `resolveViaChain`: "decisive" = non-empty here.
 * A per-language resolver composes its `DispatchResolverComponent[]` (e.g. Ruby:
 * registry-table → CHA-cone → dynamic-receiver) through this engine instead of
 * an inline if-ladder, so the precedence-compose is shared across languages.
 */
export function resolveDispatchViaComponents(
  components: readonly DispatchResolverComponent[],
  call: CallRef,
  ctx: CallContext,
): DispatchEdge[] {
  for (const component of components) {
    const edges = component.resolveDispatch(call, ctx);
    if (edges.length > 0) return edges;
  }
  return [];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/domains/language/resolver-chain.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/language/resolver-chain.ts tests/core/domains/language/resolver-chain.test.ts
git commit -m "feat(trajectory): resolveDispatchViaComponents engine (fan-out mirror of resolveViaChain)"
```

---

### Task 3: Framework-vocabulary registry (`RubyFrameworkVocabulary` + `FRAMEWORKS` + `isExternalBareCall`)

**Files:**

- Modify: `src/core/domains/language/ruby/dsl/types.ts` (`RubyDslModule` →
  `RubyFrameworkVocabulary`)
- Create: `src/core/domains/language/ruby/dsl/framework-module.ts`
  (`defineFrameworkVocabulary`)
- Create: `src/core/domains/language/ruby/dsl/kernel-builtins.ts` (relocated
  `RUBY_KERNEL_BUILTINS` data; copy of the resolver one — the resolver copy is
  deleted in Task 6)
- Modify: `src/core/domains/language/ruby/dsl/ruby-core.ts`, `rails.ts`,
  `activesupport.ts` (become `RubyFrameworkVocabulary`)
- Modify: `src/core/domains/language/ruby/dsl/catalogue.ts` (`FRAMEWORKS`,
  `composeEntries`, `isExternalBareCall`)
- Modify: `src/core/domains/language/ruby/dsl/index.ts` (barrel)
- Test: `tests/core/domains/language/ruby/dsl/framework-module.test.ts` (NEW)

**Interfaces:**

- Consumes: `RubyDslEntry`, `RUBY_KERNEL_BUILTINS`, `RAILS_RUNTIME_BUILTINS`.
- Produces:
  `interface RubyFrameworkVocabulary { framework: string; entries: Record<string, RubyDslEntry>; runtimeBuiltins?: ReadonlySet<string>; hasExternalMember(member: string): boolean }`;
  `defineFrameworkVocabulary(framework, entries, runtimeBuiltins?): RubyFrameworkVocabulary`;
  `isExternalBareCall(member: string): boolean`; `RUBY_DSL` (unchanged shape).

> Note: this task RELOCATES `RUBY_KERNEL_BUILTINS` into `dsl/kernel-builtins.ts`
> by COPY (the resolver still imports its own `resolver/kernel-builtins.ts` copy
> until Task 5; the two consts are identical, behaviour identical). Task 6
> deletes the resolver copy. `RAILS_RUNTIME_BUILTINS` is already in
> `dsl/rails-runtime.ts` — no move.

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/domains/language/ruby/dsl/framework-module.test.ts
import { describe, expect, it } from "vitest";

import { isExternalBareCall } from "../../../../../../src/core/domains/language/ruby/dsl/catalogue.js";
import { defineFrameworkVocabulary } from "../../../../../../src/core/domains/language/ruby/dsl/framework-module.js";

describe("defineFrameworkVocabulary", () => {
  const vocab = defineFrameworkVocabulary(
    "demo",
    { has_many: { category: "association" } },
    new Set(["render"]),
  );

  it("hasExternalMember is true for an entry key (declaring macro)", () => {
    expect(vocab.hasExternalMember("has_many")).toBe(true);
  });
  it("hasExternalMember is true for a runtime builtin", () => {
    expect(vocab.hasExternalMember("render")).toBe(true);
  });
  it("hasExternalMember is false for an unknown member", () => {
    expect(vocab.hasExternalMember("create_event")).toBe(false);
  });
  it("treats omitted runtimeBuiltins as empty (no throw)", () => {
    const noRuntime = defineFrameworkVocabulary("x", {
      foo: { category: "other" },
    });
    expect(noRuntime.hasExternalMember("render")).toBe(false);
    expect(noRuntime.hasExternalMember("foo")).toBe(true);
  });
});

describe("isExternalBareCall (registry fold over FRAMEWORKS)", () => {
  it("is true for a Rails DSL macro, a Rails runtime helper, and a Kernel builtin", () => {
    expect(isExternalBareCall("has_many")).toBe(true); // rails entry
    expect(isExternalBareCall("params")).toBe(true); // rails runtime
    expect(isExternalBareCall("puts")).toBe(true); // ruby-core kernel
  });
  it("is false for a project method name", () => {
    expect(isExternalBareCall("create_event")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/domains/language/ruby/dsl/framework-module.test.ts`
Expected: FAIL — `framework-module.js` / `isExternalBareCall` not found.

- [ ] **Step 3: Broaden the type in `dsl/types.ts`**

Replace the `RubyDslModule` interface (≈ lines 52-60) with:

```ts
/**
 * A per-framework slice of the external vocabulary. Each framework owns its
 * class-body declaring macros (`entries`) AND its non-declaring runtime / kernel
 * helpers (`runtimeBuiltins`) in its own file; `catalogue.ts` composes their
 * `entries` into `RUBY_DSL` and folds `hasExternalMember` into `isExternalBareCall`.
 * Adding a framework = a new module file + one line in `catalogue.ts`'s FRAMEWORKS.
 */
export interface RubyFrameworkVocabulary {
  readonly framework: string; // "ruby-core" | "activesupport" | "rails"
  readonly entries: Record<string, RubyDslEntry>;
  /** Non-declaring framework/runtime/kernel helpers (params/render; puts/raise/require). */
  readonly runtimeBuiltins?: ReadonlySet<string>;
  /** Is `member` part of this framework's external-callable surface? */
  hasExternalMember(member: string): boolean;
}
```

- [ ] **Step 4: Add the factory**

```ts
// src/core/domains/language/ruby/dsl/framework-module.ts
import type { RubyDslEntry, RubyFrameworkVocabulary } from "./types.js";

/**
 * Build a `RubyFrameworkVocabulary` from a framework's declaring macros
 * (`entries`) and optional runtime helpers (`runtimeBuiltins`). The membership
 * logic — entries-key OR runtime-builtin — lives HERE once, so no consumer
 * reaches into the storage shape (`Record` key test vs `Set.has`). A factory,
 * not a container: each framework module calls it with its own data.
 */
export function defineFrameworkVocabulary(
  framework: string,
  entries: Record<string, RubyDslEntry>,
  runtimeBuiltins?: ReadonlySet<string>,
): RubyFrameworkVocabulary {
  return {
    framework,
    entries,
    runtimeBuiltins,
    hasExternalMember: (member) =>
      member in entries || (runtimeBuiltins?.has(member) ?? false),
  };
}
```

- [ ] **Step 5: Relocate `RUBY_KERNEL_BUILTINS` into dsl/ (copy)**

Create `src/core/domains/language/ruby/dsl/kernel-builtins.ts` with the SAME
content as `resolver/kernel-builtins.ts` (copy the `RUBY_KERNEL_BUILTINS` set +
its doc comment verbatim). Do NOT edit the resolver copy yet.

- [ ] **Step 6: Convert the framework modules**

`dsl/ruby-core.ts` — wrap the existing entries with the factory and attach the
kernel builtins:

```ts
import { defineFrameworkVocabulary } from "./framework-module.js";
import { RUBY_KERNEL_BUILTINS } from "./kernel-builtins.js";

// ... keep the existing entries object, renamed to a local const RUBY_CORE_ENTRIES ...
export const RUBY_CORE_VOCABULARY = defineFrameworkVocabulary(
  "ruby-core",
  RUBY_CORE_ENTRIES,
  RUBY_KERNEL_BUILTINS,
);
```

`dsl/rails.ts` — same pattern, attach the existing Rails runtime set:

```ts
import { defineFrameworkVocabulary } from "./framework-module.js";
import { RAILS_RUNTIME_BUILTINS } from "./rails-runtime.js";

// ... keep the existing entries object as a local const RAILS_ENTRIES ...
export const RAILS_VOCABULARY = defineFrameworkVocabulary(
  "rails",
  RAILS_ENTRIES,
  RAILS_RUNTIME_BUILTINS,
);
```

`dsl/activesupport.ts` — no runtime builtins, just wrap:

```ts
import { defineFrameworkVocabulary } from "./framework-module.js";

// ... keep the existing entries as ACTIVESUPPORT_ENTRIES ...
export const ACTIVESUPPORT_VOCABULARY = defineFrameworkVocabulary(
  "activesupport",
  ACTIVESUPPORT_ENTRIES,
);
```

- [ ] **Step 7: Rewire `dsl/catalogue.ts`**

Rename `composeModules` → `composeEntries`, point `FRAMEWORKS` at the
vocabularies, add the fold. Keep the dup-key guard:

```ts
import { ACTIVESUPPORT_VOCABULARY } from "./activesupport.js";
import { RAILS_VOCABULARY } from "./rails.js";
import { RUBY_CORE_VOCABULARY } from "./ruby-core.js";
import type { RubyDslEntry, RubyFrameworkVocabulary } from "./types.js";

/** Merge per-framework `entries` into one keyword → entry lookup. Throws on a
 *  duplicate keyword across modules (a keyword must belong to exactly one
 *  framework) — a programming error caught at module load. */
export function composeEntries(
  modules: readonly RubyFrameworkVocabulary[],
): Record<string, RubyDslEntry> {
  const out: Record<string, RubyDslEntry> = {};
  for (const mod of modules) {
    for (const [keyword, entry] of Object.entries(mod.entries)) {
      if (keyword in out) {
        throw new Error(
          `Ruby DSL catalogue: duplicate keyword "${keyword}" (module "${mod.framework}")`,
        );
      }
      out[keyword] = entry;
    }
  }
  return out;
}

const FRAMEWORKS: readonly RubyFrameworkVocabulary[] = [
  RUBY_CORE_VOCABULARY,
  ACTIVESUPPORT_VOCABULARY,
  RAILS_VOCABULARY,
];

export const RUBY_DSL: Record<string, RubyDslEntry> =
  composeEntries(FRAMEWORKS);

/** Is `member` an external bare-call name in ANY registered framework
 *  (declaring macro OR runtime/kernel helper)? Fold over the registry — adding a
 *  framework needs no edit here. */
export const isExternalBareCall = (member: string): boolean =>
  FRAMEWORKS.some((f) => f.hasExternalMember(member));
```

- [ ] **Step 8: Update the barrel `dsl/index.ts`**

```ts
export { isExternalBareCall, RUBY_DSL } from "./catalogue.js";
export { defineFrameworkVocabulary } from "./framework-module.js";
export type {
  DeclaredMethodSpec,
  DslCategory,
  MethodKind,
  RubyDslEntry,
  RubyFrameworkVocabulary,
} from "./types.js";
export { singularizeAssociation } from "./inflection.js";
export { RAILS_RUNTIME_BUILTINS } from "./rails-runtime.js"; // kept until Task 5 stops the resolver's direct use
```

- [ ] **Step 9: Preserve the relocated rails-runtime test**

`tests/.../ruby/dsl/rails-runtime.test.ts` already asserts
`RAILS_RUNTIME_BUILTINS` membership — it still imports from
`dsl/rails-runtime.js`, which is unchanged. Leave its assertions intact
(domains-language rule: preserve examples). No edit required unless the import
path moved (it did not).

- [ ] **Step 10: Run the dsl + full suite to verify green**

Run: `npx vitest run tests/core/domains/language/ruby/dsl/` Expected: PASS — new
`framework-module.test.ts` green, existing `rails-runtime.test.ts` green. Run:
`npx vitest run` (full) + `npx tsc --noEmit` Expected: all green, 0 type errors
(the resolver still compiles — it imports `RUBY_DSL`/`RAILS_RUNTIME_BUILTINS`
from the barrel and `RUBY_KERNEL_BUILTINS` from its own copy, all still
present).

- [ ] **Step 11: Commit**

```bash
git add src/core/domains/language/ruby/dsl/ tests/core/domains/language/ruby/dsl/framework-module.test.ts
git commit -m "feat(trajectory): per-framework RubyFrameworkVocabulary registry + isExternalBareCall fold"
```

---

### Task 4: `RubyExternalVocabulary` adapter

**Files:**

- Create: `src/core/domains/language/ruby/resolver/ruby-external-vocabulary.ts`
- Test:
  `tests/core/domains/language/ruby/resolver/ruby-external-vocabulary.test.ts`

**Interfaces:**

- Consumes: `ExternalVocabulary` (Task 1), `isExternalBareCall` (Task 3),
  `resolveConstant` (from `./strategies/index.js`), `CallContext`.
- Produces: `class RubyExternalVocabulary implements ExternalVocabulary`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/domains/language/ruby/resolver/ruby-external-vocabulary.test.ts
import { describe, expect, it } from "vitest";

import type { CallContext } from "../../../../../../src/core/contracts/types/codegraph.js";
import { RubyExternalVocabulary } from "../../../../../../src/core/domains/language/ruby/resolver/ruby-external-vocabulary.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const ctx = (table: InMemoryGlobalSymbolTable): CallContext => ({
  callerFile: "app/models/account.rb",
  callerScope: [],
  imports: [],
  symbolTable: table,
});

describe("RubyExternalVocabulary", () => {
  const vocab = new RubyExternalVocabulary();

  it("isBareCallExternal delegates to the framework registry", () => {
    expect(vocab.isBareCallExternal("has_many")).toBe(true); // rails macro
    expect(vocab.isBareCallExternal("params")).toBe(true); // rails runtime
    expect(vocab.isBareCallExternal("puts")).toBe(true); // kernel
    expect(vocab.isBareCallExternal("my_helper")).toBe(false); // project method
  });

  it("isQualifiedReceiverExternal flags an unresolved constant (gem/stdlib)", () => {
    expect(
      vocab.isQualifiedReceiverExternal(
        "Net::HTTP",
        ctx(new InMemoryGlobalSymbolTable()),
      ),
    ).toBe(true);
  });

  it("does NOT flag a constant that resolves to a project file", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/models/user.rb", [
      {
        symbolId: "User",
        fqName: "User",
        shortName: "User",
        relPath: "app/models/user.rb",
        scope: [],
      },
    ]);
    expect(vocab.isQualifiedReceiverExternal("User", ctx(table))).toBe(false);
  });

  it("does NOT flag a lowercase receiver (local var / self)", () => {
    expect(
      vocab.isQualifiedReceiverExternal(
        "user",
        ctx(new InMemoryGlobalSymbolTable()),
      ),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/domains/language/ruby/resolver/ruby-external-vocabulary.test.ts`
Expected: FAIL — `ruby-external-vocabulary.js` not found.

- [ ] **Step 3: Implement the adapter**

```ts
// src/core/domains/language/ruby/resolver/ruby-external-vocabulary.ts
import type { CallContext } from "../../../../contracts/types/codegraph.js";
import type { ExternalVocabulary } from "../../../../contracts/types/language.js";
import { isExternalBareCall } from "../dsl/index.js";
import { resolveConstant } from "./strategies/index.js";

/**
 * Ruby implementation of `ExternalVocabulary`, bridging the `dsl/` framework
 * registry (bare-call names) with the resolver's `resolveConstant` (qualified
 * receivers). A no-receiver member is external iff it is a registered framework
 * macro / runtime / kernel name (`isExternalBareCall`). A constant receiver
 * (`Net::HTTP`, `Base64`) is external iff `resolveConstant` cannot map it to a
 * project / Zeitwerk file — a gem or stdlib constant. A lowercase receiver
 * (local var / `self`) cannot be told apart from a project method, so it stays
 * non-external (conservative). A project method shadowing a framework name
 * resolves first via the chain and never reaches this hook (tea-rags-mcp-5os8y).
 */
export class RubyExternalVocabulary implements ExternalVocabulary {
  isBareCallExternal(member: string): boolean {
    return isExternalBareCall(member);
  }

  isQualifiedReceiverExternal(receiver: string, ctx: CallContext): boolean {
    return /^[A-Z]/.test(receiver) && resolveConstant(receiver, ctx) === null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
`npx vitest run tests/core/domains/language/ruby/resolver/ruby-external-vocabulary.test.ts`
Expected: PASS (all 4).

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/language/ruby/resolver/ruby-external-vocabulary.ts tests/core/domains/language/ruby/resolver/ruby-external-vocabulary.test.ts
git commit -m "feat(trajectory): RubyExternalVocabulary bridging dsl registry + resolveConstant"
```

---

### Task 5: Facade delegation (`RubyCallResolver` — the HUB switch)

**Files:**

- Modify: `src/core/domains/language/ruby/resolver/ruby-resolver.ts`
  (constructor + `resolveDispatch` + `targetsExternalImport` + imports ONLY)
- Regression net (DO NOT EDIT, must stay green):
  `tests/.../ruby/resolver/ruby-resolver-dispatch.test.ts`,
  `ruby-resolver-external-import.test.ts`, `ruby-resolver.test.ts`

**Interfaces:**

- Consumes: `resolveDispatchViaComponents` (Task 2), `ExternalCallClassifier`
  (Task 1), `RubyExternalVocabulary` (Task 4), `DispatchResolverComponent`.
- Produces: unchanged `CallResolver` surface (`resolve` / `resolveDispatch` /
  `targetsExternalImport` / `resolveFileEdges`).

- [ ] **Step 1: Run the regression net BEFORE editing (baseline green)**

Run: `npx vitest run tests/core/domains/language/ruby/resolver/` Expected: PASS
— record the count; it must be identical after the edit.

- [ ] **Step 2: Update imports**

In `ruby-resolver.ts`: remove `RUBY_KERNEL_BUILTINS` (from
`./kernel-builtins.js`) and drop `RAILS_RUNTIME_BUILTINS, RUBY_DSL` from the
`../dsl/index.js` import (keep `resolveConstant` import from
`./strategies/index.js` — still used by `resolveFileEdges`). Add:

```ts
import type { DispatchResolverComponent } from "../../../../contracts/types/language.js";
import { ExternalCallClassifier } from "../../external-classifier.js";
import {
  resolveDispatchViaComponents,
  resolveViaChain,
} from "../../resolver-chain.js";
import { RubyExternalVocabulary } from "./ruby-external-vocabulary.js";
```

- [ ] **Step 3: Wire collaborators in the constructor**

Add fields and constructor wiring (keep the existing `table`/`cone`/`dynamic`
construction):

```ts
  private readonly dispatchComponents: readonly DispatchResolverComponent[];
  private readonly externalClassifier: ExternalCallClassifier;
```

at the end of the constructor body, after
`this.dynamic = new RubyDynamicDispatchResolver(cfg);`:

```ts
this.dispatchComponents = [this.table, this.cone, this.dynamic];
this.externalClassifier = new ExternalCallClassifier(
  new RubyExternalVocabulary(),
);
```

- [ ] **Step 4: Delegate the two methods**

Replace the `resolveDispatch` body:

```ts
  resolveDispatch(call: CallRef, ctx: CallContext): DispatchEdge[] {
    return resolveDispatchViaComponents(this.dispatchComponents, call, ctx);
  }
```

Replace the `targetsExternalImport` body:

```ts
  targetsExternalImport(call: CallRef, ctx: CallContext): boolean {
    return this.externalClassifier.targetsExternal(call, ctx);
  }
```

Do NOT touch `resolve`, `resolveFileEdges`, or the env-parse helpers. Keep the
existing method doc comments (or trim to point at the engines) — behaviour is
unchanged.

- [ ] **Step 5: Run the regression net to verify byte-identical behaviour**

Run: `npx vitest run tests/core/domains/language/ruby/resolver/` Expected: PASS
— the SAME count as Step 1. `ruby-resolver-dispatch.test.ts` and
`ruby-resolver-external-import.test.ts` green untouched. Run: `npx tsc --noEmit`
Expected: 0 errors (the now-removed imports leave no dangling reference;
`RUBY_DSL`/`RAILS_RUNTIME_BUILTINS`/`RUBY_KERNEL_BUILTINS` are no longer
referenced in this file).

- [ ] **Step 6: Commit (with silo-pairing Why line)**

```bash
git add src/core/domains/language/ruby/resolver/ruby-resolver.ts
git commit -m "refactor(trajectory): RubyCallResolver delegates dispatch + external classification to engines" \
  -m "Why: ruby-resolver.ts is a fanIn-9 hub; the resolveDispatch/targetsExternalImport chunks were artk0de-100% deep-silo. Decomposed behind the immutable CallResolver facade so the hub shrinks without a contract change; regression net (dispatch + external-import tests) green untouched."
```

---

### Task 6: Cleanup — remove the orphaned resolver kernel-builtins copy

**Files:**

- Delete: `src/core/domains/language/ruby/resolver/kernel-builtins.ts`
- Move (if present): `tests/.../ruby/resolver/kernel-builtins.test.ts` →
  `tests/.../ruby/dsl/kernel-builtins.test.ts` (retarget import to
  `dsl/kernel-builtins.js`; keep assertions)
- Verify: no remaining importer of `resolver/kernel-builtins.js`

- [ ] **Step 1: Confirm the resolver copy is unused**

Run: `grep -rn "resolver/kernel-builtins" src/ tests/` Expected: ZERO hits (Task
5 removed the only importer). If a test still imports it, it is
`kernel-builtins.test.ts` — handle in Step 2.

- [ ] **Step 2: Relocate the test (if it exists) and delete the source**

If `tests/.../ruby/resolver/kernel-builtins.test.ts` exists, move it to
`tests/.../ruby/dsl/kernel-builtins.test.ts` and change its import to
`../../../../../../src/core/domains/language/ruby/dsl/kernel-builtins.js`. Keep
its assertions verbatim (preserve examples). Then:

```bash
git rm src/core/domains/language/ruby/resolver/kernel-builtins.ts
```

- [ ] **Step 3: Run full suite + type check**

Run: `npx vitest run` and `npx tsc --noEmit` Expected: all green, 0 type errors,
no dangling import.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(trajectory): drop orphaned resolver kernel-builtins copy (absorbed into dsl)"
```

---

### Task 7: Author `.claude/rules/resolver-architecture.md`

**Files:**

- Create: `.claude/rules/resolver-architecture.md`

- [ ] **Step 1: Write the rule with `paths:` frontmatter**

```markdown
---
paths:
  - "src/core/domains/language/resolver-chain.ts"
  - "src/core/domains/language/external-classifier.ts"
  - "src/core/domains/language/cone-dispatch.ts"
  - "src/core/domains/language/*/resolver/**"
  - "src/core/domains/language/*/dsl/**"
  - "src/core/contracts/types/language.ts"
  - "tests/core/domains/language/*/resolver/**"
---

# Call Resolver Architecture — How to Write One

A per-language call resolver implements the `CallResolver` contract
(`contracts/types/codegraph.ts`) and its mirror `LanguageSymbolResolver`
(`contracts/types/language.ts`). Both are the 5-language seam. Decompose
responsibilities BEHIND the facade — never grow a god-class, never change the
contract to decompose.

## 1. The facade is thin; responsibilities are engines + injected collaborators

Each `CallResolver` method delegates to a generic engine in `domains/language/`
that is parameterised by a small per-language interface in
`contracts/types/language.ts`:

- resolution chain → `resolveViaChain(SymbolResolutionStrategy[])`
- dispatch fan-out → `resolveDispatchViaComponents(DispatchResolverComponent[])`
  and `ConeDispatchResolver(ConeTypeLocator)`
- external classification → `ExternalCallClassifier(ExternalVocabulary)`

The engine owns the language-NEUTRAL structure (chain precedence,
first-non-empty fan-out, null-vs-qualified receiver branch). The injected
interface owns the language primitives. This is the cone-dispatch precedent —
copy it for any new responsibility.

## 2. No inline disjunction over data constants

A classifier predicate must fold over a typed registry of polymorphic sources:

    isExternalBareCall(m) = FRAMEWORKS.some((f) => f.hasExternalMember(m))

NOT `A.has(m) || m in B || C.has(m)`. External vocabulary is a facet of each
framework module (`RubyFrameworkVocabulary`: `entries` + `runtimeBuiltins` +
`hasExternalMember`). Adding a framework = one module file + one line in the
`FRAMEWORKS` array → zero resolver/predicate edits.

## 3. Registry is a typed array, not self-registration

ESM class declaration registers nothing; self-registration needs instantiation +
a central side-effect import barrel equivalent in edit-cost to the array but
untyped + stateful + import-order-sensitive. Use the typed array — it is the
house style (`composeEntries`, the factory-not-container rule in
`domains-language.md`).

## 4. Refactoring discipline

Extracting a responsibility into an engine is RELOCATION: behaviour
byte-identical, the resolve metric must not move, existing business-logic tests
stay green untouched (move OK, rewrite NO). New engines are new entities → they
get new red-green unit tests.

## Reference implementation

Ruby is the pilot: `resolveDispatchViaComponents` +
`ExternalCallClassifier`/`ExternalVocabulary` +
`RubyFrameworkVocabulary`/`FRAMEWORKS`/`isExternalBareCall` +
`RubyExternalVocabulary`. TypeScript (`ts-resolver.ts`, identical 4-method
shape) is the next migrator.
```

- [ ] **Step 2: Lint the markdown**

Run: `npx markdownlint-cli2 .claude/rules/resolver-architecture.md` (or the
repo's markdownlint command) Expected: clean (fix any line-length / heading
issues).

- [ ] **Step 3: Commit**

```bash
git add .claude/rules/resolver-architecture.md
git commit -m "docs(trajectory): add resolver-architecture rule (engines + injected collaborators)"
```

---

## Self-Review

**Spec coverage:** §Architecture 1 → Task 2; §Architecture 2 → Task 1;
§Architecture 3 → Task 3; §Architecture 4 → Task 4; §Architecture 5 → Task 5;
§Deliverable rule → Task 7; §Migration order → Task 1-6 sequence; §Regression
net → Task 5 Step 1/5 + full-suite gates. All covered.

**Type consistency:** `ExternalVocabulary` (Task 1) consumed by
`ExternalCallClassifier` (Task 1) and implemented by `RubyExternalVocabulary`
(Task 4). `resolveDispatchViaComponents` signature (Task 2) used verbatim in
Task 5. `RubyFrameworkVocabulary` / `defineFrameworkVocabulary` /
`isExternalBareCall` (Task 3) consumed in Task 4 (`isExternalBareCall`) and Task
7 (doc). `dispatchComponents: readonly DispatchResolverComponent[]` consistent
Task 2 ↔ Task 5.

**Green-at-every-step:** Task 3 copies (not moves) `RUBY_KERNEL_BUILTINS` so the
resolver keeps compiling; Task 5 drops the resolver's direct use; Task 6 deletes
the now-unused copy. No step leaves a dangling import.
