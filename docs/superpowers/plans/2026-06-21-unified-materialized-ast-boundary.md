# Unified Materialized AST Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. When execution would invoke
> superpowers:executing-plans / test-driven-development, use the **dinopowers**
> wrappers.

**Goal:** Route the entire post-parse pipeline (chunker core + per-language
chunking hooks + kernel collectSymbols + all 7 codegraph walkers + nameOf +
codegraph extractOneFile) through an immutable plain-JS `AstNode` produced by
ONE eager materialization pass, so native `Parser.SyntaxNode` is touched only by
the materializer — eliminating node-tree-sitter native-accessor non-determinism
(rdv7d).

**Architecture:** A new `AstNode` interface mirrors the 16 `Parser.SyntaxNode`
members the pipeline actually uses. `materializeTree(nativeRoot, code)` walks
the native tree once (eager, deterministic — proven by the DECIDER experiment)
into `MaterializedNode` objects (text on-demand via `code.slice`). Because
`AstNode` is a structural SUBSET of `Parser.SyntaxNode`, every `SyntaxNode`
value satisfies `AstNode`, so consumer annotations can be swapped
`Parser.SyntaxNode → AstNode` one file at a time while still receiving native
values (build green, behavior unchanged). The boundary is flipped LAST:
`chunkWithTree` materializes after `parser.parse()` and hands `AstNode`
everywhere — at which point the rdv7d repros go green.

**Tech Stack:** TypeScript (strict), tree-sitter / node-tree-sitter, vitest.

## Global Constraints

- Language-agnostic: ONE materializer fixes all languages + the chunker. No
  per-language materialization.
- Keep tree-sitter; NO WASM in this epic.
- Preserve behavior EXACTLY except determinism: previously-flaky call counts
  settle to their clean value (ruby `service_1` = 109, not 185-203).
- Per `.claude/rules/domains-language.md`: preserve EVERY walker/chunker test
  example (`it`/`describe`); validate per-file `it`/`describe` counts are
  `>= base`; adapt only imports/setup, never rewrite business-logic examples.
- `npm run build` + `tsc` = 0 errors + `eslint` = 0 errors + full
  `npx vitest run` green at EVERY task boundary.
- NO `eslint-disable`, NO lowered coverage thresholds, NO `v8 ignore` shortcuts.
- Conventional commits, scopes: `contracts`, `chunker`, `ingest`, `trajectory`.
  `feat(contracts)` for the new type, `refactor(...)` for the mechanical swaps,
  `fix(chunker)` for the boundary flip (it fixes rdv7d).
- Workers load compiled `build/.../worker.js` — run `npm run build` before any
  real-worker (pool) test.
- The DECIDER finding is the foundation: an eager single-pass capture of fragile
  accessors is deterministic.

---

## File Structure

| File                                                                             | Responsibility                                                            |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `src/core/contracts/types/ast.ts` (new)                                          | `AstNode`, `MaterializedTree` interfaces (the contract)                   |
| `src/core/contracts/index.ts`                                                    | re-export the new types                                                   |
| `src/core/domains/ingest/pipeline/chunker/materialize.ts` (new)                  | `materializeTree(nativeRoot, code): AstNode` + `MaterializedNode` class   |
| `src/core/domains/ingest/pipeline/chunker/tree-sitter.ts`                        | consume `AstNode` internally; flip the boundary (materialize after parse) |
| `src/core/contracts/types/language.ts`                                           | swap node/tree annotations to `AstNode`/`MaterializedTree`                |
| `src/core/contracts/types/chunker.ts`                                            | swap `HookContext.containerNode` + classifier node type                   |
| `src/core/domains/language/kernel/collect-symbols.ts`                            | consume `AstNode`                                                         |
| `src/core/domains/language/<lang>/walker/*` (7)                                  | `nameOf` + walk passes consume `AstNode`                                  |
| `src/core/domains/language/<lang>/chunking/*`                                    | hooks consume `AstNode`                                                   |
| `src/core/domains/language/ruby/walker/ast-utils.ts`                             | `walk` over `AstNode`                                                     |
| `src/core/domains/trajectory/codegraph/symbols/provider.ts`                      | `extractOneFile` materializes before walking                              |
| `tests/.../chunker/infra/{pool-ruby-jitter-repro,ruby-walker-carryover}.test.ts` | rdv7d red→green acceptance (already authored)                             |

---

## Task 1: `AstNode` contract + `materializeTree` (the boundary primitive)

**Files:**

- Create: `src/core/contracts/types/ast.ts`
- Modify: `src/core/contracts/index.ts` (re-export)
- Create: `src/core/domains/ingest/pipeline/chunker/materialize.ts`
- Test: `tests/core/domains/ingest/pipeline/chunker/materialize.test.ts` (new)

**Interfaces:**

- Produces: `AstNode` (interface, 16 members),
  `MaterializedTree { rootNode: AstNode }`,
  `materializeTree(nativeRoot: Parser.SyntaxNode, code: string): AstNode`.

- [ ] **Step 1: Write the contract** — `src/core/contracts/types/ast.ts`:

```ts
/**
 * Plain-JS immutable AST node — the post-parse pipeline's node type. Mirrors the
 * exact subset of `Parser.SyntaxNode` the chunker + walkers use (audited). Because
 * it is a structural SUBSET of SyntaxNode, every SyntaxNode value satisfies AstNode,
 * which lets consumer annotations migrate one at a time. Produced by
 * `materializeTree` in ONE eager pass so native-accessor non-determinism (rdv7d)
 * cannot reach any consumer.
 */
export interface AstNode {
  readonly type: string;
  /** Source slice on demand: code.slice(startIndex, endIndex). Never stored per node. */
  readonly text: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly startPosition: { readonly row: number; readonly column: number };
  readonly endPosition: { readonly row: number; readonly column: number };
  readonly children: readonly AstNode[];
  readonly namedChildren: readonly AstNode[];
  readonly childCount: number;
  readonly namedChildCount: number;
  child(index: number): AstNode | null;
  namedChild(index: number): AstNode | null;
  childForFieldName(field: string): AstNode | null;
  readonly parent: AstNode | null;
  readonly previousNamedSibling: AstNode | null;
}

/** Mirror of the single `Parser.Tree` accessor the pipeline uses. */
export interface MaterializedTree {
  readonly rootNode: AstNode;
}
```

- [ ] **Step 2: Write the failing determinism + fidelity test** —
      `materialize.test.ts`:

```ts
import Parser from "tree-sitter";
import Ruby from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import { materializeTree } from "../../../../../../src/core/domains/ingest/pipeline/chunker/materialize.js";

const SRC = `module M\n  class C < Base\n    def run(x, y = {})\n      acc = x.map { |z| z.to_s.strip }\n      helper(acc)\n    end\n  end\nend\n`;

function parse(code: string): Parser.SyntaxNode {
  const p = new Parser();
  p.setLanguage(Ruby as unknown as Parser.Language);
  return p.parse(code).rootNode;
}

// fingerprint that exercises EVERY AstNode accessor including the fragile ones
function fp(n: {
  type: string;
  startIndex: number;
  endIndex: number;
  text: string;
  childForFieldName(f: string): unknown;
  parent: unknown;
  namedChildCount: number;
  previousNamedSibling: unknown;
  children: readonly unknown[];
}): string {
  const fields = [
    "name",
    "body",
    "superclass",
    "parameters",
    "method",
    "receiver",
    "left",
    "right",
    "value",
  ]
    .map(
      (f) => (n.childForFieldName(f) as { type: string } | null)?.type ?? "_",
    )
    .join(",");
  const parts = [
    `${n.type}:${n.startIndex}:${n.endIndex}:t=${n.text.length}:[${fields}]` +
      `:p=${(n.parent as { type: string } | null)?.type ?? "_"}` +
      `:pns=${(n.previousNamedSibling as { type: string } | null)?.type ?? "_"}:nc=${n.namedChildCount}`,
  ];
  for (const c of n.children) parts.push(fp(c as never));
  return parts.join("|");
}

describe("materializeTree", () => {
  it("is byte-stable across N materializations of the same native tree", () => {
    const root = parse(SRC);
    const fps = Array.from({ length: 30 }, () =>
      fp(materializeTree(root, SRC) as never),
    );
    expect(
      new Set(fps).size,
      `non-deterministic: ${new Set(fps).size} distinct`,
    ).toBe(1);
  });

  it("mirrors the native tree's used accessors (text via slice, fields, parent back-ref)", () => {
    const root = parse(SRC);
    const ast = materializeTree(root, SRC);
    expect(ast.type).toBe("program");
    const mod = ast.namedChild(0)!;
    expect(mod.type).toBe("module");
    expect(mod.childForFieldName("name")!.text).toBe("M");
    const cls = mod.childForFieldName("body")!.namedChild(0)!;
    expect(cls.type).toBe("class");
    expect(cls.childForFieldName("superclass")!.text).toContain("Base");
    // parent back-reference + text-on-demand correctness
    expect(cls.parent!.type).toBe("body_statement");
    expect(ast.text).toBe(SRC);
  });
});
```

- [ ] **Step 3: Run it — expect FAIL** (`materializeTree` not defined).

Run:
`npx vitest run tests/core/domains/ingest/pipeline/chunker/materialize.test.ts`
Expected: FAIL — "materializeTree is not a function".

- [ ] **Step 4: Implement `materialize.ts`** (eager single pass; fields via
      cursor, text on-demand):

```ts
import type Parser from "tree-sitter";

import type { AstNode } from "../../../../contracts/types/ast.js";

/** Concrete immutable node. `text` slices the shared `code` lazily (no per-node strings). */
class MaterializedNode implements AstNode {
  readonly children: AstNode[] = [];
  readonly namedChildren: AstNode[] = [];
  parent: AstNode | null = null;
  previousNamedSibling: AstNode | null = null;
  readonly fields = new Map<string, AstNode>();
  constructor(
    readonly type: string,
    readonly startIndex: number,
    readonly endIndex: number,
    readonly startPosition: { row: number; column: number },
    readonly endPosition: { row: number; column: number },
    private readonly code: string,
  ) {}
  get text(): string {
    return this.code.slice(this.startIndex, this.endIndex);
  }
  get childCount(): number {
    return this.children.length;
  }
  get namedChildCount(): number {
    return this.namedChildren.length;
  }
  child(i: number): AstNode | null {
    return this.children[i] ?? null;
  }
  namedChild(i: number): AstNode | null {
    return this.namedChildren[i] ?? null;
  }
  childForFieldName(field: string): AstNode | null {
    return this.fields.get(field) ?? null;
  }
}

/**
 * Materialize a native tree into an immutable plain-JS AstNode in ONE eager pass.
 * Uses a TreeCursor so field names come for free during the single forward walk
 * (the cursor is the ONLY native-accessor user; nothing downstream sees it). The
 * eager one-touch-per-node capture is deterministic (DECIDER finding).
 *
 * IMPLEMENTER NOTE: confirm the installed node-tree-sitter TreeCursor API shape
 * (getter vs method for currentNode/currentFieldName, and whether `isNamed` lives
 * on the cursor node) against `node_modules/tree-sitter`. The determinism test in
 * Step 2 is the acceptance gate — if the cursor form differs, adapt the traversal
 * but keep it a single eager pass.
 */
export function materializeTree(
  nativeRoot: Parser.SyntaxNode,
  code: string,
): AstNode {
  const build = (
    native: Parser.SyntaxNode,
    parent: MaterializedNode | null,
  ): MaterializedNode => {
    const node = new MaterializedNode(
      native.type,
      native.startIndex,
      native.endIndex,
      { row: native.startPosition.row, column: native.startPosition.column },
      { row: native.endPosition.row, column: native.endPosition.column },
      code,
    );
    node.parent = parent;
    let prevNamed: MaterializedNode | null = null;
    const childCount = native.childCount;
    for (let i = 0; i < childCount; i++) {
      const nativeChild = native.child(i)!;
      const child = build(nativeChild, node);
      node.children.push(child);
      if (nativeChild.isNamed) {
        child.previousNamedSibling = prevNamed;
        node.namedChildren.push(child);
        prevNamed = child;
      }
      const field = native.fieldNameForChild(i);
      if (field && !node.fields.has(field)) node.fields.set(field, child);
    }
    return node;
  };
  return build(nativeRoot, null);
}
```

- [ ] **Step 5: Run the test — expect PASS** (both `it`s).

Run:
`npx vitest run tests/core/domains/ingest/pipeline/chunker/materialize.test.ts`
Expected: PASS 2/2. If `fieldNameForChild` is unavailable on the installed
binding, switch to a `tree.walk()` TreeCursor that yields `currentFieldName` per
child (single pass) — the determinism + fidelity asserts are the gate.

- [ ] **Step 6: Re-export + lint + build.**

Add to `src/core/contracts/index.ts`:
`export type { AstNode, MaterializedTree } from "./types/ast.js";`

Run:
`npm run build && npx eslint src/core/contracts/types/ast.ts src/core/domains/ingest/pipeline/chunker/materialize.ts`
Expected: 0 errors.

- [ ] **Step 7: Commit.**

```bash
git add src/core/contracts/types/ast.ts src/core/contracts/index.ts \
  src/core/domains/ingest/pipeline/chunker/materialize.ts \
  tests/core/domains/ingest/pipeline/chunker/materialize.test.ts
git commit -m "feat(contracts): AstNode + materializeTree eager single-pass boundary primitive"
```

---

## Tasks 2–9: migrate consumer annotations `Parser.SyntaxNode → AstNode` (type-only, build green, values still native)

**Why these are safe and independently reviewable:** `AstNode` is a structural
subset of `Parser.SyntaxNode`, so a function annotated `(n: AstNode) => …` still
satisfies a contract typed `(n: Parser.SyntaxNode) => …` (the impl accepts fewer
guarantees than callers provide). Each task changes only type annotations + test
setup; runtime values remain native `SyntaxNode` until Task 10 flips the
boundary. Behavior is unchanged → all existing examples stay green. **Per
`domains-language.md`: preserve every `it`/`describe`; validate counts
`>= base`.**

For EACH task below, the recipe is identical:

- [ ] Replace `import type Parser from "tree-sitter"` node/tree usages with
      `import type { AstNode } from "<rel>/contracts/types/ast.js"` (keep
      `Parser` import only where a genuinely-native value is still constructed).
- [ ] Change every `Parser.SyntaxNode` parameter/local annotation in the file to
      `AstNode`. Bodies are unchanged (they only call AstNode-available
      members).
- [ ] Run `npx tsc --noEmit` for the touched area: expect 0 errors.
- [ ] Run that area's existing test file(s): expect GREEN, unchanged example
      count.
- [ ] Verify `it`/`describe` count `>= base`:
      `git show HEAD:<testfile> | grep -cE "\\b(it|describe)\\("` vs working
      copy.
- [ ] Commit
      `refactor(<scope>): <area> consumes AstNode (type-only, no behavior change)`.

### Task 2: kernel — `collect-symbols.ts` + ruby `ast-utils.ts`

**Files:** `src/core/domains/language/kernel/collect-symbols.ts`,
`src/core/domains/language/ruby/walker/ast-utils.ts`. **Test:**
`tests/core/domains/language/kernel/collect-symbols.test.ts`. `collectSymbols`'s
`walk` closure param, `nameOf` param, and `ast-utils.ts` `walk(node, visit)`
switch to `AstNode`. (Contract `CollectSymbolsFn`/`nameOf` stay `Parser` for now
— contravariance keeps this valid.)

### Task 3: chunker core — `tree-sitter.ts` traversal helpers

**Files:** `src/core/domains/ingest/pipeline/chunker/tree-sitter.ts`
(`findChunkableNodes`, `processChildren`, `chunkWithChildExtraction`, classifier
dispatch, intermediate-scope `.parent` walk). **Test:**
`tests/core/domains/ingest/pipeline/chunker/tree-sitter-chunker.test.ts`.
Annotate the node-walking helpers `AstNode`. Do NOT touch `chunkWithTree`'s
parse/return yet (Task 10). The native `Parser.Tree` from `parse()` still flows
in; `tree.rootNode` is a `SyntaxNode` (valid `AstNode`).

### Task 4: ruby walker — `walker.ts`, `macros.ts`, `local-bindings.ts`, `name-of.ts`

**Test:** `tests/core/domains/language/ruby/walker/*.test.ts` (+
`tests/core/domains/trajectory/codegraph/symbols/resolvers/ruby/*`). This is the
rdv7d bug site (fanIn 14, hot) — review carefully; preserve all 23+ ruby
examples.

### Task 5: typescript + javascript walkers + js chunking `symbol-resolver.ts`

**Files:** `typescript/walker/*`, `javascript/walker/*`,
`javascript/chunking/symbol-resolver.ts`. **Tests:** corresponding walker +
chunker test files.

### Task 6: python + go walkers

**Files:** `python/walker/*`, `go/walker/*` (+
`collectGoLocalBindingsForChunk`).

### Task 7: java + rust walkers

**Files:** `java/walker/*`, `rust/walker/*`.

### Task 8: per-language chunking hooks (deep-silo — extra care)

**Files:**
`ruby/chunking/{rspec-scope-chunker,class-body-chunker,rspec-filter}.ts`,
`typescript/chunking/test-scope-chunker.ts`, and any remaining
`<lang>/chunking/*` consuming nodes. **Tests:** the chunking test files. These
are DEEP-SILO single-owner — do not refactor logic, swap annotations only,
preserve every example.

### Task 9: contracts — flip the contract type annotations to `AstNode`

**Files:** `src/core/contracts/types/language.ts` (`ExtractionPass.run` root,
`LanguageKernel.isInstanceMethod`, `LanguageChunkerHooks.nameExtractor`,
`macroSymbols`, `LanguageWalker.nameOf`, `CollectSymbolsFn` node param),
`src/core/contracts/types/chunker.ts` (`HookContext.containerNode`,
`LanguageChunkClassifier.classifyNode` node, `MacroSymbol` if it carries a
node). By now ALL impls are `AstNode` (Tasks 2–8), so flipping the contract node
annotations compiles cleanly. LEAVE `WalkInput.tree` and `CollectSymbolsFn`'s
`tree` param as `Parser.Tree` — they flip with the boundary in Task 10.
**Test:** full `npx vitest run` — green, no example dropped.

---

## Task 10: flip the boundary — materialize after parse (rdv7d GOES GREEN)

**Files:**

- Modify: `src/core/domains/ingest/pipeline/chunker/tree-sitter.ts`
  (`chunkWithTree`)
- Modify: `src/core/contracts/types/language.ts`
  (`WalkInput.tree: MaterializedTree`, `CollectSymbolsFn` first param
  `MaterializedTree`)
- Modify: `src/core/domains/ingest/pipeline/chunker/infra/worker.ts` (passes the
  materialized tree)
- Test (acceptance): `tests/.../chunker/infra/ruby-walker-carryover.test.ts`,
  `tests/.../chunker/infra/pool-ruby-jitter-repro.test.ts`

**Interfaces:**

- Consumes: `materializeTree` (Task 1).
- Produces: `chunkWithTree` now returns
  `{ chunks, tree: MaterializedTree | null }`.

- [ ] **Step 1: Un-skip the rdv7d repros + confirm RED on current `build/`.**

The repros were marked `it.skip`/`describe.skip` during scaffolding so the
type-swap tasks could commit green. Remove the `.skip` from the three RED tests
in `ruby-walker-carryover.test.ts` (carryover + the two DIAGNOSTIC tests) and
the `describe.skip` in `pool-ruby-jitter-repro.test.ts`. Leave DECIDER as-is
(already green).

Run:
`npm run build && npx vitest run tests/core/domains/ingest/pipeline/chunker/infra/ruby-walker-carryover.test.ts -t "carryover" --pool=forks`
(loop a few times) Expected: FAIL (call count drifts) — this is the red we will
turn green.

- [ ] **Step 2: Materialize in `chunkWithTree`.** In `tree-sitter.ts`, after
      `const tree = langConfig.parser.parse(code);`, replace native-tree usage:

```ts
const nativeTree = langConfig.parser.parse(code);
const root = materializeTree(nativeTree.rootNode, code);
// findChunkableNodes now walks `root` (AstNode); the native tree is dropped here.
const nodes = this.findChunkableNodes(
  root,
  langConfig.chunkableTypes,
  langConfig.hooks,
  code,
  filePath,
);
// ...
return { chunks, tree: { rootNode: root } satisfies MaterializedTree };
```

Update `chunkWithTree`'s return type to
`{ chunks: CodeChunk[]; tree: MaterializedTree | null }` and the doc-language /
fallback branches to `tree: null`.

- [ ] **Step 3: Flip the two remaining contract tree types** in `language.ts`:
      `WalkInput.tree: MaterializedTree;` and
      `CollectSymbolsFn = (tree: MaterializedTree, …)`. Both consumers already
      use only `tree.rootNode`.

- [ ] **Step 4: Worker passes the materialized tree.** In `worker.ts`,
      `engine.collectSymbols(tree, …)` and `walker.walk({ tree, … })` now
      receive the `MaterializedTree` from `chunkWithTree` (no code change beyond
      the type flowing). Confirm `extraction` path (`worker.ts:112`
      `if (request.emitExtraction && tree)`) compiles — `tree` is now
      `MaterializedTree | null`, still truthy-gated.

- [ ] **Step 5: Build + run the rdv7d acceptance suite.**

Run:
`npm run build && npx vitest run tests/core/domains/ingest/pipeline/chunker/infra/ruby-walker-carryover.test.ts tests/core/domains/ingest/pipeline/chunker/infra/pool-ruby-jitter-repro.test.ts --pool=forks`
Expected: **PASS** — carryover/in-process/SAME-tree stable at the clean count;
DECIDER still green; pool repro stable. Loop the carryover test ≥10× to confirm
no flake.

- [ ] **Step 6: Full suite + lint + build green.**

Run: `npm run build && npx tsc --noEmit && npx eslint src && npx vitest run`
Expected: 0 / 0 / all green; no test example dropped.

- [ ] **Step 7: Commit.**

```bash
git add src/core/domains/ingest/pipeline/chunker/tree-sitter.ts \
  src/core/domains/ingest/pipeline/chunker/infra/worker.ts \
  src/core/contracts/types/language.ts
git commit -m "fix(chunker): materialize AST after parse — deterministic walker extraction (rdv7d)

BREAKING CHANGE: none (internal). Eliminates node-tree-sitter native-accessor
non-determinism; ruby callsAttempted is now stable run-to-run."
```

---

## Task 11: codegraph `extractOneFile` materializes (incremental / direct path)

**Files:** Modify `src/core/domains/trajectory/codegraph/symbols/provider.ts`
(`extractOneFile` and any direct `parser.parse(...).rootNode` it walks).
**Test:** `tests/core/domains/trajectory/codegraph/symbols/provider.test.ts`.

- [ ] **Step 1:** In `extractOneFile`, after the native parse,
      `const root = materializeTree(nativeTree.rootNode, code)` and pass the
      materialized root/tree into `collectSymbols` + the walker (mirrors the
      chunker boundary so the `reindex_changes` path is equally deterministic).
- [ ] **Step 2:** `provider` imports `materializeTree` from the chunker module
      (cross-domain: `trajectory` → `ingest`). If the domain-boundary guard
      forbids it, relocate `materializeTree` to a shared home both may import
      (e.g. `domains/language/kernel/materialize.ts`, since both `ingest`
      chunker worker and `trajectory` provider already import the kernel via DI
      / dynamic import). **Decide in the task; prefer the kernel home if the
      guard blocks the chunker import.**
- [ ] **Step 3:** Build + `provider.test.ts` green; full suite green.
- [ ] **Step 4:** Commit
      `fix(trajectory): extractOneFile materializes AST (deterministic incremental path)`.

---

## Task 12: live validation + repro-test promotion

**Files:** none (validation) + tidy the repro tests into permanent regression
tests.

- [ ] **Step 1: Re-link + reindex.** Per `.claude/CLAUDE.md` MCP workflow:
      `cd <worktree> && npm run build && npm link`, reconnect MCP.
- [ ] **Step 2: `force_reindex` a ruby-heavy project ×2** (e.g. huginn) → assert
      `callsAttempted` (ruby) IDENTICAL across the two runs (was
      15020/13958/14222/14525). Capture both values.
- [ ] **Step 3: `reindex_changes` ×2** on the same project → assert no
      regression on the `extractOneFile` path.
- [ ] **Step 4:** Confirm the repro tests (`pool-ruby-jitter-repro`,
      `ruby-walker-carryover`) are green and keep them as permanent regression
      sentinels (rename/relocate if desired; the DECIDER + SAME-tree + carryover
      asserts now all pass). Remove any temporary `console.error` diagnostics.
- [ ] **Step 5:** Commit
      `test(chunker): promote rdv7d repros to determinism regression suite`.

---

## Self-Review

**Spec coverage:** AstNode contract (T1) ✓; materializer +
memory/text-on-demand + fields-capture (T1) ✓; boundary in chunkWithTree (T10)
✓; whole-pipeline migration — chunker core (T3), hooks (T8), kernel (T2),
walkers (T4-7), nameOf (T4-7), contracts (T9), extractOneFile (T11) ✓;
test-example preservation (every swap task) ✓; rdv7d repros green (T10) ✓; live
dual-path validation (T12) ✓. No spec section unmapped.

**Placeholder scan:** the only deferred decisions are (a) the exact
node-tree-sitter cursor/`fieldNameForChild` form (T1 Step 4-5, gated by the
determinism test) and (b) the `materializeTree` home if the domain guard blocks
the cross-domain import (T11 Step 2, with a concrete fallback) — both are
bounded with an explicit resolution path + acceptance gate, not open TODOs.

**Type consistency:**
`materializeTree(nativeRoot: Parser.SyntaxNode, code: string): AstNode` used
identically in T1/T10/T11; `MaterializedTree { rootNode: AstNode }` and
`WalkInput.tree: MaterializedTree` /
`CollectSymbolsFn(tree: MaterializedTree, …)` consistent across T9/T10; consumer
annotation target is `AstNode` throughout T2-T9.
