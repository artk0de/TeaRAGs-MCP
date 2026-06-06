# TS Same-File Resolution Pass — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `sameFile` resolution strategy to the TypeScript codegraph resolver chain so calls whose target is defined in the caller's own file resolve even when the short-name is globally ambiguous.

**Architecture:** A new single-purpose `SymbolResolutionStrategy` inserted at chain position 8 (after `receiverSymbol`, before `globalShortName`). It dispatches on call shape (bare-call / same-file `new X()` / same-file `Class.static()`) and resolves only on a UNIQUE same-file candidate — strictly additive over `globalShortName`'s ambiguity-drop.

**Tech Stack:** TypeScript, vitest. Mirrors the existing strategy pattern (`constructor(cfg: ResolverConfig)` + `attempt(call, ctx)` using `resolved`/`CONTINUE` + `pickSingleCandidate`).

**Spec:** `docs/superpowers/specs/2026-06-06-ts-same-file-resolver-design.md`

---

## File Structure

- **Create:** `src/core/domains/language/typescript/resolver/strategies/ts-same-file.ts` — the new strategy (one responsibility: same-file unique-candidate resolution).
- **Modify:** `src/core/domains/language/typescript/resolver/strategies/index.ts` — export the class.
- **Modify:** `src/core/domains/language/typescript/resolver/ts-resolver.ts` — import + instantiate at chain position 8; update pass-order doc comment.
- **Modify (tests):** `tests/core/domains/language/typescript/resolver/strategies.test.ts` — add `describe("TSSameFileSymbolResolutionStrategy")` block (existing single strategy-test file — follow the established pattern, do NOT create a per-strategy file).
- **Modify (tests):** `tests/core/domains/language/typescript/resolver/ts-resolver.test.ts` — add one chain-level test (same-file wins over global ambiguity).

---

## Task 1: Unit tests for `TSSameFileSymbolResolutionStrategy` (RED)

**Files:**
- Test: `tests/core/domains/language/typescript/resolver/strategies.test.ts`

The file already defines helpers `sym(symbolId, shortName, relPath, scope)`, `tableWith(...[relPath, defs])`, `ctx(over)`, and `cfg`. Reuse them.

- [ ] **Step 1: Add the import for the new strategy**

In the existing import block from `.../strategies/index.js`, add `TSSameFileSymbolResolutionStrategy` to the named imports (alphabetical-ish, next to the others):

```typescript
  TSReceiverSymbolSymbolResolutionStrategy,
  TSSameFileSymbolResolutionStrategy,
  TSSuperSymbolResolutionStrategy,
```

- [ ] **Step 2: Append the failing describe block**

Append at the end of the file:

```typescript
describe("TSSameFileSymbolResolutionStrategy", () => {
  const strat = new TSSameFileSymbolResolutionStrategy(cfg);

  it("resolves a bare call to a same-file function when the short-name is globally ambiguous", () => {
    const symbolTable = tableWith(
      ["src/caller.ts", [sym("helper", "helper", "src/caller.ts", [])]],
      ["src/other.ts", [sym("helper", "helper", "src/other.ts", [])]],
    );
    const call: CallRef = { callText: "helper()", receiver: null, member: "helper", startLine: 1 };
    const outcome = strat.attempt(call, ctx({ symbolTable, callerFile: "src/caller.ts" }));
    expect(outcome).toEqual({ kind: "resolved", target: { targetRelPath: "src/caller.ts", targetSymbolId: "helper" } });
  });

  it("resolves a same-file `new X()` to X#constructor", () => {
    const symbolTable = tableWith([
      "src/caller.ts",
      [sym("Widget#constructor", "constructor", "src/caller.ts", ["Widget"]), sym("Widget", "Widget", "src/caller.ts", [])],
    ]);
    const call: CallRef = { callText: "new Widget()", receiver: "Widget", member: "constructor", startLine: 2 };
    const outcome = strat.attempt(call, ctx({ symbolTable, callerFile: "src/caller.ts" }));
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/caller.ts", targetSymbolId: "Widget#constructor" },
    });
  });

  it("resolves a same-file `Class.staticMember()`", () => {
    const symbolTable = tableWith([
      "src/caller.ts",
      [sym("Widget.make", "make", "src/caller.ts", ["Widget"])],
    ]);
    const call: CallRef = { callText: "Widget.make()", receiver: "Widget", member: "make", startLine: 3 };
    const outcome = strat.attempt(call, ctx({ symbolTable, callerFile: "src/caller.ts" }));
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/caller.ts", targetSymbolId: "Widget.make" },
    });
  });

  it("continues when the same name is defined more than once WITHIN the caller file", () => {
    const symbolTable = tableWith([
      "src/caller.ts",
      [sym("a.helper", "helper", "src/caller.ts", ["a"]), sym("b.helper", "helper", "src/caller.ts", ["b"])],
    ]);
    const call: CallRef = { callText: "helper()", receiver: null, member: "helper", startLine: 4 };
    const outcome = strat.attempt(call, ctx({ symbolTable, callerFile: "src/caller.ts" }));
    expect(outcome.kind).toBe("continue");
  });

  it("continues when the target is not defined in the caller file", () => {
    const symbolTable = tableWith(["src/other.ts", [sym("helper", "helper", "src/other.ts", [])]]);
    const call: CallRef = { callText: "helper()", receiver: null, member: "helper", startLine: 5 };
    const outcome = strat.attempt(call, ctx({ symbolTable, callerFile: "src/caller.ts" }));
    expect(outcome.kind).toBe("continue");
  });

  it("continues for a lowercase variable receiver (var.method is localBinding/fieldType's job)", () => {
    const symbolTable = tableWith(["src/caller.ts", [sym("Repo#list", "list", "src/caller.ts", ["Repo"])]]);
    const call: CallRef = { callText: "repo.list()", receiver: "repo", member: "list", startLine: 6 };
    const outcome = strat.attempt(call, ctx({ symbolTable, callerFile: "src/caller.ts" }));
    expect(outcome.kind).toBe("continue");
  });
});
```

- [ ] **Step 3: Run the new tests, verify they FAIL**

Run: `npx vitest run tests/core/domains/language/typescript/resolver/strategies.test.ts -t "TSSameFileSymbolResolutionStrategy"`
Expected: FAIL — `TSSameFileSymbolResolutionStrategy` is not exported (import error / undefined).

- [ ] **Step 4: Commit the RED tests**

```bash
git add tests/core/domains/language/typescript/resolver/strategies.test.ts
git commit -m "test(signals): RED — TSSameFileSymbolResolutionStrategy unit cases"
```

---

## Task 2: Implement `TSSameFileSymbolResolutionStrategy` (GREEN)

**Files:**
- Create: `src/core/domains/language/typescript/resolver/strategies/ts-same-file.ts`
- Modify: `src/core/domains/language/typescript/resolver/strategies/index.ts`

- [ ] **Step 1: Write the strategy**

Create `ts-same-file.ts`:

```typescript
import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import {
  pickSingleCandidate,
  type CallContext,
  type CallRef,
  type SymbolDefinition,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import type { ResolverConfig } from "./shared.js";

/**
 * Same-file preference (bd <epic>). Resolves a call whose target is defined in
 * the CALLER'S OWN file when the short-name is globally ambiguous — the case
 * `globalShortName` drops (N>1) and `importNarrowedFallback` can't recover (the
 * target is local, not imported). Lexical scope guarantees the same-file
 * definition is the real target, so this is a safe, deterministic resolve.
 *
 * Runs at chain position 8 (after the receiver/import strategies, before
 * `globalShortName`) so it is strictly additive: for a globally-unique name the
 * result is identical to `globalShortName`; for an ambiguous name it resolves
 * the same-file definition instead of dropping.
 *
 * Three call shapes:
 *   - bare call `helper()`            → same-file symbol with shortName `member`
 *   - same-file `new X()`             → `X#constructor` in the caller file
 *                                       (walker synthesizes it even when implicit)
 *   - same-file `Class.staticMember()`→ `Class.staticMember` in the caller file
 * A lowercase variable receiver (`obj.method()`) is NOT this pass's case —
 * variable typing is `localBinding` / `fieldType`'s job (they ran earlier).
 * Imported targets are NOT this pass's case — `namedImport` owns them.
 */
export class TSSameFileSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "sameFile";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const { receiver, member } = call;
    let candidates: SymbolDefinition[];

    if (receiver === null) {
      // bare call: helper()
      candidates = ctx.symbolTable.lookupByShortName(member).filter((d) => d.relPath === ctx.callerFile);
    } else if (member === "constructor" && /^[A-Z]/.test(receiver)) {
      // same-file new X(): target X#constructor in the caller file
      candidates = ctx.symbolTable
        .lookupByShortName("constructor")
        .filter((d) => d.relPath === ctx.callerFile && d.scope[d.scope.length - 1] === receiver);
    } else if (/^[A-Z]/.test(receiver)) {
      // same-file Class.staticMember()
      candidates = ctx.symbolTable
        .lookupByShortName(member)
        .filter((d) => d.relPath === ctx.callerFile && d.scope[d.scope.length - 1] === receiver);
    } else {
      // lowercase var.method() — not this pass's case
      return CONTINUE;
    }

    const hit = pickSingleCandidate(candidates, this.cfg.mode);
    return hit ? resolved({ targetRelPath: hit.relPath, targetSymbolId: hit.symbolId }) : CONTINUE;
  }
}
```

- [ ] **Step 2: Export from the barrel**

In `strategies/index.ts`, add the re-export alongside the others:

```typescript
export { TSSameFileSymbolResolutionStrategy } from "./ts-same-file.js";
```

- [ ] **Step 3: Run the unit tests, verify they PASS**

Run: `npx vitest run tests/core/domains/language/typescript/resolver/strategies.test.ts -t "TSSameFileSymbolResolutionStrategy"`
Expected: PASS (6/6).

- [ ] **Step 4: Commit**

```bash
git add src/core/domains/language/typescript/resolver/strategies/ts-same-file.ts src/core/domains/language/typescript/resolver/strategies/index.ts
git commit -m "feat(signals): add TSSameFileSymbolResolutionStrategy (same-file resolution pass)"
```

---

## Task 3: Wire into the resolver chain (position 8) + chain regression test

**Files:**
- Modify: `src/core/domains/language/typescript/resolver/ts-resolver.ts`
- Test: `tests/core/domains/language/typescript/resolver/ts-resolver.test.ts`

- [ ] **Step 1: Add the chain regression test (RED)**

Append a test inside the top-level `describe("TSCallResolver")` block in `ts-resolver.test.ts`. Use that file's existing symbol-table / resolver setup helpers (mirror the nearby tests for exact helper names):

```typescript
  it("prefers a same-file definition over an ambiguous global short-name", () => {
    // `helper` defined in BOTH the caller file and another file → globally
    // ambiguous. Without the sameFile pass this drops; with it, the caller's
    // own definition wins.
    const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/caller.ts", [
      { symbolId: "helper", fqName: "helper", shortName: "helper", relPath: "src/caller.ts", scope: [] },
    ]);
    symbolTable.upsertFile("src/other.ts", [
      { symbolId: "helper", fqName: "helper", shortName: "helper", relPath: "src/other.ts", scope: [] },
    ]);
    const target = resolver.resolve(
      { callText: "helper()", receiver: null, member: "helper", startLine: 1 },
      { callerFile: "src/caller.ts", callerScope: [], imports: [], symbolTable },
    );
    expect(target).toEqual({ targetRelPath: "src/caller.ts", targetSymbolId: "helper" });
  });
```

Run: `npx vitest run tests/core/domains/language/typescript/resolver/ts-resolver.test.ts -t "prefers a same-file"`
Expected: FAIL — currently resolves to `null` (globalShortName drops the ambiguous name).

> Note: if the file's setup constructs `TSCallResolver` / `InMemoryGlobalSymbolTable` via shared helpers rather than inline `new`, match that local convention instead of the inline form above. The assertion stays the same.

- [ ] **Step 2: Insert the strategy into the chain (GREEN)**

In `ts-resolver.ts`, add to the imports from `./strategies/index.js`:

```typescript
  TSReceiverSymbolSymbolResolutionStrategy,
  TSSameFileSymbolResolutionStrategy,
  TSSuperSymbolResolutionStrategy,
```

Then in the constructor's `this.strategies = [...]` array, insert between `TSReceiverSymbolSymbolResolutionStrategy` and `TSGlobalShortNameSymbolResolutionStrategy`:

```typescript
      new TSReceiverSymbolSymbolResolutionStrategy(cfg),
      new TSSameFileSymbolResolutionStrategy(cfg),
      new TSGlobalShortNameSymbolResolutionStrategy(cfg),
```

- [ ] **Step 3: Update the pass-order doc comment**

In the class-header JSDoc pass-order list, renumber so `globalShortName` and `importNarrowedFallback` shift down and the new pass is inserted:

```
 *   7. receiverSymbol (imported-files ∩ receiver-declaring-files)
 *   8. sameFile (caller-file-local definition wins over global ambiguity)
 *   9. globalShortName (global short-name lookup)
 *  10. importNarrowedFallback (narrow ambiguous N>1 by caller's imports)
```

- [ ] **Step 4: Run the chain regression test, verify PASS**

Run: `npx vitest run tests/core/domains/language/typescript/resolver/ts-resolver.test.ts -t "prefers a same-file"`
Expected: PASS.

- [ ] **Step 5: Run the WHOLE resolver test file, verify no regression**

Run: `npx vitest run tests/core/domains/language/typescript/resolver/ts-resolver.test.ts`
Expected: PASS — including the existing `"imports-narrowed fallback for ambiguous global short-name"` test (the new pass must not steal its case: that test's target is imported, not same-file).

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/language/typescript/resolver/ts-resolver.ts tests/core/domains/language/typescript/resolver/ts-resolver.test.ts
git commit -m "feat(signals): wire sameFile strategy into TS resolver chain at position 8"
```

---

## Task 4: Full suite + probe-harness regression measure

**Files:** none modified (verification only).

- [ ] **Step 1: Run the full codegraph + language test suite**

Run: `npx vitest run tests/core/domains/language tests/core/domains/trajectory/codegraph`
Expected: PASS (no regressions across resolver / walker / provider tests).

- [ ] **Step 2: Type-check + lint**

Run: `npx tsc --noEmit && npx eslint src/core/domains/language/typescript/resolver`
Expected: 0 errors.

- [ ] **Step 3: Re-run the probe harness on tea-rags (self)**

Run: `npx vitest run tests/_ts_resolve_probe.test.ts`
Expected: method-edge resolved count UP vs baseline (3323); `addressableByCategory["bare-call (no receiver)"]` and `["new LocalClass() constructor"]` DOWN. Record the new numbers.

- [ ] **Step 4: Re-run the probe harness on markdownlint-mcp**

Run: `TS_PROBE_REPO=/Users/artk0re/Dev/Tools/markdownlint-mcp npx vitest run tests/_ts_resolve_probe.test.ts`
Expected: `addressableMisses` drops from 17 toward ~0 (the bare-call same-file helpers now resolve).

- [ ] **Step 5: Record results, decide harness fate**

Record before/after deltas in the session summary. Decide with the user whether to (a) promote the harness into a kept integration test or (b) delete `tests/_ts_resolve_probe.test.ts` before finishing the branch (it carries an `eslint-disable` and must not be committed as-is).

---

## Self-Review Notes

- **Spec coverage:** bare-call (Task 1/2 case 1, Task 3), constructor (case 2), static (case 3), ambiguity-within-file CONTINUE (case 4), not-in-file CONTINUE (case 5), imported-not-same-file CONTINUE (case 6, via lowercase + the chain regression confirming namedImport still owns imports). Chain position 8 (Task 3). No self-loop guard (by design).
- **Type consistency:** `SymbolDefinition` fields (symbolId/fqName/shortName/relPath/scope), `resolved`/`CONTINUE` from `contracts/resolution.js`, `pickSingleCandidate(candidates, mode)`, `ResolverConfig { tsOptions, mode }` — all match the existing strategies verbatim.
- **No production internals of existing strategies are modified** — only an insertion in the orchestrator array + a doc comment.
