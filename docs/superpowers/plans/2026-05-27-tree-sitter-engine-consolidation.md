# Tree-sitter Engine Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the tree-sitter chunker engine fully language-agnostic — zero `language === "X"` branches and zero language-named methods — by injecting per-language node→chunk decisions through one `LanguageChunkClassifier` capability, and de-language-naming the Ruby macro-scope walk.

**Architecture:** A single optional `classifier` capability on `LanguageChunkerHooks` collapses the three former node-emit branches (`chunkSymbols` for JS, the `language === "go"` block, the default) into one `classifyNode(node) → ChunkDecision` union (`passthrough | skip | emit`). The Go symbolId convention (`Receiver#Method`, `type Foo`) is extracted into one shared `domains/language/go/naming.ts` consumed by BOTH the chunker classifier and the codegraph walker's `goNameOf`, ending the `extractGoSymbol ↔ goNameOf` drift. The Ruby macro-walk is renamed and driven by `kernel.scopeContainerTypes` / `scopeSeparator`.

**Tech Stack:** TypeScript, tree-sitter, vitest. Spec: `docs/superpowers/specs/2026-05-27-tree-sitter-engine-consolidation-design.md`.

**Spec→plan deviations (intentional):** The spec's `ClassifyContext` parameter is dropped as YAGNI — neither the Go nor the JS classifier needs `code` or the composer at classify time (Go composes via the `INSTANCE_METHOD_SEPARATOR` constant inside `goSymbolOf`; JS symbolIds are pre-composed by `jsChunkSymbols`). `classifyNode` takes the node only. If a future language needs context, add the parameter then.

**Workstream split:** Tasks 1–6 = W1 (`tea-rags-mcp-aah9`, Go full DRY + JS + engine reroute). Tasks 7–8 = W2 (`tea-rags-mcp-9zh4`, Ruby macro-walk). W1 and W2 are independent (no shared taskIds) and may land as separate commits.

**Risk routing:** `tree-sitter.ts` is a hotspot (bugFixRate 32, relativeChurn 5.04) with a second owner (Martin Halder owns `getChunkType` / `findChunkableNodes` / `supportsLanguage`). Route the Task 6 engine reroute for review to Martin. Keep Task 6 a pure mechanical reroute — full chunker + codegraph suites green before and after.

---

## File Structure

**Contracts (interface-only):**
- `src/core/contracts/types/chunker.ts` — add `ChunkType`, `EmittedChunk`, `ChunkDecision`, `LanguageChunkClassifier`; remove nothing.
- `src/core/contracts/types/language.ts` — add `classifier?` to `LanguageChunkerHooks`; remove `chunkSymbols?`.
- `src/core/types.ts` — add transient `claimed?: boolean` to `CodeChunk` metadata.

**Go (DRY relocation):**
- Create `src/core/domains/language/go/naming.ts` — `goSymbolOf` (single source of the Go symbolId convention).
- Modify `src/core/domains/language/go/walker/name-of.ts` — `goNameOf` delegates to `goSymbolOf`.
- Create `src/core/domains/language/go/chunking/classifier.ts` + `chunking/index.ts` — `GoChunkClassifier`.
- Modify `src/core/domains/language/go/index.ts` — wire `chunkerHooks.classifier`.
- Delete `src/core/domains/ingest/pipeline/chunker/hooks/go/` (after relocation).

**JavaScript (adapter):**
- Create `src/core/domains/language/javascript/chunking/classifier.ts` — `JsChunkClassifier` over existing `jsChunkSymbols`.
- Modify `src/core/domains/language/javascript/index.ts` — wire `chunkerHooks.classifier`, drop `chunkSymbols`.

**Engine:**
- Modify `src/core/domains/ingest/pipeline/chunker/config.ts` — `LanguageConfig`: add `classifier`, remove `chunkSymbols`.
- Modify `src/core/domains/ingest/pipeline/chunker/tree-sitter.ts` — `initializeParser`, `chunkSingleNode`, floor loop, `mergeSmallChunks`; rename Ruby macro-walk.

---

## Task 1: Contract types for the classifier

**Files:**
- Modify: `src/core/contracts/types/chunker.ts`
- Modify: `src/core/contracts/types/language.ts`
- Modify: `src/core/types.ts`

- [ ] **Step 1: Add the decision types to `chunker.ts`**

Append to `src/core/contracts/types/chunker.ts` (after the existing `ChunkSymbol` / `MacroSymbol` interfaces):

```ts
/** The chunkType vocabulary the chunker emits (mirrors the engine's getChunkType return). */
export type ChunkType = "function" | "class" | "interface" | "block" | "test" | "test_setup";

/**
 * One chunk a language classifier asks the engine to emit verbatim for a node.
 * `symbolId` is FULLY composed (no further scope join). Chunks emitted this way
 * are flagged `claimed` and are exempt from the min-length floor AND
 * adjacent-merge — they carry an explicit symbolId that merging would destroy.
 */
export interface EmittedChunk {
  name: string;
  symbolId: string;
  chunkType: ChunkType;
}

/**
 * Per-node classification result.
 *   - `passthrough` — the engine applies its generic shaping (extractName +
 *     buildSymbolId + getChunkType) and the min-length floor. The common case.
 *   - `skip` — drop this node entirely.
 *   - `emit` — emit these explicit chunks at the node's source range (Go = 1,
 *     JS = N), flagged `claimed`.
 */
export type ChunkDecision =
  | { kind: "passthrough" }
  | { kind: "skip" }
  | { kind: "emit"; chunks: EmittedChunk[] };

/**
 * Per-language node→chunk classification. Consulted by the chunker engine for
 * each chunkable AST node. Optional capability on `LanguageChunkerHooks` —
 * absent ⇒ the engine uses the generic path for every node. Only languages
 * whose default shaping is wrong for some node types ship one (Go, JavaScript).
 */
export interface LanguageChunkClassifier {
  classifyNode: (node: import("tree-sitter").SyntaxNode) => ChunkDecision;
}
```

- [ ] **Step 2: Wire the capability onto `LanguageChunkerHooks` in `language.ts`**

In `src/core/contracts/types/language.ts`, update the `import type` from `./chunker.js` to add the new names, then on `interface LanguageChunkerHooks` REMOVE the `chunkSymbols?` member and ADD:

```ts
  /**
   * Per-language node→chunk classifier. When present, the engine consults it for
   * each chunkable node before its generic shaping. Replaces the former
   * `chunkSymbols` capability (folded into `ChunkDecision.emit`) and the engine's
   * `language === "go"` branch. Absent for languages whose default shaping is
   * always right (TypeScript, Python, Java, Rust, Bash, Ruby, Markdown).
   */
  classifier?: LanguageChunkClassifier;
```

Update the import line near the top of `language.ts`:

```ts
import type { ChunkingHook, ChunkSymbol, LanguageChunkClassifier, MacroSymbol } from "./chunker.js";
```

(`ChunkSymbol` stays imported — it remains referenced by the `chunkSymbols?` JSDoc-less `MacroSymbol`/`ChunkSymbol` usages elsewhere; if tsc reports it unused after removing `chunkSymbols?`, drop it from the import.)

- [ ] **Step 3: Add the transient `claimed` flag to `CodeChunk` metadata**

In `src/core/types.ts`, find the `CodeChunk` interface's `metadata` object type and add:

```ts
    /**
     * Transient: set by the engine for chunks produced by a classifier `emit`
     * decision. Read only by `mergeSmallChunks` to exempt them from adjacent
     * merging. NOT part of the persisted Qdrant payload (the payload builder
     * selects explicit fields).
     */
    claimed?: boolean;
```

- [ ] **Step 4: Verify the project still type-checks**

Run: `npx tsc --noEmit`
Expected: PASS (no new errors — these are additive type declarations; `chunkSymbols?` removal will surface errors only in files still referencing it, which Tasks 4–6 fix).

> NOTE: After Step 2 removes `chunkSymbols?` from the contract, `javascript/index.ts` and `chunker/config.ts` + `tree-sitter.ts` still reference it and WILL fail tsc until Tasks 3b/4/6. That is expected mid-migration. To keep Task 1 independently green, run tsc only on the contracts: `npx tsc --noEmit` may report those downstream errors — that is acceptable for this task; they are resolved by the end of Task 6. (If you prefer a green checkpoint, defer Step 2's `chunkSymbols?` removal to Task 6 Step 1 and only ADD `classifier?` here.)

- [ ] **Step 5: Commit**

```bash
git add src/core/contracts/types/chunker.ts src/core/contracts/types/language.ts src/core/types.ts
git commit -m "feat(contracts): add LanguageChunkClassifier capability + ChunkDecision

ChunkDecision (passthrough|skip|emit) + EmittedChunk + ChunkType added to the
chunker contract; classifier? added to LanguageChunkerHooks (replaces
chunkSymbols?, folded into emit). Transient CodeChunk.metadata.claimed flag for
the merge-exemption of emitted chunks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Go `goSymbolOf` shared module + point `goNameOf` at it

Extract the Go symbolId convention into one module consumed by both the chunker
classifier (Task 3a) and the codegraph walker. This is the DRY collapse.

**Files:**
- Create: `src/core/domains/language/go/naming.ts`
- Modify: `src/core/domains/language/go/walker/name-of.ts`
- Test: `tests/core/domains/language/go/naming.test.ts` (new)
- Test: `tests/core/domains/language/go/walker/name-of.test.ts` (existing — must stay green)

- [ ] **Step 1: Write the failing test for `goSymbolOf`**

Create `tests/core/domains/language/go/naming.test.ts`:

```ts
import Parser from "tree-sitter";
import GoLang from "tree-sitter-go";
import { describe, it, expect, beforeAll } from "vitest";

import { goSymbolOf } from "../../../../../../src/core/domains/language/go/naming.js";

let parser: Parser;
beforeAll(() => {
  parser = new Parser();
  parser.setLanguage(GoLang as Parser.Language);
});

function firstOfType(code: string, type: string): Parser.SyntaxNode {
  const root = parser.parse(code).rootNode;
  const found = (function walk(n: Parser.SyntaxNode): Parser.SyntaxNode | null {
    if (n.type === type) return n;
    for (const c of n.children) {
      const r = walk(c);
      if (r) return r;
    }
    return null;
  })(root);
  if (!found) throw new Error(`no ${type} in: ${code}`);
  return found;
}

describe("goSymbolOf", () => {
  it("composes Receiver#Method for a pointer-receiver method", () => {
    const node = firstOfType("func (c *Context) Query(k string) string { return \"\" }", "method_declaration");
    expect(goSymbolOf(node)).toEqual({ name: "Context#Query", symbolId: "Context#Query", instanceMethod: true });
  });

  it("emits the bare type name for a struct type_declaration", () => {
    const node = firstOfType("type Engine struct { n int }", "type_declaration");
    expect(goSymbolOf(node)).toEqual({ name: "Engine", symbolId: "Engine", instanceMethod: false });
  });

  it("emits the bare name for a top-level function_declaration", () => {
    const node = firstOfType("func New() *Engine { return nil }", "function_declaration");
    expect(goSymbolOf(node)).toEqual({ name: "New", symbolId: "New", instanceMethod: false });
  });

  it("returns null for a non-symbol node", () => {
    const node = firstOfType("package main", "package_clause");
    expect(goSymbolOf(node)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/core/domains/language/go/naming.test.ts`
Expected: FAIL — `Cannot find module '.../go/naming.js'`.

- [ ] **Step 3: Implement `goSymbolOf`**

Create `src/core/domains/language/go/naming.ts`:

```ts
/**
 * Go symbolId convention — the SINGLE source of truth for how a Go AST node
 * maps to its `Receiver#Method` / `type Foo` / `func` identifier. Consumed by
 * BOTH the chunker (`go/chunking/classifier.ts:GoChunkClassifier`) and the
 * codegraph walker (`go/walker/name-of.ts:goNameOf`). Keeping ONE source makes
 * the chunker↔codegraph lockstep `.claude/rules/symbolid-convention.md` mandates
 * true by construction — formerly duplicated in `chunker/hooks/go/symbol-resolver.ts`
 * (extractGoSymbol) and inline in `goNameOf`. bd tea-rags-mcp-n7x5 / j2b7 / aah9.
 */
import type Parser from "tree-sitter";

import { INSTANCE_METHOD_SEPARATOR } from "../../../infra/symbolid/index.js";

export interface GoSymbol {
  name: string;
  /** Same string as `name` for Go (top-level / receiver-composed). */
  symbolId: string;
  /** `method_declaration` (receiver-bound) → true; function/type → false. */
  instanceMethod: boolean;
}

/**
 * Resolve `{ name, symbolId, instanceMethod }` for a Go method / function / type
 * node. Returns `null` for any other node (callers fall back to default name
 * extraction). Covers:
 *   - `method_declaration` → `Receiver#Method` (pointer `*R` → `R`, generic
 *     `R[T]` → `R`), instanceMethod true.
 *   - `function_declaration` → bare name, instanceMethod false.
 *   - `type_declaration` → the `type_spec` name (struct / interface / func /
 *     map / slice alias), instanceMethod false.
 */
export function goSymbolOf(node: Parser.SyntaxNode): GoSymbol | null {
  if (node.type === "method_declaration") {
    const id = node.childForFieldName("name");
    if (!id) return null;
    const receiver = extractGoReceiverType(node);
    if (!receiver) {
      // Defensive: receiver-less method shouldn't happen in valid Go, but if the
      // parser is mid-edit, keep the bare method name so we don't lose the id.
      return { name: id.text, symbolId: id.text, instanceMethod: true };
    }
    const composed = `${receiver}${INSTANCE_METHOD_SEPARATOR}${id.text}`;
    return { name: composed, symbolId: composed, instanceMethod: true };
  }
  if (node.type === "function_declaration") {
    const id = node.childForFieldName("name");
    if (!id) return null;
    return { name: id.text, symbolId: id.text, instanceMethod: false };
  }
  if (node.type === "type_declaration") {
    const spec = node.children.find((c) => c.type === "type_spec" || c.type === "type_alias");
    const id = spec?.childForFieldName("name");
    if (!id) return null;
    return { name: id.text, symbolId: id.text, instanceMethod: false };
  }
  return null;
}

/**
 * Extract the receiver type name from a Go `method_declaration`, stripping
 * pointer (`*R` → `R`) and dropping generic type-parameter lists. Returns null
 * if unparseable (tree-sitter-go is error-tolerant).
 */
function extractGoReceiverType(method: Parser.SyntaxNode): string | null {
  const receiver = method.childForFieldName("receiver");
  if (!receiver) return null;
  const param = receiver.children.find((c) => c.type === "parameter_declaration");
  if (!param) return null;
  const typeNode = param.childForFieldName("type");
  if (!typeNode) return null;
  const ident =
    typeNode.type === "pointer_type" ? typeNode.children.find((c) => c.type === "type_identifier") : typeNode;
  if (!ident) return null;
  if (ident.type === "generic_type") {
    const base = ident.childForFieldName("type");
    return base?.text ?? null;
  }
  return ident.text;
}
```

- [ ] **Step 4: Run the new test to verify it passes**

Run: `npx vitest run tests/core/domains/language/go/naming.test.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Refactor `goNameOf` to delegate to `goSymbolOf`**

Replace the body of `src/core/domains/language/go/walker/name-of.ts` (drop its private `extractGoReceiverType` — now in `naming.ts`):

```ts
/**
 * Go `nameOf` — maps a tree-sitter node to its `NamedSymbol` descriptor for
 * codegraph symbol extraction. Delegates to the shared `goSymbolOf` (the single
 * source of the Go symbolId convention) so the chunker and codegraph stay in
 * lockstep by construction per `.claude/rules/symbolid-convention.md`.
 */
import type Parser from "tree-sitter";

import type { NamedSymbol } from "../../../../contracts/types/codegraph.js";
import { goSymbolOf } from "../naming.js";

export function goNameOf(node: Parser.SyntaxNode): NamedSymbol | null {
  const sym = goSymbolOf(node);
  if (!sym) return null;
  return sym.instanceMethod
    ? { name: sym.name, descendsInto: false, methodKind: "instance" }
    : { name: sym.name, descendsInto: false };
}
```

- [ ] **Step 6: Run the existing Go walker + codegraph tests to verify no regression**

Run: `npx vitest run tests/core/domains/language/go/walker/name-of.test.ts tests/core/domains/trajectory/codegraph/symbols/resolvers/go`
Expected: PASS — behavior preserved (same `NamedSymbol` for every node shape).

- [ ] **Step 7: Commit**

```bash
git add src/core/domains/language/go/naming.ts src/core/domains/language/go/walker/name-of.ts tests/core/domains/language/go/naming.test.ts
git commit -m "refactor(chunker): extract Go symbolId convention into shared goSymbolOf

Single source consumed by codegraph goNameOf (delegates now) and, next, the
chunker classifier — collapses the extractGoSymbol<->goNameOf duplication.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3a: `GoChunkClassifier`

**Files:**
- Create: `src/core/domains/language/go/chunking/classifier.ts`
- Create: `src/core/domains/language/go/chunking/index.ts`
- Modify: `src/core/domains/language/go/index.ts`
- Test: `tests/core/domains/language/go/chunking/classifier.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/core/domains/language/go/chunking/classifier.test.ts`:

```ts
import Parser from "tree-sitter";
import GoLang from "tree-sitter-go";
import { describe, it, expect, beforeAll } from "vitest";

import { GoChunkClassifier } from "../../../../../../src/core/domains/language/go/chunking/classifier.js";

let parser: Parser;
const classifier = new GoChunkClassifier();
beforeAll(() => {
  parser = new Parser();
  parser.setLanguage(GoLang as Parser.Language);
});

function firstOfType(code: string, type: string): Parser.SyntaxNode {
  const root = parser.parse(code).rootNode;
  const found = (function walk(n: Parser.SyntaxNode): Parser.SyntaxNode | null {
    if (n.type === type) return n;
    for (const c of n.children) {
      const r = walk(c);
      if (r) return r;
    }
    return null;
  })(root);
  if (!found) throw new Error(`no ${type}`);
  return found;
}

describe("GoChunkClassifier.classifyNode", () => {
  it("emits class chunkType for a struct type_declaration", () => {
    const node = firstOfType("type Engine struct { n int }", "type_declaration");
    expect(classifier.classifyNode(node)).toEqual({
      kind: "emit",
      chunks: [{ name: "Engine", symbolId: "Engine", chunkType: "class" }],
    });
  });

  it("emits interface chunkType for an interface type_declaration", () => {
    const node = firstOfType("type Handler interface { Serve() }", "type_declaration");
    expect(classifier.classifyNode(node)).toEqual({
      kind: "emit",
      chunks: [{ name: "Handler", symbolId: "Handler", chunkType: "interface" }],
    });
  });

  it("emits block chunkType for a func-type alias", () => {
    const node = firstOfType("type HandlerFunc func(*Context)", "type_declaration");
    expect(classifier.classifyNode(node)).toEqual({
      kind: "emit",
      chunks: [{ name: "HandlerFunc", symbolId: "HandlerFunc", chunkType: "block" }],
    });
  });

  it("emits function chunkType + Receiver#Method for a method", () => {
    const node = firstOfType("func (c *Context) Query() string { return \"\" }", "method_declaration");
    expect(classifier.classifyNode(node)).toEqual({
      kind: "emit",
      chunks: [{ name: "Context#Query", symbolId: "Context#Query", chunkType: "function" }],
    });
  });

  it("passes through a top-level function_declaration (preserves the floor)", () => {
    const node = firstOfType("func f() {}", "function_declaration");
    expect(classifier.classifyNode(node)).toEqual({ kind: "passthrough" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/core/domains/language/go/chunking/classifier.test.ts`
Expected: FAIL — `Cannot find module '.../go/chunking/classifier.js'`.

- [ ] **Step 3: Implement `GoChunkClassifier`**

Create `src/core/domains/language/go/chunking/classifier.ts`:

```ts
/**
 * Go node→chunk classifier. Emits explicit chunks for the two node shapes whose
 * default engine shaping is wrong:
 *   - `method_declaration` → `Receiver#Method` (the default extractName loses the
 *     receiver), chunkType "function".
 *   - `type_declaration` → name from the `type_spec` child (the default extractName
 *     returns undefined — `type_declaration` has no direct `name` field), with the
 *     chunkType refined by the body kind: struct → "class", interface →
 *     "interface", else "block" (func / map / slice aliases). bd iiq6.
 *
 * `function_declaration` and everything else PASS THROUGH: the default
 * extractName + buildSymbolId + getChunkType already produce the right shape, and
 * passthrough keeps the engine's min-length floor (a tiny `func f(){}` is floored
 * exactly as before — `emit` would bypass it). Mirrors the former engine
 * `language === "go"` block, which only claimed method/type via `extractGoSymbol`.
 *
 * Naming comes from the shared `goSymbolOf` (also used by the codegraph walker),
 * so chunker and codegraph agree on the symbolId by construction.
 */
import type Parser from "tree-sitter";

import type { ChunkDecision, ChunkType, LanguageChunkClassifier } from "../../../../contracts/types/chunker.js";
import { goSymbolOf } from "../naming.js";

export class GoChunkClassifier implements LanguageChunkClassifier {
  classifyNode(node: Parser.SyntaxNode): ChunkDecision {
    if (node.type !== "method_declaration" && node.type !== "type_declaration") {
      return { kind: "passthrough" };
    }
    const sym = goSymbolOf(node);
    if (!sym) return { kind: "passthrough" };

    let chunkType: ChunkType = node.type === "method_declaration" ? "function" : "block";
    if (node.type === "type_declaration") {
      const spec = node.children.find((c) => c.type === "type_spec" || c.type === "type_alias");
      const body = spec?.childForFieldName("type");
      if (body?.type === "struct_type") chunkType = "class";
      else if (body?.type === "interface_type") chunkType = "interface";
    }
    return { kind: "emit", chunks: [{ name: sym.name, symbolId: sym.symbolId, chunkType }] };
  }
}
```

- [ ] **Step 4: Create the barrel**

Create `src/core/domains/language/go/chunking/index.ts`:

```ts
export { GoChunkClassifier } from "./classifier.js";
```

- [ ] **Step 5: Wire the classifier into `GoLanguage`**

In `src/core/domains/language/go/index.ts`:

Add the import:

```ts
import { GoChunkClassifier } from "./chunking/index.js";
```

Update `goChunkerHooks` to carry the classifier (the `chunkableTypes` stay):

```ts
const goChunkerHooks: LanguageChunkerHooks = {
  chunkableTypes: ["function_declaration", "method_declaration", "type_declaration", "interface_declaration"],
  classifier: new GoChunkClassifier(),
};
```

Add to the re-exports block at the bottom:

```ts
export { GoChunkClassifier } from "./chunking/index.js";
export { goSymbolOf } from "./naming.js";
```

- [ ] **Step 6: Run the classifier test to verify it passes**

Run: `npx vitest run tests/core/domains/language/go/chunking/classifier.test.ts`
Expected: PASS (5/5).

- [ ] **Step 7: Commit**

```bash
git add src/core/domains/language/go/chunking/ src/core/domains/language/go/index.ts tests/core/domains/language/go/chunking/classifier.test.ts
git commit -m "feat(chunker): GoChunkClassifier (chunkType refine + Receiver#Method via goSymbolOf)

Go chunker-side classification now flows through the LanguageChunkClassifier
capability, consuming the shared goSymbolOf. Not yet read by the engine (Task 6).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3b: `JsChunkClassifier`

A thin adapter over the existing `jsChunkSymbols` (already in
`domains/language/javascript/chunking/`): `[]` → passthrough, else → emit.

**Files:**
- Create: `src/core/domains/language/javascript/chunking/classifier.ts`
- Modify: `src/core/domains/language/javascript/chunking/index.ts`
- Modify: `src/core/domains/language/javascript/index.ts`
- Test: `tests/core/domains/language/javascript/chunking/classifier.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/core/domains/language/javascript/chunking/classifier.test.ts`:

```ts
import Parser from "tree-sitter";
import JsLang from "tree-sitter-javascript";
import { describe, it, expect, beforeAll } from "vitest";

import { JsChunkClassifier } from "../../../../../../src/core/domains/language/javascript/chunking/classifier.js";

let parser: Parser;
const classifier = new JsChunkClassifier();
beforeAll(() => {
  parser = new Parser();
  parser.setLanguage(JsLang as Parser.Language);
});

function firstOfType(code: string, type: string): Parser.SyntaxNode {
  const root = parser.parse(code).rootNode;
  const found = (function walk(n: Parser.SyntaxNode): Parser.SyntaxNode | null {
    if (n.type === type) return n;
    for (const c of n.children) {
      const r = walk(c);
      if (r) return r;
    }
    return null;
  })(root);
  if (!found) throw new Error(`no ${type}`);
  return found;
}

describe("JsChunkClassifier.classifyNode", () => {
  it("emits function-typed chunks for a CommonJS assignment", () => {
    const node = firstOfType("exports.foo = function () {};", "expression_statement");
    const decision = classifier.classifyNode(node);
    expect(decision.kind).toBe("emit");
    if (decision.kind === "emit") {
      expect(decision.chunks.length).toBeGreaterThan(0);
      expect(decision.chunks.every((c) => c.chunkType === "function")).toBe(true);
      expect(decision.chunks[0].symbolId).toBe(decision.chunks[0].name);
    }
  });

  it("passes through a node jsChunkSymbols does not claim", () => {
    const node = firstOfType("const x = 1;", "lexical_declaration");
    expect(classifier.classifyNode(node)).toEqual({ kind: "passthrough" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/core/domains/language/javascript/chunking/classifier.test.ts`
Expected: FAIL — `Cannot find module '.../javascript/chunking/classifier.js'`.

- [ ] **Step 3: Implement `JsChunkClassifier`**

Create `src/core/domains/language/javascript/chunking/classifier.ts`:

```ts
/**
 * JavaScript node→chunk classifier. A thin adapter over `jsChunkSymbols` (the
 * former `chunkSymbols` capability): the provider has ALREADY composed each
 * symbolId, so non-empty results map to an `emit` decision with chunkType
 * "function" (the engine formerly hardcoded "function" for these), and an empty
 * result means the node is not a CommonJS / prototype / dispatch / defineProperty
 * shape — pass through to the engine's default extraction. Precedence
 * (dispatch-set wins; else assignment + nested defineProperty siblings) is owned
 * by `jsChunkSymbols`. bd tea-rags-mcp-kfzx / z95o / d1f8.
 */
import type Parser from "tree-sitter";

import type { ChunkDecision, LanguageChunkClassifier } from "../../../../contracts/types/chunker.js";
import { jsChunkSymbols } from "./chunk-symbols.js";

export class JsChunkClassifier implements LanguageChunkClassifier {
  classifyNode(node: Parser.SyntaxNode): ChunkDecision {
    const syms = jsChunkSymbols(node);
    if (syms.length === 0) return { kind: "passthrough" };
    return {
      kind: "emit",
      chunks: syms.map((s) => ({ name: s.name, symbolId: s.symbolId, chunkType: "function" })),
    };
  }
}
```

- [ ] **Step 4: Export it from the chunking barrel**

In `src/core/domains/language/javascript/chunking/index.ts`, add:

```ts
export { JsChunkClassifier } from "./classifier.js";
```

- [ ] **Step 5: Wire it into `JavaScriptLanguage`, drop `chunkSymbols`**

In `src/core/domains/language/javascript/index.ts`:

Update the import from `./chunking/index.js`:

```ts
import { javascriptHooks, JsChunkClassifier } from "./chunking/index.js";
```

In `javascriptChunkerHooks`, REPLACE the `chunkSymbols: (node) => jsChunkSymbols(node),` line with:

```ts
  classifier: new JsChunkClassifier(),
```

Update the bottom re-export line from `export { javascriptHooks, jsChunkSymbols } ...` to:

```ts
export { javascriptHooks, jsChunkSymbols, JsChunkClassifier } from "./chunking/index.js";
```

- [ ] **Step 6: Run the new test + existing JS chunk-symbol tests**

Run: `npx vitest run tests/core/domains/language/javascript/chunking`
Expected: PASS — the new classifier test plus the existing `chunk-symbols` / `symbol-resolver` tests (behavior unchanged; `jsChunkSymbols` is still the engine of record).

- [ ] **Step 7: Commit**

```bash
git add src/core/domains/language/javascript/chunking/classifier.ts src/core/domains/language/javascript/chunking/index.ts src/core/domains/language/javascript/index.ts tests/core/domains/language/javascript/chunking/classifier.test.ts
git commit -m "feat(chunker): JsChunkClassifier adapter over jsChunkSymbols

JavaScript node-level synthetic chunks now flow through the
LanguageChunkClassifier capability (emit). chunkSymbols capability field dropped
from the provider. Not yet read by the engine (Task 6).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Engine — thread `classifier` through `LanguageConfig`, drop `chunkSymbols`

**Files:**
- Modify: `src/core/domains/ingest/pipeline/chunker/config.ts`
- Modify: `src/core/domains/ingest/pipeline/chunker/tree-sitter.ts` (`initializeParser`)

- [ ] **Step 1: Add `classifier` to `LanguageConfig`, remove `chunkSymbols`**

In `src/core/domains/ingest/pipeline/chunker/config.ts`:

- Add to the `import type` from the chunker contract: `LanguageChunkClassifier` (alongside `MacroSymbol`).
- On `interface LanguageConfig`, REMOVE `chunkSymbols?: (containerNode: Parser.SyntaxNode) => ChunkSymbol[];` and ADD:

```ts
  classifier?: LanguageChunkClassifier;
```

(If `ChunkSymbol` becomes an unused import after removal, drop it.)

- [ ] **Step 2: Map it in `initializeParser`**

In `tree-sitter.ts` `initializeParser`, in the returned `LanguageConfig` object, REMOVE the line `chunkSymbols: hooks.chunkSymbols,` and ADD:

```ts
        classifier: hooks.classifier,
```

- [ ] **Step 3: Verify it type-checks (engine call sites still reference the old shape — expected)**

Run: `npx tsc --noEmit`
Expected: errors localized to `tree-sitter.ts:chunkSingleNode` (still uses `chunkSymbols` param + the Go branch) — resolved in Task 5/6. No errors in `config.ts` itself.

- [ ] **Step 4: Commit**

```bash
git add src/core/domains/ingest/pipeline/chunker/config.ts src/core/domains/ingest/pipeline/chunker/tree-sitter.ts
git commit -m "refactor(chunker): thread classifier through LanguageConfig, drop chunkSymbols

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Engine — route `chunkSingleNode` through the classifier; fold floor + merge

This is the **riskiest** task (hotspot). Pure mechanical reroute — no logic change
beyond moving the three branches into the classifier path and the floor/merge into
the passthrough/claimed model. **Route review to Martin Halder.**

**Files:**
- Modify: `src/core/domains/ingest/pipeline/chunker/tree-sitter.ts`
- Test: `tests/core/domains/ingest/pipeline/chunker/tree-sitter-chunker.test.ts` (existing — must stay green)

- [ ] **Step 1: Run the full chunker suite to capture the green baseline**

Run: `npx vitest run tests/core/domains/ingest/pipeline/chunker`
Expected: PASS. Record the passing count — Task 5 + 6 must end at ≥ this count (count-preservation rule).

- [ ] **Step 2: Rewrite `chunkSingleNode` signature + body to use the classifier**

In `tree-sitter.ts`:

Change the `chunkSingleNode` signature — replace the trailing
`chunkSymbols?: (node: Parser.SyntaxNode) => ChunkSymbol[],` parameter with:

```ts
    classifier?: LanguageChunkClassifier,
```

Replace the three former branches (the `if (chunkSymbols) { ... }` block, the
`if (language === "go") { ... }` block, and the final default `chunks.push`) with
this single decision switch:

```ts
    const content = code.substring(node.startIndex, node.endIndex);
    const decision = classifier?.classifyNode(node) ?? { kind: "passthrough" };

    if (decision.kind === "skip") return;

    if (decision.kind === "emit") {
      decision.chunks.forEach((c, i) => {
        chunks.push({
          content: content.trim(),
          startLine: node.startPosition.row + 1,
          endLine: this.computeEndLine(node),
          metadata: {
            filePath,
            language,
            chunkIndex: index + i,
            chunkType: c.chunkType,
            name: c.name,
            symbolId: c.symbolId,
            claimed: true,
            methodLines: this.computeEndLine(node) - (node.startPosition.row + 1),
          },
        });
      });
      return;
    }

    // passthrough — generic shaping, subject to the min-length floor.
    if (content.length < 50) return;
    const nodeName = this.extractName(node, code);
    chunks.push({
      content: content.trim(),
      startLine: node.startPosition.row + 1,
      endLine: this.computeEndLine(node),
      metadata: {
        filePath,
        language,
        chunkIndex: index,
        chunkType: this.getChunkType(node.type),
        name: nodeName,
        symbolId: this.buildSymbolId(nodeName),
        methodLines: this.computeEndLine(node) - (node.startPosition.row + 1),
      },
    });
```

Update the caller (`chunk()` top-level loop) — change
`this.chunkSingleNode(node, index, code, filePath, language, chunks, langConfig.chunkSymbols);`
to:

```ts
        this.chunkSingleNode(node, index, code, filePath, language, chunks, langConfig.classifier);
```

Remove `import { extractGoSymbol } from "./hooks/go/index.js";` (line ~25) and, if
now unused, the `ChunkSymbol` import.

- [ ] **Step 3: Move the min-length floor out of the `chunk()` loop**

In `tree-sitter.ts` `chunk()`, in the `for (const [index, node] of nodes.entries())`
loop, DELETE the Go-specific floor block:

```ts
        const isGoNamedType = language === "go" && node.type === "type_declaration";
        if (content.length < 50 && !isGoNamedType) continue;
```

(The floor now lives inside `chunkSingleNode`'s passthrough branch, where it
applies only to non-claimed nodes — `emit` decisions bypass it, exactly as the
old `isGoNamedType` exception did. The leading `const content = ...` in the loop
that only fed this check can be removed if unused after the deletion.)

- [ ] **Step 4: Replace the merge guard with the `claimed` flag**

In `mergeSmallChunks`'s `isMergeable`, replace the Go carve-out:

```ts
      if (chunk.metadata.language === "go" && chunk.metadata.symbolId) {
        return false;
      }
```

with:

```ts
      // Chunks emitted by a language classifier carry an explicit symbolId that
      // merging would destroy (e.g. Go named type aliases) — never merge them.
      // Passthrough chunks merge per the rule below (TS small type aliases DO
      // merge even though they have a symbolId).
      if (chunk.metadata.claimed) {
        return false;
      }
```

- [ ] **Step 5: Run the full chunker suite — must stay green**

Run: `npx vitest run tests/core/domains/ingest/pipeline/chunker`
Expected: PASS at ≥ the Step 1 baseline count. Key behaviors that MUST hold:
- Go `type Engine struct` → chunkType "class"; `type Handler interface` → "interface".
- Go named type alias (`type HandlerFunc func(...)`) keeps its symbolId and is NOT merged.
- TS small type aliases STILL merge.
- JS `exports.foo` / `methods.forEach` dispatch / `Object.defineProperty` shapes emit unchanged.

- [ ] **Step 6: Run the codegraph suite (symbolId lockstep)**

Run: `npx vitest run tests/core/domains/trajectory/codegraph`
Expected: PASS — Go `Receiver#Method` in chunker payload matches `goNameOf` output.

- [ ] **Step 7: Delete the relocated `chunker/hooks/go/` directory**

```bash
git rm -r src/core/domains/ingest/pipeline/chunker/hooks/go/
```

If a test file `tests/core/domains/ingest/pipeline/chunker/hooks/go/` exists, relocate
its still-relevant cases into `tests/core/domains/language/go/naming.test.ts` /
`tests/core/domains/language/go/chunking/classifier.test.ts` (preserve examples,
counts ≥ base), then `git rm` the old test dir.

- [ ] **Step 8: Full type-check + build**

Run: `npx tsc --noEmit && npm run build`
Expected: PASS — no remaining references to `extractGoSymbol`, `chunkSymbols`, or `chunker/hooks/go/`.

- [ ] **Step 9: Commit**

```bash
git add -A src/core/domains/ingest/pipeline/chunker/ tests/core/domains/
git commit -m "refactor(chunker): route chunkSingleNode through ChunkClassifier, remove language=== branches

Engine no longer branches on language for node-to-chunk decisions: JS chunkSymbols
and the Go type/method/chunkType/lifecycle branches all flow through the classifier
capability. The min-length floor and adjacent-merge Go carve-outs collapse into the
emit-vs-passthrough split (emitted chunks are flagged claimed). chunker/hooks/go/
relocated to domains/language/go and removed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: W2 — de-language-name the Ruby macro-walk, drive from kernel

**Files:**
- Modify: `src/core/domains/ingest/pipeline/chunker/tree-sitter.ts`
- Test: `tests/core/domains/ingest/pipeline/chunker/tree-sitter-chunker.test.ts` (existing + new case)

- [ ] **Step 1: Write the failing test for `singleton_class` macro descent**

Add to `tests/core/domains/ingest/pipeline/chunker/tree-sitter-chunker.test.ts` (inside the Ruby macro describe block; adapt the existing chunk-helper setup used by neighbouring Ruby tests):

```ts
  it("emits macro symbols declared inside class << self (singleton_class)", async () => {
    const code = [
      "class Foo",
      "  class << self",
      "    attr_accessor :registry",
      "  end",
      "end",
    ].join("\n");
    const chunks = await chunker.chunk(code, "foo.rb", "ruby");
    const ids = chunks.map((c) => c.metadata.symbolId);
    // class-level accessor on the singleton — composed at the Foo scope.
    expect(ids).toContain("Foo#registry");
    expect(ids).toContain("Foo#registry=");
  });
```

> If the existing Ruby macro tests compose singleton accessors under a different
> scope id, match that convention — the assertion is "the `class << self` macro
> now produces accessor symbols at all", which it did NOT before this task.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/core/domains/ingest/pipeline/chunker/tree-sitter-chunker.test.ts -t "singleton_class"`
Expected: FAIL — no `Foo#registry` symbol (the old hardcoded walk skips `singleton_class`).

- [ ] **Step 3: Rename + parametrize the macro-walk**

In `tree-sitter.ts`:

Rename `emitRubyMacroSymbols` → `emitMacroSymbols` and `walkRubyMacroScopes` →
`walkMacroScopes` (update the two call sites — formerly at the
`chunkWithChildExtraction` and `processChildren` paths — and the JSDoc, dropping
"Ruby" from prose where it describes the generic mechanism).

Add two parameters to both methods, threaded from `langConfig` at the call sites:
`scopeContainerTypes: string[] | undefined` and `scopeSeparator: string | undefined`.

In `walkMacroScopes`, replace the hardcoded container check:

```ts
      if (stmt.type !== "class" && stmt.type !== "module") continue;
```

with (defaulting to the old set when a language declares no `scopeContainerTypes`,
so non-Ruby callers are unaffected):

```ts
      const containers = scopeContainerTypes ?? ["class", "module"];
      if (!containers.includes(stmt.type)) continue;
```

and replace the hardcoded separator:

```ts
      const nestedParent = this.symbolIds.compose(currentParent ?? "", localName, { scopeSeparator: "::" });
```

with:

```ts
      const nestedParent = this.symbolIds.compose(currentParent ?? "", localName, { scopeSeparator: scopeSeparator ?? "::" });
```

At the two call sites, pass `langConfig.scopeContainerTypes, langConfig.scopeSeparator`
as the new trailing arguments.

> Ruby's kernel declares `scopeContainerTypes: ["class", "module", "singleton_class"]`
> and `scopeSeparator: "::"`, so the separator is unchanged and the container set
> now includes `singleton_class` — the one intended behavior delta (Step 1's test).

- [ ] **Step 4: Run the new test to verify it passes**

Run: `npx vitest run tests/core/domains/ingest/pipeline/chunker/tree-sitter-chunker.test.ts -t "singleton_class"`
Expected: PASS.

- [ ] **Step 5: Run the full chunker + codegraph suites**

Run: `npx vitest run tests/core/domains/ingest/pipeline/chunker tests/core/domains/trajectory/codegraph`
Expected: PASS at ≥ baseline. Existing Ruby macro tests (nested `A::B#x`, top-level
accessors, delegates) unchanged; the engine now has no `Ruby`-named identifiers.

- [ ] **Step 6: Verify the engine is language-agnostic**

Run: `rg -n 'language === "|Ruby|extractGoSymbol' src/core/domains/ingest/pipeline/chunker/tree-sitter.ts`
Expected: NO matches for `language === "`, `emitRubyMacroSymbols`, `walkRubyMacroScopes`, or `extractGoSymbol` (only generic identifiers remain).

- [ ] **Step 7: Commit**

```bash
git add src/core/domains/ingest/pipeline/chunker/tree-sitter.ts tests/core/domains/ingest/pipeline/chunker/tree-sitter-chunker.test.ts
git commit -m "refactor(chunker): de-language-name macro-walk, drive scope from kernel

emitRubyMacroSymbols/walkRubyMacroScopes -> emitMacroSymbols/walkMacroScopes,
driven by langConfig.scopeContainerTypes + scopeSeparator. Ruby now descends
singleton_class for macros (class << self), consistent with the regular def-path.
Engine carries zero language-named identifiers.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Final verification + beads

**Files:** none (verification only)

- [ ] **Step 1: Full suite + lint + build**

Run: `npx vitest run && npx eslint src/core/domains/{language,ingest}/pipeline 2>/dev/null; npx eslint src && npm run build`
Expected: all green. (If a pre-commit coverage hook fails, delegate to the `coverage-expander` subagent per `.claude/CLAUDE.md` — do not lower thresholds.)

- [ ] **Step 2: Count-preservation check (domains-language rule)**

Run: `git diff --stat <base> -- tests/core/domains/language/go tests/core/domains/language/javascript tests/core/domains/ingest/pipeline/chunker`
Confirm: `it` / `test` / `describe` counts in the go / js / ruby chunker + walker test files are ≥ the base branch — nothing dropped (relocated cases preserved).

- [ ] **Step 3: Live symbolId-convention check (per symbolid-convention.md)**

After re-linking + reindexing the tea-rags self-test (see `.claude/CLAUDE.md` MCP workflow), confirm a Go instance method appears as `Receiver#Method` in BOTH `find_symbol(symbol: "Context#Query")` payload AND `get_callers(symbolId: "Context#Query")`.

- [ ] **Step 4: Close beads tasks**

```bash
bd close tea-rags-mcp-aah9 --reason "Go chunk-type + symbol fully migrated to GoChunkClassifier + shared goSymbolOf; engine language=== branches removed; chunker/hooks/go/ relocated and deleted"
bd close tea-rags-mcp-9zh4 --reason "macro-walk de-language-named; driven by kernel scopeContainerTypes/scopeSeparator; singleton_class descent added"
```

---

## Self-Review

**Spec coverage:**
- Capability interface (`LanguageChunkClassifier` / `ChunkDecision` / `EmittedChunk`) → Task 1. ✓
- Go DRY shared module + `goNameOf` delegation → Task 2. ✓
- `GoChunkClassifier` (chunkType refine + naming) → Task 3a. ✓
- JS `chunkSymbols` → `JsChunkClassifier` → Task 3b. ✓
- Engine reroute, floor/merge fold, remove `language===` + `extractGoSymbol`, delete `chunker/hooks/go/` → Tasks 4–5. ✓
- W2 Ruby macro-walk de-naming + kernel-driven scope + `singleton_class` delta → Task 6. ✓
- Out-of-scope (markdown tier-1, CharacterChunker fallback, RSpec, child path) → untouched: no task references them. ✓
- Test strategy (count preservation, behavior-identical, new unit tests, live symbolId check) → Tasks 2/3/5/6/7. ✓

**Placeholder scan:** none — every code step shows complete code; every run step shows the command + expected result.

**Type consistency:** `goSymbolOf` returns `{name, symbolId, instanceMethod}` (Task 2) consumed identically in Task 2 `goNameOf` and Task 3a `GoChunkClassifier`. `ChunkDecision` / `EmittedChunk` / `ChunkType` (Task 1) used consistently in Tasks 3a/3b/5. `classifier?` field name consistent across `LanguageChunkerHooks` (Task 1), `LanguageConfig` (Task 4), provider wiring (Tasks 3a/3b), and the `chunkSingleNode` parameter (Task 5). `metadata.claimed` defined Task 1, written Task 5 emit branch, read Task 5 merge guard.
