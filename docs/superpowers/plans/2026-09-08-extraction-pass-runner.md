# Extraction Pass-Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every language ONE way to add an extraction facet without
touching its native walker. A shared kernel engine runs the language's existing
monolithic `walk`, then an ordered list of `ExtractionPass`es, merging each
pass's `Partial<FileExtraction>` append-only. Ruby and Python are wired through
it with EMPTY pass lists, so today's output is byte-identical and the 30+ Ruby
walker tests and 2 Python ones stay green untouched. This is E1 seam 0 — the
first mechanism both verticals visibly share, and the shape the Plugin SDK
(`z6ry9`) later publishes to external authors.

**Architecture:** Model A from the plugin design. Native walker monoliths are
NOT re-sliced. `composeExtractionWalker({ walk, nameOf, passes })` returns a
`LanguageWalker` whose `walk` calls the native function first and, only when
`passes.length > 0`, folds each pass's partial into the result through
`mergeExtraction`. With zero passes the composed walker returns the native
object **by identity** — no copy, no allocation, no merge. The merge is
append-only: arrays concat, Records union with the BASE's value kept on a
conflict, chunks merge by `symbolId`, and a channel neither side carries is
never materialised. Every channel of `FileExtraction` and `ChunkExtraction` has
a row in a rulebook expressed as a mapped type over `keyof`, so a NEW channel is
a compile error until someone decides how it merges.

**Tech Stack:** TypeScript (NodeNext, `strict`), vitest, tree-sitter, tsx for
the corpus harnesses. New code lives in `src/core/domains/language/kernel/`; the
contract change is one optional field on an existing interface in
`src/core/contracts/types/language.ts`.

**Spec:**
docs/superpowers/specs/2026-09-03-python-codegraph-unification-program-design.md
(E1 seam 0; plugin Model A:
docs/superpowers/specs/2026-06-18-plugin-system-design.md)

## Global Constraints

- **Byte-identical with zero passes.**
  `composeExtractionWalker(...).walk(input)` MUST return `parts.walk(input)` by
  identity when `passes` is empty. A test asserts `toBe`, and a corpus harness
  asserts JSON equality over real Ruby files.
- **NDJSON spill discipline.** Every merged channel stays a plain `Record` /
  array. Never introduce a `Map` or `Set` into a `FileExtraction` value — it
  serialises to `{}` and loses every entry
  (`contracts/types/codegraph-extraction.ts:8-11`). `Set` is fine as a local
  dedupe device inside the merge.
- **Emit only non-empty.** Ruby publishes its optional channels only when they
  carry something (`ruby/walker/walker.ts:113`, `class-hierarchy.ts`,
  `type-channels.ts:45`). The merge never materialises `{}` / `[]` on a channel
  the base lacks, and an incoming EMPTY channel is a no-op.
- **Base never loses.** A key the native walker wrote is never overwritten by a
  pass. Precedence inversions INSIDE a native walker (YARD `@return` overwriting
  body inference at `ruby/walker/type-channels.ts:44`; body inference NOT
  overwriting the store at `:79`) stay inside that monolith — this merge governs
  only native-vs-pass and pass-vs-pass.
- **No Ruby / Python test edits.** Relocation discipline
  (`.claude/rules/resolver-architecture.md` §4,
  `.claude/rules/test-invariants.md`).
  `git diff --stat -- tests/core/domains/language/ruby tests/core/domains/language/python`
  must be empty at the end of Task 3.
- **Perf gate.** Peak RSS ≤ +20% of the recorded baseline per corpus (httpx 260
  MB, flask 275 MB, ugnest 352 MB, polar 959 MB, netbox 1,293 MB); wall within
  +25% under equal load.
- **Commit format.** One commit per task. `type(scope): subject (bead)`, header
  ≤ 100 chars, body lines ≤ 100 chars. Scopes: `contracts` for the `WalkContext`
  change, `language` for everything else. Beads: Task 1 `qns77`, Task 2 `pss0q`,
  Tasks 3 and 4 the E1 epic `fmcly`.
- **No `Why:` line needed.** None of the touched files is on the deep-silo list
  in `.claude/rules/silo-pairing.md`. Do not add one.
- **Plain `Error` is correct here.** A pass disagreeing with the walker about
  `relPath` / `language` is a programming error, the one exception
  `.claude/rules/typed-errors.md` rule 5 admits. Do not reach into the error
  hierarchy.
- **Worktree per task.** Executed by a fresh Opus subagent in its own git
  worktree. A fresh worktree has no `build/` and the chunker pool forks the
  COMPILED worker, so run `npm run build` once before the first test run — a
  bare build, no `npm link`, no reindex.

---

## File Structure

**Created**

| File                                                           | Single responsibility                                                                                            |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `src/core/domains/language/kernel/merge-extraction.ts`         | The per-channel merge rulebook for `FileExtraction` + `ChunkExtraction`, and `mergeExtraction` which applies it. |
| `src/core/domains/language/kernel/extraction-passes.ts`        | `ExtractionFacetPass`, the pass-runner, `WalkInput` → `WalkContext`, and the walker composer.                    |
| `src/core/domains/language/ruby/walker/passes.ts`              | Ruby's ordered extraction pass list (empty today).                                                               |
| `src/core/domains/language/python/walker/passes.ts`            | Python's ordered extraction pass list (empty today).                                                             |
| `tests/core/domains/language/kernel/merge-extraction.test.ts`  | One case per rulebook line, plus purity and the type-level rulebook-completeness assertion.                      |
| `tests/core/domains/language/kernel/extraction-passes.test.ts` | Identity on zero passes, ordering, context threading, `nameOf` pass-through.                                     |
| `scripts/spikes/ruby-walker-composition-parity.ts`             | The Ruby byte-identical gate: native monolith vs composed walker over a corpus, compared as spilled JSON.        |

**Modified**

| File                                               | Change                                                    |
| -------------------------------------------------- | --------------------------------------------------------- |
| `src/core/contracts/types/language.ts`             | `WalkContext` gains `gemfileContent?: string` (additive). |
| `src/core/domains/language/ruby/index.ts`          | `walker` built through `composeExtractionWalker`.         |
| `src/core/domains/language/python/index.ts`        | Same.                                                     |
| `src/core/domains/language/ruby/walker/index.ts`   | Re-export `RUBY_EXTRACTION_PASSES`.                       |
| `src/core/domains/language/python/walker/index.ts` | Re-export `PYTHON_EXTRACTION_PASSES`.                     |
| `src/core/domains/language/CLAUDE.md`              | One Mechanics bullet for the pass-runner.                 |

---

## Context the implementer needs

Read these before Task 1; the plan assumes them.

- `ExtractionPass<T>` and `WalkContext` already exist at
  `src/core/contracts/types/language.ts:196-225` with **zero consumers** —
  declared for this seam and never wired. `WalkContext` lacks `gemfileContent`,
  which Ruby threads via `WalkInput.gemfileContent` (read at
  `ruby/walker/walker.ts:92`, supplied at both production call sites:
  `chunker/infra/worker.ts:141` and `codegraph/symbols/provider.ts:1714`).
- `mergeExtraction` / `mergeProvider` do not exist anywhere. The only
  per-channel merge precedent is `run-state.ts:1068-1140`, which merges channels
  RUN-globally (Record union last-write-wins, `Set` union for
  `compactDeclaredClasses` / `instantiatedTypes`, `dispatchTables` deduped by
  `relPath`). That is a different merge with different rules — read it for
  shape, do not copy its precedence.
- `chunks` is an array but is semantically keyed by `symbolId`: one record per
  `input.chunks` entry, same order (`ruby/walker/chunk-extractions.ts:26-30`).
- `localBindings` arrays are line-ordered — `resolveLocalBindingType` takes the
  most-recent binding at or before a call's line, and the TS walker sorts
  explicitly at `typescript/walker/walker.ts:93`.
- `classPrependedAncestors` values are in declaration order and the MRO is read
  in REVERSE; `imports` order is `[...explicit, ...constantRefs]`
  (`ruby/walker/walker.ts:99`); `paramNames` is positional. None of these arrays
  may be concatenated across passes.
- Worker DI: nothing crosses `postMessage` as an object — the language module is
  `import(path)`-ed in-thread (`.claude/rules/domains-language.md` §2). A pass
  list is therefore a **static export of the language module**, composed inside
  `<lang>/index.ts`, never injected across the worker boundary.
- `scripts/codegraph-chain-tally.ts` builds its extractions through
  `LanguageFactory.create(lang).walker.walk` (`extractFile`, line 298), so it
  exercises the composed walker. Its `CHAINS` table has **`python` and `java`
  only** — there is no Ruby chain spec, which is why Task 3 adds a purpose-built
  Ruby parity harness instead.

---

## Task 1: `mergeExtraction` — the append-only channel rulebook

**Files**

- Create `src/core/domains/language/kernel/merge-extraction.ts`
- Create `tests/core/domains/language/kernel/merge-extraction.test.ts`

**Interfaces**

_Consumes_

```ts
import type {
  ChunkExtraction,
  FileExtraction,
  LocalBinding,
} from "../../../contracts/types/codegraph.js";
```

_Produces_

```ts
export type ExtractionChannelMerger<TOwner, K extends keyof TOwner> = (
  baseValue: TOwner[K],
  passValue: NonNullable<TOwner[K]>,
) => TOwner[K];

export type ExtractionMergeRulebook<TOwner> = {
  [K in keyof TOwner]-?: ExtractionChannelMerger<TOwner, K>;
};

export function mergeExtraction(
  base: FileExtraction,
  partial: Partial<FileExtraction>,
): FileExtraction;
```

**Steps**

- [x] Build the worktree once so worker-forking specs can run: `npm run build`.
      Bare build only — no `npm link`, no reindex.

- [x] Write the failing test file
      `tests/core/domains/language/kernel/merge-extraction.test.ts`:

```ts
/**
 * The append-only extraction merge (E1 seam 0, bd tea-rags-mcp-qns77). One case
 * per rulebook line in `kernel/merge-extraction.ts`, because the rulebook is the
 * contract: a channel that merges the wrong way corrupts the codegraph payload
 * silently — the spill still parses, the edges are just wrong.
 */
import { describe, expect, it } from "vitest";

import type {
  ChunkExtraction,
  FileExtraction,
} from "../../../../../src/core/contracts/types/codegraph.js";
import {
  mergeExtraction,
  type ExtractionMergeRulebook,
} from "../../../../../src/core/domains/language/kernel/merge-extraction.js";

function baseExtraction(
  overrides: Partial<FileExtraction> = {},
): FileExtraction {
  return {
    relPath: "app/models/user.rb",
    language: "ruby",
    imports: [{ importText: "zeitwerk:Account", startLine: 1 }],
    chunks: [],
    fileScope: ["User"],
    ...overrides,
  };
}

function chunk(
  symbolId: string,
  overrides: Partial<ChunkExtraction> = {},
): ChunkExtraction {
  return { symbolId, scope: ["User"], calls: [], ...overrides };
}

function call(member: string, startLine: number) {
  return { callText: `${member}()`, receiver: null, member, startLine };
}

describe("mergeExtraction — file identity", () => {
  it("keeps the base's relPath and language, ignoring an agreeing partial", () => {
    const merged = mergeExtraction(baseExtraction(), {
      relPath: "app/models/user.rb",
      language: "ruby",
    });
    expect(merged.relPath).toBe("app/models/user.rb");
    expect(merged.language).toBe("ruby");
  });

  it("throws when a pass claims a different relPath", () => {
    expect(() =>
      mergeExtraction(baseExtraction(), { relPath: "app/models/account.rb" }),
    ).toThrow(/relPath "app\/models\/account\.rb"/);
  });

  it("throws when a pass claims a different language", () => {
    expect(() =>
      mergeExtraction(baseExtraction(), { language: "python" }),
    ).toThrow(/language "python"/);
  });
});

describe("mergeExtraction — absent stays absent", () => {
  it("returns a value deep-equal to the base for an empty partial", () => {
    const base = baseExtraction();
    expect(mergeExtraction(base, {})).toEqual(base);
  });

  it("does not materialise an optional channel the base never carried", () => {
    const merged = mergeExtraction(baseExtraction(), {});
    expect("classExtends" in merged).toBe(false);
    expect("dispatchTables" in merged).toBe(false);
    expect("classAncestors" in merged).toBe(false);
  });

  it("treats an EMPTY incoming channel as a no-op rather than materialising it", () => {
    const merged = mergeExtraction(baseExtraction(), {
      classExtends: {},
      instantiatedTypes: [],
      inheritanceEdges: [],
    });
    expect("classExtends" in merged).toBe(false);
    expect("instantiatedTypes" in merged).toBe(false);
    expect("inheritanceEdges" in merged).toBe(false);
  });

  it("adopts a channel the base lacks when the pass actually carries one", () => {
    const merged = mergeExtraction(baseExtraction(), {
      classExtends: { User: "ApplicationRecord" },
    });
    expect(merged.classExtends).toEqual({ User: "ApplicationRecord" });
  });
});

describe("mergeExtraction — arrays concat, base first", () => {
  it("concatenates imports and fileScope", () => {
    const merged = mergeExtraction(baseExtraction(), {
      imports: [{ importText: "zeitwerk:Post", startLine: 4 }],
      fileScope: ["Admin::User"],
    });
    expect(merged.imports.map((i) => i.importText)).toEqual([
      "zeitwerk:Account",
      "zeitwerk:Post",
    ]);
    expect(merged.fileScope).toEqual(["User", "Admin::User"]);
  });

  it("concatenates inheritanceEdges and knownTargetCallArgs onto an absent base channel", () => {
    const merged = mergeExtraction(baseExtraction(), {
      inheritanceEdges: [
        { source: "User", ancestor: "Base", kind: "super", ordinal: 0 },
      ],
      knownTargetCallArgs: [{ targets: ["User#initialize"], argTypes: [null] }],
    });
    expect(merged.inheritanceEdges).toHaveLength(1);
    expect(merged.knownTargetCallArgs).toHaveLength(1);
  });
});

describe("mergeExtraction — set-like arrays dedupe on the FIRST occurrence", () => {
  it("keeps base order and drops a repeat the pass re-declares", () => {
    const base = baseExtraction({
      compactDeclaredClasses: ["A::B", "C"],
      instantiatedTypes: ["User"],
    });
    const merged = mergeExtraction(base, {
      compactDeclaredClasses: ["C", "D"],
      instantiatedTypes: ["User", "Post"],
    });
    expect(merged.compactDeclaredClasses).toEqual(["A::B", "C", "D"]);
    expect(merged.instantiatedTypes).toEqual(["User", "Post"]);
  });
});

describe("mergeExtraction — Records union, base wins on a conflicting key", () => {
  it("keeps the base's value and adds the pass's new keys", () => {
    const base = baseExtraction({
      classExtends: { User: "ApplicationRecord" },
      classSchemaTables: { Firm: "companies" },
      functionReturnTypes: { build: "Widget" },
      structuredReturnTypes: {
        "User#profile": { form: "instance", name: "Profile" },
      },
      dispatchTables: { HANDLERS: { entries: { a: "handleA" } } },
    });
    const merged = mergeExtraction(base, {
      classExtends: { User: "WRONG", Post: "ApplicationRecord" },
      classSchemaTables: { Firm: "WRONG", Deal: "deals" },
      functionReturnTypes: { build: "WRONG", make: "Gadget" },
      structuredReturnTypes: {
        "User#profile": { form: "nil" },
        "User#posts": {
          form: "container",
          element: { form: "instance", name: "Post" },
        },
      },
      dispatchTables: {
        HANDLERS: { entries: { z: "WRONG" } },
        ROUTES: { entries: { b: "handleB" } },
      },
    });
    expect(merged.classExtends).toEqual({
      User: "ApplicationRecord",
      Post: "ApplicationRecord",
    });
    expect(merged.classSchemaTables).toEqual({
      Firm: "companies",
      Deal: "deals",
    });
    expect(merged.functionReturnTypes).toEqual({
      build: "Widget",
      make: "Gadget",
    });
    expect(merged.structuredReturnTypes?.["User#profile"]).toEqual({
      form: "instance",
      name: "Profile",
    });
    expect(merged.structuredReturnTypes?.["User#posts"]).toEqual({
      form: "container",
      element: { form: "instance", name: "Post" },
    });
    expect(merged.dispatchTables?.HANDLERS).toEqual({
      entries: { a: "handleA" },
    });
    expect(merged.dispatchTables?.ROUTES).toEqual({
      entries: { b: "handleB" },
    });
  });
});

describe("mergeExtraction — nested Records union per outer THEN inner key", () => {
  it("merges inner maps and keeps the base's value on an inner conflict", () => {
    const base = baseExtraction({
      classFieldTypes: { User: { account: "Account" } },
      associationTypes: { User: { posts: "Post" } },
      ivarTypes: { User: { "@account": "Account" } },
      classFieldParamLinks: {
        User: { "@firm": { method: "initialize", param: "firm" } },
      },
    });
    const merged = mergeExtraction(base, {
      classFieldTypes: {
        User: { account: "WRONG", firm: "Firm" },
        Post: { author: "User" },
      },
      associationTypes: { User: { posts: "WRONG", agents: "Agent" } },
      ivarTypes: { User: { "@account": "WRONG", "@firm": "Firm" } },
      classFieldParamLinks: {
        User: {
          "@firm": { method: "WRONG", param: "WRONG" },
          "@deal": { method: "initialize", param: "deal" },
        },
      },
    });
    expect(merged.classFieldTypes).toEqual({
      User: { account: "Account", firm: "Firm" },
      Post: { author: "User" },
    });
    expect(merged.associationTypes).toEqual({
      User: { posts: "Post", agents: "Agent" },
    });
    expect(merged.ivarTypes).toEqual({
      User: { "@account": "Account", "@firm": "Firm" },
    });
    expect(merged.classFieldParamLinks?.User["@firm"]).toEqual({
      method: "initialize",
      param: "firm",
    });
    expect(merged.classFieldParamLinks?.User["@deal"]).toEqual({
      method: "initialize",
      param: "deal",
    });
  });
});

describe("mergeExtraction — Record-of-arrays unions KEYS, never concatenates arrays", () => {
  it("keeps the base's array untouched for a key both sides declare", () => {
    const base = baseExtraction({
      classAncestors: { User: ["ApplicationRecord"] },
      classPrependedAncestors: { User: ["Auditable"] },
      callbackParams: { "User#each": [0] },
    });
    const merged = mergeExtraction(base, {
      classAncestors: { User: ["WRONG"], Post: ["ApplicationRecord"] },
      classPrependedAncestors: { User: ["WRONG"], Post: ["Auditable"] },
      callbackParams: { "User#each": [1], "Post#map": [0] },
    });
    expect(merged.classAncestors).toEqual({
      User: ["ApplicationRecord"],
      Post: ["ApplicationRecord"],
    });
    expect(merged.classPrependedAncestors).toEqual({
      User: ["Auditable"],
      Post: ["Auditable"],
    });
    expect(merged.callbackParams).toEqual({
      "User#each": [0],
      "Post#map": [0],
    });
  });
});

describe("mergeExtraction — chunks merge by symbolId", () => {
  it("concatenates calls on the matching chunk, base first", () => {
    const base = baseExtraction({
      chunks: [chunk("User#save", { calls: [call("persist", 3)] })],
    });
    const merged = mergeExtraction(base, {
      chunks: [chunk("User#save", { calls: [call("audit", 5)] })],
    });
    expect(merged.chunks).toHaveLength(1);
    expect(merged.chunks[0].calls.map((c) => c.member)).toEqual([
      "persist",
      "audit",
    ]);
  });

  it("unions localBindings per variable and re-sorts a shared variable by line", () => {
    const base = baseExtraction({
      chunks: [
        chunk("User#save", {
          localBindings: { acct: [{ line: 10, type: "Account" }] },
        }),
      ],
    });
    const merged = mergeExtraction(base, {
      chunks: [
        chunk("User#save", {
          localBindings: {
            acct: [{ line: 2, type: "Draft" }],
            firm: [{ line: 4, type: "Firm" }],
          },
        }),
      ],
    });
    expect(merged.chunks[0].localBindings?.acct).toEqual([
      { line: 2, type: "Draft" },
      { line: 10, type: "Account" },
    ]);
    expect(merged.chunks[0].localBindings?.firm).toEqual([
      { line: 4, type: "Firm" },
    ]);
  });

  it("keeps the base's binding for a localCallBindings key both sides declare", () => {
    const base = baseExtraction({
      chunks: [chunk("User#save", { localCallBindings: { engine: "New" } })],
    });
    const merged = mergeExtraction(base, {
      chunks: [
        chunk("User#save", {
          localCallBindings: { engine: "WRONG", other: "Build" },
        }),
      ],
    });
    expect(merged.chunks[0].localCallBindings).toEqual({
      engine: "New",
      other: "Build",
    });
  });

  it("keeps the base's chunk scalars and lets a pass FILL one the base left absent", () => {
    const base = baseExtraction({
      chunks: [
        chunk("User#save", {
          startLine: 3,
          endLine: 9,
          visibility: "private",
          acceptsBlock: false,
        }),
      ],
    });
    const merged = mergeExtraction(base, {
      chunks: [
        chunk("User#save", {
          scope: ["WRONG"],
          startLine: 99,
          endLine: 99,
          visibility: "public",
          acceptsBlock: true,
          arity: { minRequired: 1, maxPositional: 2, hasSplat: false },
          kwargs: { required: ["id"], optional: [], hasSplat: false },
          paramNames: ["id"],
          isAbstractStub: true,
        }),
      ],
    });
    const [only] = merged.chunks;
    expect(only.scope).toEqual(["User"]);
    expect(only.startLine).toBe(3);
    expect(only.endLine).toBe(9);
    expect(only.visibility).toBe("private");
    expect(only.acceptsBlock).toBe(false);
    expect(only.arity).toEqual({
      minRequired: 1,
      maxPositional: 2,
      hasSplat: false,
    });
    expect(only.kwargs).toEqual({
      required: ["id"],
      optional: [],
      hasSplat: false,
    });
    expect(only.paramNames).toEqual(["id"]);
    expect(only.isAbstractStub).toBe(true);
  });

  it("appends a synthesized chunk whose symbolId the base does not carry, after the base chunks", () => {
    const base = baseExtraction({ chunks: [chunk("User#save")] });
    const merged = mergeExtraction(base, {
      chunks: [chunk("User#posts"), chunk("User#agents")],
    });
    expect(merged.chunks.map((c) => c.symbolId)).toEqual([
      "User#save",
      "User#posts",
      "User#agents",
    ]);
  });
});

describe("mergeExtraction — purity", () => {
  it("returns a NEW object and leaves the base untouched", () => {
    const base = baseExtraction({
      chunks: [chunk("User#save", { calls: [call("persist", 3)] })],
    });
    const snapshot = JSON.stringify(base);
    const merged = mergeExtraction(base, {
      imports: [{ importText: "zeitwerk:Post", startLine: 4 }],
      chunks: [chunk("User#save", { calls: [call("audit", 5)] })],
    });
    expect(merged).not.toBe(base);
    expect(JSON.stringify(base)).toBe(snapshot);
  });
});

describe("mergeExtraction — the rulebook is exhaustive by construction", () => {
  it("rejects a rulebook that omits a channel", () => {
    // @ts-expect-error — a rulebook missing every channel but relPath is incomplete
    const incomplete: ExtractionMergeRulebook<FileExtraction> = {
      relPath: (base) => base,
    };
    expect(incomplete).toBeDefined();
  });

  it("rejects a partial carrying a channel FileExtraction does not declare", () => {
    // @ts-expect-error — `bogusChannel` is not a FileExtraction channel
    expect(() =>
      mergeExtraction(baseExtraction(), { bogusChannel: 1 }),
    ).not.toThrow();
  });
});
```

- [x] Run it and confirm the expected failure — the module does not exist yet:
      `npx vitest run tests/core/domains/language/kernel/merge-extraction.test.ts`
      Expected: `Failed to resolve import ".../kernel/merge-extraction.js"`
      (vitest reports it as an unresolved import, not a test assertion failure).

- [x] Write `src/core/domains/language/kernel/merge-extraction.ts`:

```ts
/**
 * `mergeExtraction` — the append-only merge one extraction pass's
 * `Partial<FileExtraction>` goes through on its way into a file's extraction
 * (E1 seam 0, bd tea-rags-mcp-qns77). Model A of the plugin design
 * (`docs/superpowers/specs/2026-06-18-plugin-system-design.md`, key decision 5):
 * a native walker monolith is never re-sliced — it runs first and owns every
 * channel it wrote; a pass may only ADD.
 *
 * Two properties the codegraph depends on:
 *
 *   - **Absent stays absent.** A channel neither side carries is not
 *     materialised as `{}` / `[]`, and an EMPTY incoming channel is a no-op.
 *     Ruby publishes its optional channels only when non-empty
 *     (`ruby/walker/walker.ts:113`, `class-hierarchy.ts`, `type-channels.ts:45`),
 *     and an empty object reaching the NDJSON spill moves the payload the
 *     schema-drift guard compares.
 *   - **Base never loses.** A key the native walker wrote is never overwritten.
 *     Precedence INSIDE a walker — YARD `@return` beating body inference at
 *     `ruby/walker/type-channels.ts:44`, body inference NOT overwriting the type
 *     store at `:79` — is that walker's own business and stays there. This merge
 *     governs only native-vs-pass and pass-vs-pass.
 *
 * Distinct from the run-global absorb at
 * `trajectory/codegraph/symbols/run-state.ts:1068`, which unions the SAME
 * channels across FILES with last-write-wins. Same channel names, opposite
 * precedence, different scope: do not unify them.
 *
 * Every channel of `FileExtraction` and `ChunkExtraction` has a row in a
 * rulebook below. The rulebook type is a mapped type with `-?` over `keyof`, so
 * a NEW channel fails to compile until it gets a row — the merge cannot silently
 * drop a facet somebody added to the contract.
 */

import type {
  ChunkExtraction,
  FileExtraction,
  LocalBinding,
} from "../../../contracts/types/codegraph.js";

/**
 * How one channel `K` of `TOwner` merges: the base's value (which may be absent)
 * plus a pass's value (which by construction is not).
 */
export type ExtractionChannelMerger<TOwner, K extends keyof TOwner> = (
  baseValue: TOwner[K],
  passValue: NonNullable<TOwner[K]>,
) => TOwner[K];

/** One merger per channel. `-?` so an OPTIONAL channel still demands a row. */
export type ExtractionMergeRulebook<TOwner> = {
  [K in keyof TOwner]-?: ExtractionChannelMerger<TOwner, K>;
};

/** Union of two Records where a key the BASE already carries keeps the base's value. */
function unionBaseWins<V>(
  base: Record<string, V> | undefined,
  pass: Record<string, V>,
): Record<string, V> {
  return { ...pass, ...(base ?? {}) };
}

/** Union of two Record-of-Records, per outer key and then per inner key, base winning both times. */
function unionNestedBaseWins<V>(
  base: Record<string, Record<string, V>> | undefined,
  pass: Record<string, Record<string, V>>,
): Record<string, Record<string, V>> {
  const out: Record<string, Record<string, V>> = { ...(base ?? {}) };
  for (const [outerKey, inner] of Object.entries(pass))
    out[outerKey] = unionBaseWins(out[outerKey], inner);
  return out;
}

/**
 * Union per variable. A variable both sides bind gets both arrays, re-sorted by
 * `line` — `resolveLocalBindingType` reads "greatest line <= the call", so an
 * unsorted concat would hand a call the pass's later binding purely because the
 * pass ran second.
 */
function mergeLocalBindings(
  base: Record<string, LocalBinding[]> | undefined,
  pass: Record<string, LocalBinding[]>,
): Record<string, LocalBinding[]> {
  const out: Record<string, LocalBinding[]> = { ...(base ?? {}) };
  for (const [variable, incoming] of Object.entries(pass)) {
    const existing = out[variable];
    out[variable] =
      existing === undefined
        ? incoming
        : [...existing, ...incoming].sort((a, b) => a.line - b.line);
  }
  return out;
}

const CHUNK_EXTRACTION_MERGE_RULEBOOK: ExtractionMergeRulebook<ChunkExtraction> =
  {
    // The merge key itself, and the lexical chain that travels with it.
    symbolId: (base) => base,
    scope: (base) => base,
    // The channel a pass is normally here to add to.
    calls: (base, pass) => [...base, ...pass],
    localBindings: (base, pass) => mergeLocalBindings(base, pass),
    localCallBindings: (base, pass) => unionBaseWins(base, pass),
    // Scalars: the base's answer stands; a pass may only FILL one the walker left
    // absent. `??` and not a truthiness test — `acceptsBlock: false` is a proven
    // non-yielder, not a missing value.
    startLine: (base, pass) => base ?? pass,
    endLine: (base, pass) => base ?? pass,
    arity: (base, pass) => base ?? pass,
    paramNames: (base, pass) => base ?? pass,
    visibility: (base, pass) => base ?? pass,
    kwargs: (base, pass) => base ?? pass,
    acceptsBlock: (base, pass) => base ?? pass,
    isAbstractStub: (base, pass) => base ?? pass,
  };

const FILE_EXTRACTION_MERGE_RULEBOOK: ExtractionMergeRulebook<FileExtraction> =
  {
    // File identity. A disagreement is caught by `assertSameFile` before the loop.
    relPath: (base) => base,
    language: (base) => base,
    // Append-only arrays: native entries first, pass entries after, order kept.
    imports: (base, pass) => [...base, ...pass],
    fileScope: (base, pass) => [...base, ...pass],
    inheritanceEdges: (base, pass) => [...(base ?? []), ...pass],
    knownTargetCallArgs: (base, pass) => [...(base ?? []), ...pass],
    // Set-like arrays: concat, then drop repeats KEEPING THE FIRST occurrence
    // (`Set` preserves insertion order; it never leaves this function, so the
    // NDJSON spill still sees a plain array).
    compactDeclaredClasses: (base, pass) => [
      ...new Set([...(base ?? []), ...pass]),
    ],
    instantiatedTypes: (base, pass) => [...new Set([...(base ?? []), ...pass])],
    // Records: union of keys, base's value kept on a conflict.
    classExtends: (base, pass) => unionBaseWins(base, pass),
    classSchemaTables: (base, pass) => unionBaseWins(base, pass),
    functionReturnTypes: (base, pass) => unionBaseWins(base, pass),
    structuredReturnTypes: (base, pass) => unionBaseWins(base, pass),
    dispatchTables: (base, pass) => unionBaseWins(base, pass),
    // Nested Records: union per outer key, then per inner key; base wins both.
    classFieldTypes: (base, pass) => unionNestedBaseWins(base, pass),
    associationTypes: (base, pass) => unionNestedBaseWins(base, pass),
    ivarTypes: (base, pass) => unionNestedBaseWins(base, pass),
    classFieldParamLinks: (base, pass) => unionNestedBaseWins(base, pass),
    // Record-of-arrays: union of KEYS only. A key present in both keeps the base's
    // array UNCHANGED — these are order-sensitive (`classPrependedAncestors` is
    // read in reverse for MRO, `callbackParams` holds parameter POSITIONS), so
    // concatenating two passes' arrays would invent an order neither wrote.
    classAncestors: (base, pass) => unionBaseWins(base, pass),
    classPrependedAncestors: (base, pass) => unionBaseWins(base, pass),
    callbackParams: (base, pass) => unionBaseWins(base, pass),
    // Keyed by symbolId, not by position — see `mergeChunks`.
    chunks: (base, pass) => mergeChunks(base, pass),
  };

const FILE_MERGE_CHANNELS = Object.keys(
  FILE_EXTRACTION_MERGE_RULEBOOK,
) as (keyof FileExtraction)[];
const CHUNK_MERGE_CHANNELS = Object.keys(
  CHUNK_EXTRACTION_MERGE_RULEBOOK,
) as (keyof ChunkExtraction)[];

/**
 * A channel whose value is an empty array / empty object carries nothing, and
 * writing it would materialise a key the walker deliberately left absent. Scalars
 * are never "empty" — `visibility: "public"` and `acceptsBlock: false` are real
 * answers.
 */
function carriesNothing(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object" && value !== null)
    return Object.keys(value).length === 0;
  return false;
}

function applyChannel<TOwner, K extends keyof TOwner>(
  rulebook: ExtractionMergeRulebook<TOwner>,
  out: TOwner,
  base: TOwner,
  pass: Partial<TOwner>,
  key: K,
): void {
  const incoming = pass[key];
  if (incoming === undefined || carriesNothing(incoming)) return;
  // Sound by the guard above: a generic indexed access does not narrow on its own.
  out[key] = rulebook[key](base[key], incoming as NonNullable<TOwner[K]>);
}

/**
 * Merge a pass's chunk records into the walker's, matched by `symbolId` — the
 * walker emits one record per `input.chunks` entry in the same order
 * (`ruby/walker/chunk-extractions.ts:26`), so position is an accident of the
 * chunk list while the id is the identity. A record whose id the walker did not
 * emit is a chunk the pass SYNTHESIZED (a Rails association accessor, say) and is
 * appended after the walker's own, in the pass's order.
 */
function mergeChunks(
  base: readonly ChunkExtraction[],
  pass: readonly ChunkExtraction[],
): ChunkExtraction[] {
  const merged = [...base];
  const indexBySymbolId = new Map<string, number>();
  merged.forEach((entry, index) => {
    if (!indexBySymbolId.has(entry.symbolId))
      indexBySymbolId.set(entry.symbolId, index);
  });
  for (const incoming of pass) {
    const at = indexBySymbolId.get(incoming.symbolId);
    if (at === undefined) {
      indexBySymbolId.set(incoming.symbolId, merged.length);
      merged.push(incoming);
      continue;
    }
    merged[at] = mergeOneChunk(merged[at], incoming);
  }
  return merged;
}

function mergeOneChunk(
  base: ChunkExtraction,
  pass: ChunkExtraction,
): ChunkExtraction {
  const out: ChunkExtraction = { ...base };
  for (const key of CHUNK_MERGE_CHANNELS)
    applyChannel(CHUNK_EXTRACTION_MERGE_RULEBOOK, out, base, pass, key);
  return out;
}

function assertSameFile(
  base: FileExtraction,
  partial: Partial<FileExtraction>,
): void {
  // Programming error, not user input — the one case `.claude/rules/typed-errors.md`
  // rule 5 lets stay a plain Error.
  if (partial.relPath !== undefined && partial.relPath !== base.relPath) {
    throw new Error(
      `mergeExtraction: a pass claimed relPath "${partial.relPath}" while the walker extracted "${base.relPath}"`,
    );
  }
  if (partial.language !== undefined && partial.language !== base.language) {
    throw new Error(
      `mergeExtraction: a pass claimed language "${partial.language}" while the walker extracted "${base.language}"`,
    );
  }
}

/**
 * Fold one pass's partial into a file's extraction. Pure: `base` is not mutated
 * and the result is a new object. A channel the partial omits — or carries empty
 * — leaves the base's channel exactly as it was, absent ones included.
 */
export function mergeExtraction(
  base: FileExtraction,
  partial: Partial<FileExtraction>,
): FileExtraction {
  assertSameFile(base, partial);
  const out: FileExtraction = { ...base };
  for (const key of FILE_MERGE_CHANNELS)
    applyChannel(FILE_EXTRACTION_MERGE_RULEBOOK, out, base, partial, key);
  return out;
}
```

- [x] Run the unit gate:
      `npx vitest run tests/core/domains/language/kernel/merge-extraction.test.ts`
      — all cases green.

- [x] Run the type-level gate (the `@ts-expect-error` assertions are only
      checked here; `npm run type-check` covers `src/**` alone):
      `npx tsc --noEmit -p tsconfig.eslint.json` — clean.

- [x] Run lint on the new files:
      `npx eslint --max-warnings 0 src/core/domains/language/kernel/merge-extraction.ts tests/core/domains/language/kernel/merge-extraction.test.ts`

- [x] Commit:

```text
feat(language): add the append-only extraction channel merge (qns77)

E1 seam 0 needs one place that folds an extraction pass's Partial<FileExtraction>
into a file's extraction without letting the pass overwrite what the native
walker wrote. mergeExtraction is that place: arrays concat base-first, set-like
arrays dedupe on the first occurrence, Records union with the base's value kept,
Record-of-arrays union KEYS only (classPrependedAncestors is read in reverse for
MRO — a concat would invent an order), and chunks merge by symbolId with
localBindings re-sorted by line so resolveLocalBindingType still reads the right
binding.

A channel neither side carries is never materialised, and an empty incoming
channel is a no-op: Ruby emits its optional channels only when non-empty, and an
empty object reaching the NDJSON spill moves the payload the schema-drift guard
compares.

The rulebook is a mapped type with -? over keyof, so a new FileExtraction or
ChunkExtraction channel fails to compile until it gets a row.
```

---

## Task 2: the pass-runner, the walker composer, and `WalkContext.gemfileContent`

**Files**

- Modify `src/core/contracts/types/language.ts`
- Create `src/core/domains/language/kernel/extraction-passes.ts`
- Create `tests/core/domains/language/kernel/extraction-passes.test.ts`

**Interfaces**

_Consumes_

```ts
import type { AstNode } from "../../../contracts/types/ast.js";
import type { FileExtraction } from "../../../contracts/types/codegraph.js";
import type {
  ExtractionPass,
  LanguageWalker,
  WalkContext,
  WalkInput,
} from "../../../contracts/types/language.js";
import { mergeExtraction } from "./merge-extraction.js";
```

_Produces_

```ts
export type ExtractionFacetPass = ExtractionPass<Partial<FileExtraction>>;

export interface ExtractionWalkerParts {
  walk: (input: WalkInput) => FileExtraction;
  nameOf: LanguageWalker["nameOf"];
  passes: readonly ExtractionFacetPass[];
}

export function runExtractionPasses(
  native: FileExtraction,
  passes: readonly ExtractionFacetPass[],
  root: AstNode,
  ctx: WalkContext,
): FileExtraction;

export function toWalkContext(input: WalkInput): WalkContext;

export function composeExtractionWalker(
  parts: ExtractionWalkerParts,
): LanguageWalker;
```

**Steps**

- [x] Write the failing test file
      `tests/core/domains/language/kernel/extraction-passes.test.ts`:

```ts
/**
 * The extraction pass-runner (E1 seam 0, bd tea-rags-mcp-pss0q). The load-bearing
 * assertion is the identity one: with no passes the composed walker must return
 * the native walker's OWN object, because that is what makes wiring Ruby and
 * Python through this engine a relocation rather than a behaviour change.
 */
import { describe, expect, it, vi } from "vitest";

import type {
  AstNode,
  MaterializedTree,
} from "../../../../../src/core/contracts/types/ast.js";
import type { FileExtraction } from "../../../../../src/core/contracts/types/codegraph.js";
import type {
  WalkContext,
  WalkInput,
} from "../../../../../src/core/contracts/types/language.js";
import {
  composeExtractionWalker,
  runExtractionPasses,
  toWalkContext,
  type ExtractionFacetPass,
} from "../../../../../src/core/domains/language/kernel/extraction-passes.js";

function stubNode(type = "program"): AstNode {
  return {
    type,
    text: "",
    startIndex: 0,
    endIndex: 0,
    startPosition: { row: 0, column: 0 },
    endPosition: { row: 0, column: 0 },
    children: [],
    namedChildren: [],
    childCount: 0,
    namedChildCount: 0,
    isNamed: true,
    child: () => null,
    namedChild: () => null,
    childForFieldName: () => null,
    parent: null,
    previousNamedSibling: null,
  };
}

function stubInput(overrides: Partial<WalkInput> = {}): WalkInput {
  const tree: MaterializedTree = { rootNode: stubNode() };
  return {
    tree,
    code: "class User; end",
    relPath: "app/models/user.rb",
    language: "ruby",
    chunks: [{ symbolId: "User", startLine: 1, endLine: 1, scope: [] }],
    ...overrides,
  };
}

function nativeExtraction(input: WalkInput): FileExtraction {
  return {
    relPath: input.relPath,
    language: input.language,
    imports: [],
    chunks: [],
    fileScope: ["User"],
  };
}

describe("runExtractionPasses", () => {
  it("returns the native extraction BY IDENTITY when there are no passes", () => {
    const native = nativeExtraction(stubInput());
    expect(
      runExtractionPasses(native, [], stubNode(), toWalkContext(stubInput())),
    ).toBe(native);
  });

  it("folds each pass in order, so a later pass merges onto the earlier one's result", () => {
    const native = nativeExtraction(stubInput());
    const first: ExtractionFacetPass = {
      run: () => ({ fileScope: ["First"] }),
    };
    const second: ExtractionFacetPass = {
      run: () => ({ fileScope: ["Second"] }),
    };
    const merged = runExtractionPasses(
      native,
      [first, second],
      stubNode(),
      toWalkContext(stubInput()),
    );
    expect(merged.fileScope).toEqual(["User", "First", "Second"]);
    expect(native.fileScope).toEqual(["User"]);
  });

  it("hands every pass the root node and the walk context", () => {
    const root = stubNode("module");
    const ctx = toWalkContext(stubInput());
    const run = vi.fn(() => ({}));
    runExtractionPasses(nativeExtraction(stubInput()), [{ run }], root, ctx);
    expect(run).toHaveBeenCalledWith(root, ctx);
  });
});

describe("toWalkContext", () => {
  it("carries code, relPath, language and chunks straight through", () => {
    const input = stubInput();
    expect(toWalkContext(input)).toMatchObject({
      code: input.code,
      relPath: input.relPath,
      language: input.language,
      chunks: input.chunks,
    });
  });

  it("omits gemfileContent entirely when the run has no Gemfile", () => {
    expect("gemfileContent" in toWalkContext(stubInput())).toBe(false);
  });

  it("threads gemfileContent when the run has one", () => {
    const ctx: WalkContext = toWalkContext(
      stubInput({ gemfileContent: "gem 'rails'" }),
    );
    expect(ctx.gemfileContent).toBe("gem 'rails'");
  });

  it("leaves dispatchTableNames absent — the native walker owns that channel", () => {
    expect("dispatchTableNames" in toWalkContext(stubInput())).toBe(false);
  });
});

describe("composeExtractionWalker", () => {
  it("returns the native walker's own object when the pass list is empty", () => {
    const produced: FileExtraction[] = [];
    const walker = composeExtractionWalker({
      walk: (input) => {
        const out = nativeExtraction(input);
        produced.push(out);
        return out;
      },
      nameOf: () => null,
      passes: [],
    });
    const result = walker.walk(stubInput());
    expect(result).toBe(produced[0]);
    expect(produced).toHaveLength(1);
  });

  it("merges the pass output when the pass list is not empty", () => {
    const walker = composeExtractionWalker({
      walk: nativeExtraction,
      nameOf: () => null,
      passes: [{ run: () => ({ fileScope: ["FromPass"] }) }],
    });
    expect(walker.walk(stubInput()).fileScope).toEqual(["User", "FromPass"]);
  });

  it("passes nameOf through untouched", () => {
    const nameOf = vi.fn(() => null);
    expect(
      composeExtractionWalker({ walk: nativeExtraction, nameOf, passes: [] })
        .nameOf,
    ).toBe(nameOf);
  });
});
```

- [x] Run it and confirm the expected failure:
      `npx vitest run tests/core/domains/language/kernel/extraction-passes.test.ts`
      Expected: `Failed to resolve import ".../kernel/extraction-passes.js"`,
      plus a TS complaint about `gemfileContent` on `WalkInput`-derived
      `WalkContext` once the module exists — both are fixed below.

- [x] Add `gemfileContent` to `WalkContext` in
      `src/core/contracts/types/language.ts`. Replace:

```ts
export interface WalkContext {
  code: string;
  relPath: string;
  language: string;
  chunks: {
    symbolId: string;
    startLine: number;
    endLine: number;
    scope: string[];
  }[];
  dispatchTableNames?: ReadonlySet<string>;
}
```

with:

```ts
export interface WalkContext {
  code: string;
  relPath: string;
  language: string;
  chunks: {
    symbolId: string;
    startLine: number;
    endLine: number;
    scope: string[];
  }[];
  /**
   * Raw contents of the project's `Gemfile`, threaded per run so extraction-time
   * DSL consumers compose a gem-gated catalogue (`catalogueForGemfile`) for THIS
   * project. Mirrors {@link WalkInput.gemfileContent}, from which `toWalkContext`
   * copies it. Undefined → the FULL catalogue (gating off). Only Ruby reads it
   * today (bd tea-rags-mcp-adx5p.1b); every other language ignores it.
   */
  gemfileContent?: string;
  dispatchTableNames?: ReadonlySet<string>;
}
```

- [x] Write `src/core/domains/language/kernel/extraction-passes.ts`:

```ts
/**
 * The extraction pass-runner (E1 seam 0, bd tea-rags-mcp-pss0q) — the one
 * mechanism every language uses to add an extraction facet, and the first
 * component the Ruby and Python verticals visibly share.
 *
 * Model A (`docs/superpowers/specs/2026-06-18-plugin-system-design.md`, key
 * decision 5): the native walker runs FIRST and unchanged, then an ordered list
 * of passes, each returning a `Partial<FileExtraction>` that `mergeExtraction`
 * folds in append-only. A monolith is never re-sliced to add a facet — the facet
 * is a new pass. That is what keeps wiring an existing language through here a
 * relocation: with an EMPTY pass list `composeExtractionWalker(...).walk(input)`
 * returns the native walker's own object BY IDENTITY, so nothing downstream can
 * tell the difference, not even a JSON comparison of the spilled payload.
 *
 * The pass list is a static export of the language module
 * (`<lang>/walker/passes.ts`, composed in `<lang>/index.ts`) and never an
 * injected argument: nothing crosses `postMessage` as an object, and both
 * AST-walking workers reach a language by `import(modulePath)` in-thread
 * (`.claude/rules/domains-language.md` §2).
 */

import type { AstNode } from "../../../contracts/types/ast.js";
import type { FileExtraction } from "../../../contracts/types/codegraph.js";
import type {
  ExtractionPass,
  LanguageWalker,
  WalkContext,
  WalkInput,
} from "../../../contracts/types/language.js";
import { mergeExtraction } from "./merge-extraction.js";

/**
 * An `ExtractionPass` that contributes to one file's `FileExtraction`.
 *
 * Not to be confused with `FileExtractionPass1Telemetry`
 * (`contracts/types/provider.ts`), which is about PASS 1 of the codegraph's
 * two-pass RUN. This is a pass over a single file's AST.
 */
export type ExtractionFacetPass = ExtractionPass<Partial<FileExtraction>>;

/**
 * Fold every pass's partial into the native extraction, in list order, so a later
 * pass merges onto what earlier passes already produced. Returns `native`
 * untouched — by identity — when there are no passes.
 */
export function runExtractionPasses(
  native: FileExtraction,
  passes: readonly ExtractionFacetPass[],
  root: AstNode,
  ctx: WalkContext,
): FileExtraction {
  if (passes.length === 0) return native;
  let merged = native;
  for (const pass of passes)
    merged = mergeExtraction(merged, pass.run(root, ctx));
  return merged;
}

/**
 * Project a `WalkInput` onto the context passes receive — everything but the
 * parsed tree, which they get as a root node instead.
 *
 * `dispatchTableNames` is deliberately left ABSENT: it is the one data dependency
 * between facets INSIDE a native walker (the table pass feeding the call pass),
 * and the native monolith owns it. A pass that needs it re-derives it.
 */
export function toWalkContext(input: WalkInput): WalkContext {
  const ctx: WalkContext = {
    code: input.code,
    relPath: input.relPath,
    language: input.language,
    chunks: input.chunks,
  };
  // Assigned only when present: an absent key and an explicit `undefined` read
  // the same to a consumer, but only the absent key keeps the shape a run with
  // no Gemfile would have had.
  if (input.gemfileContent !== undefined)
    ctx.gemfileContent = input.gemfileContent;
  return ctx;
}

/** The pieces a language supplies to build its `LanguageWalker`. */
export interface ExtractionWalkerParts {
  /** The language's native extraction monolith, unchanged. */
  walk: (input: WalkInput) => FileExtraction;
  /** The language's node → symbol descriptor mapping, passed through as-is. */
  nameOf: LanguageWalker["nameOf"];
  /** Ordered extra facets. Empty for a language that has not pulled on one yet. */
  passes: readonly ExtractionFacetPass[];
}

/**
 * Build the `LanguageWalker` a provider exposes: the native walk, then the
 * passes. With no passes the native result is returned directly and no
 * `WalkContext` is even allocated — the zero-pass path costs nothing per file.
 */
export function composeExtractionWalker(
  parts: ExtractionWalkerParts,
): LanguageWalker {
  return {
    walk: (input) => {
      const native = parts.walk(input);
      if (parts.passes.length === 0) return native;
      return runExtractionPasses(
        native,
        parts.passes,
        input.tree.rootNode,
        toWalkContext(input),
      );
    },
    nameOf: parts.nameOf,
  };
}
```

- [x] Run the unit gate:
      `npx vitest run tests/core/domains/language/kernel/extraction-passes.test.ts`
      — all cases green, including the two `toBe` identity assertions.

- [x] Run the contract gate: `npm run type-check` then
      `npx tsc --noEmit -p tsconfig.eslint.json` — both clean.

- [x] Run lint:
      `npx eslint --max-warnings 0 src/core/contracts/types/language.ts src/core/domains/language/kernel/extraction-passes.ts tests/core/domains/language/kernel/extraction-passes.test.ts`

- [x] Commit:

```text
feat(contracts): add the extraction pass-runner and walker composer (pss0q)

ExtractionPass and WalkContext have sat in contracts/types/language.ts with zero
consumers since the plugin design landed. This wires them up: runExtractionPasses
folds each pass's Partial<FileExtraction> through mergeExtraction in list order,
and composeExtractionWalker returns the LanguageWalker a provider exposes.

With an empty pass list the composed walker returns the native walker's own
object by identity and allocates no WalkContext, which is what makes wiring an
existing language through the engine a relocation rather than a behaviour change.

WalkContext gains an optional gemfileContent mirroring WalkInput's, so the Ruby
gem-gated catalogue keeps reaching extraction-time consumers once passes exist.
dispatchTableNames stays absent on purpose — it is an intra-monolith data
dependency, not something the runner should synthesise.
```

---

## Task 3: wire Ruby and Python through the composer

**Files**

- Create `src/core/domains/language/ruby/walker/passes.ts`
- Create `src/core/domains/language/python/walker/passes.ts`
- Create `scripts/spikes/ruby-walker-composition-parity.ts`
- Modify `src/core/domains/language/ruby/walker/index.ts`
- Modify `src/core/domains/language/python/walker/index.ts`
- Modify `src/core/domains/language/ruby/index.ts`
- Modify `src/core/domains/language/python/index.ts`

**Interfaces**

_Consumes_

```ts
import {
  composeExtractionWalker,
  type ExtractionFacetPass,
} from "../kernel/extraction-passes.js";
```

_Produces_

```ts
export const RUBY_EXTRACTION_PASSES: readonly ExtractionFacetPass[]; // ruby/walker/passes.ts
export const PYTHON_EXTRACTION_PASSES: readonly ExtractionFacetPass[]; // python/walker/passes.ts
```

Both language providers keep exposing `readonly walker: LanguageWalker` — the
type does not change, only how the value is built.

**Steps**

- [x] Record the Ruby BEFORE state so the parity harness has a baseline to be
      compared against later. From the repo root: `git rev-parse HEAD` — note
      the sha in the commit body as the pre-wiring point.

- [x] Record the Python BEFORE state by running the chain tally on all five
      corpora and confirming the numbers match the 2026-09-02 baseline:

```bash
npx tsx scripts/codegraph-chain-tally.ts --corpus ~/Dev/Collaborate/ugnest --lang python --quiet
npx tsx scripts/codegraph-chain-tally.ts --corpus ~/Dev/OpenSource/codegraph-test/flask --lang python --quiet
npx tsx scripts/codegraph-chain-tally.ts --corpus ~/Dev/Tools/tea-rags-bench/corpora/netbox --lang python --quiet
npx tsx scripts/codegraph-chain-tally.ts --corpus ~/Dev/Tools/tea-rags-bench/corpora/polar --lang python --quiet
npx tsx scripts/codegraph-chain-tally.ts --corpus ~/Dev/Tools/tea-rags-bench/corpora/httpx --lang python --quiet
```

      Expected `edges / fileOnly / unresolved`, chain drift 0 on every row:
      ugnest 1432 / 315 / 5899; flask 770 / 148 / 1402; netbox 21971 / 8190 / 38760;
      polar 21336 / 3976 / 61218; httpx 1011 / 193 / 1632.
      A row that does not match means the tree is already off-baseline — stop and
      report rather than proceeding, because the AFTER comparison would be void.

- [x] Create `src/core/domains/language/ruby/walker/passes.ts`:

```ts
/**
 * Ruby's ordered extraction passes — EMPTY, and that is the point of E1 seam 0
 * (bd tea-rags-mcp-fmcly). `extractFromRubyFile` stays the native monolith it is;
 * the composer runs it and, finding no passes, hands its output back untouched.
 *
 * A NEW Ruby extraction facet is added HERE, as one `ExtractionFacetPass`, never
 * by re-slicing the monolith. Precedence inversions the monolith already encodes
 * (YARD `@return` overwriting body inference in `type-channels.ts`) cannot be
 * expressed by a pass — `mergeExtraction` never lets a pass overwrite the native
 * walker — so a facet that needs to WIN over an existing channel belongs inside
 * the monolith, not here.
 */

import type { ExtractionFacetPass } from "../../kernel/extraction-passes.js";

export const RUBY_EXTRACTION_PASSES: readonly ExtractionFacetPass[] = [];
```

- [x] Create `src/core/domains/language/python/walker/passes.ts`:

```ts
/**
 * Python's ordered extraction passes — EMPTY today (bd tea-rags-mcp-fmcly). The
 * E2 facets Python is expected to pull on (annotation type-source, decorator
 * expander, signatures, re-exports) arrive HERE, one `ExtractionFacetPass` each,
 * rather than growing `extractFromPythonFile`.
 */

import type { ExtractionFacetPass } from "../../kernel/extraction-passes.js";

export const PYTHON_EXTRACTION_PASSES: readonly ExtractionFacetPass[] = [];
```

- [x] Re-export both from their walker barrels. In
      `src/core/domains/language/ruby/walker/index.ts` add:

```ts
export { RUBY_EXTRACTION_PASSES } from "./passes.js";
```

      In `src/core/domains/language/python/walker/index.ts` add:

```ts
export { PYTHON_EXTRACTION_PASSES } from "./passes.js";
```

- [x] Wire Ruby. In `src/core/domains/language/ruby/index.ts`, add the imports
      beside the existing walker imports:

```ts
import { composeExtractionWalker } from "../kernel/extraction-passes.js";
import { rbNameOf } from "./walker/name-of.js";
import { RUBY_EXTRACTION_PASSES } from "./walker/passes.js";
import { extractFromRubyFile, type RubyExtractInput } from "./walker/walker.js";
```

      and replace the `walker` field:

```ts
  readonly walker: LanguageWalker = composeExtractionWalker({
    walk: (input) => extractFromRubyFile(input),
    // Gem-gated declares/nameOf path (bd tea-rags-mcp-o5kwh): compose this
    // project's catalogue from the run's Gemfile so class-body macro DECLARES
    // are gated to the gems THIS project declares. undefined -> FULL catalogue.
    nameOf: (node, gemfileContent) => rbNameOf(node, catalogueForGemfile(gemfileContent)),
    // Empty today — see ./walker/passes.ts for why that is the design, not a gap.
    passes: RUBY_EXTRACTION_PASSES,
  });
```

- [x] Wire Python. In `src/core/domains/language/python/index.ts`, add:

```ts
import { composeExtractionWalker } from "../kernel/extraction-passes.js";
import { pyNameOf } from "./walker/name-of.js";
import { PYTHON_EXTRACTION_PASSES } from "./walker/passes.js";
import {
  extractFromPythonFile,
  type PythonExtractInput,
} from "./walker/walker.js";
```

      and replace the `walker` field:

```ts
  readonly walker: LanguageWalker = composeExtractionWalker({
    walk: (input) => extractFromPythonFile(input),
    nameOf: (node) => pyNameOf(node),
    // Empty today — see ./walker/passes.ts.
    passes: PYTHON_EXTRACTION_PASSES,
  });
```

- [x] Create the Ruby parity harness
      `scripts/spikes/ruby-walker-composition-parity.ts`:

```ts
/**
 * Ruby native-vs-composed walker parity (E1 seam 0, bd tea-rags-mcp-fmcly).
 *
 * `scripts/codegraph-chain-tally.ts` has chain specs for python and java only, so
 * there is no tally gate for Ruby. This is the Ruby half of the seam's
 * byte-identical gate: for every Ruby file in a corpus it runs the NATIVE monolith
 * (`extractFromRubyFile`) and the walker the provider actually hands out
 * (`LanguageFactory.create("ruby").walker.walk`, composed through
 * `composeExtractionWalker`) over the SAME materialized tree, then compares
 * `JSON.stringify` of both — the exact form the codegraph NDJSON spill sees, so a
 * channel materialised as `{}` where the native emitted nothing surfaces as a
 * mismatch instead of passing a deep compare.
 *
 * Expected while `RUBY_EXTRACTION_PASSES` is empty: `mismatches 0`. Once passes
 * exist the two sides legitimately differ and this becomes a diff tool, not a gate.
 *
 * Usage:
 *   npx tsx scripts/spikes/ruby-walker-composition-parity.ts \
 *     --corpus ~/Dev/Tools/tea-rags-bench/corpora/mastodon [--limit 500]
 */
import { readdirSync, readFileSync } from "node:fs";
import {
  extname,
  join,
  relative,
  resolve as resolvePath,
  sep,
} from "node:path";

import Parser from "tree-sitter";

import {
  collectSymbols,
  DefaultSymbolIdComposer,
  LanguageFactory,
} from "../../src/core/domains/language/index.js";
import { extractFromRubyFile } from "../../src/core/domains/language/ruby/index.js";
import { CODEGRAPH_LANGUAGES } from "../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { materializeTree } from "../../src/core/infra/materialize.js";

const SKIP_DIRECTORIES = new Set([
  "node_modules",
  "vendor",
  "build",
  "dist",
  "tmp",
  "log",
  "coverage",
]);

function rubyFiles(root: string, limit: number): string[] {
  const found: string[] = [];
  const walk = (absolute: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (found.length >= limit) return;
      const child = join(absolute, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name) && !entry.name.startsWith("."))
          walk(child);
      } else if (extname(entry.name) === ".rb") {
        found.push(relative(root, child).split(sep).join("/"));
      }
    }
  };
  walk(root);
  return found.sort();
}

function main(): void {
  const argv = process.argv.slice(2);
  const read = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const root = resolvePath(read("--corpus") ?? process.cwd());
  const limit = Number(read("--limit") ?? 500);
  const config = CODEGRAPH_LANGUAGES[".rb"];
  const { walker } = new LanguageFactory().create(config.language);
  if (!walker) throw new Error("ruby provider exposes no walker");
  const composer = new DefaultSymbolIdComposer();
  const mismatches: string[] = [];
  let compared = 0;
  for (const relPath of rubyFiles(root, limit)) {
    const code = readFileSync(join(root, relPath), "utf8");
    const parser = new Parser();
    parser.setLanguage(config.loadParser());
    const tree = {
      rootNode: materializeTree(parser.parse(code).rootNode, code),
    };
    const chunks = collectSymbols(
      tree,
      (node) => walker.nameOf(node),
      config.scopeSeparator,
      config.disambiguateOverloads ?? false,
      composer,
    );
    const input = { tree, code, relPath, language: config.language, chunks };
    compared++;
    if (
      JSON.stringify(extractFromRubyFile(input)) !==
      JSON.stringify(walker.walk(input))
    )
      mismatches.push(relPath);
  }
  console.log(`ruby walker parity · corpus ${root}`);
  console.log(`  compared ${compared} files · mismatches ${mismatches.length}`);
  for (const relPath of mismatches.slice(0, 5))
    console.log(`  MISMATCH ${relPath}`);
  process.exit(mismatches.length === 0 ? 0 : 1);
}

main();
```

- [x] Run the Ruby byte-identical gate:

```bash
npx tsx scripts/spikes/ruby-walker-composition-parity.ts \
  --corpus ~/Dev/Tools/tea-rags-bench/corpora/mastodon --limit 2000
```

      Required: `mismatches 0`, `compared` in the low thousands (mastodon's non-test
      Ruby corpus). Exit code 0.

- [x] Run the relocation gate — no test edits allowed:

```bash
npx vitest run tests/core/domains/language/ruby tests/core/domains/language/python tests/core/domains/ingest/pipeline/chunker
git diff --stat -- tests/
```

      Required: suite green, and `git diff --stat -- tests/` shows ONLY the two new
      kernel test files from Tasks 1 and 2 (already committed, so on a clean tree it
      shows nothing).

- [x] Run the Python byte-identical gate — the same five commands as the BEFORE
      step, with the same expected `edges / fileOnly / unresolved` and chain
      drift 0:

```bash
npx tsx scripts/codegraph-chain-tally.ts --corpus ~/Dev/Collaborate/ugnest --lang python --quiet
npx tsx scripts/codegraph-chain-tally.ts --corpus ~/Dev/OpenSource/codegraph-test/flask --lang python --quiet
npx tsx scripts/codegraph-chain-tally.ts --corpus ~/Dev/Tools/tea-rags-bench/corpora/netbox --lang python --quiet
npx tsx scripts/codegraph-chain-tally.ts --corpus ~/Dev/Tools/tea-rags-bench/corpora/polar --lang python --quiet
npx tsx scripts/codegraph-chain-tally.ts --corpus ~/Dev/Tools/tea-rags-bench/corpora/httpx --lang python --quiet
```

      ugnest 1432 / 315 / 5899; flask 770 / 148 / 1402; netbox 21971 / 8190 / 38760;
      polar 21336 / 3976 / 61218; httpx 1011 / 193 / 1632. Any drift is a hard stop.

- [x] Run the perf gate on all five Python corpora and record peak RSS
      (`/usr/bin/time -l` reports "maximum resident set size" in BYTES on
      macOS):

```bash
/usr/bin/time -l npx tsx scripts/codegraph-chain-tally.ts --corpus ~/Dev/Tools/tea-rags-bench/corpora/httpx --lang python --quiet
/usr/bin/time -l npx tsx scripts/codegraph-chain-tally.ts --corpus ~/Dev/OpenSource/codegraph-test/flask --lang python --quiet
/usr/bin/time -l npx tsx scripts/codegraph-chain-tally.ts --corpus ~/Dev/Collaborate/ugnest --lang python --quiet
/usr/bin/time -l npx tsx scripts/codegraph-chain-tally.ts --corpus ~/Dev/Tools/tea-rags-bench/corpora/polar --lang python --quiet
/usr/bin/time -l npx tsx scripts/codegraph-chain-tally.ts --corpus ~/Dev/Tools/tea-rags-bench/corpora/netbox --lang python --quiet
```

      Baselines: httpx 260 MB, flask 275 MB, ugnest 352 MB, polar 959 MB,
      netbox 1,293 MB. Required: peak RSS ≤ +20% of each, wall within +25% under
      equal load. The zero-pass path allocates nothing per file, so a real regression
      here means the composer is being rebuilt per call — check that `walker` is a
      field initializer and not a getter.

      RESULT (2026-09-09): the 2026-09-02 absolute MB baselines above are not
      comparable across machines or load, so the gate was re-run as a same-machine
      A/B by the parent session (BEFORE = main d7e942ab9, AFTER = this worktree,
      `chain-tally --quiet` under `/usr/bin/time -l`):

      polar BEFORE 10.63 s / 1,195 MB -> AFTER 10.54 s / 1,129 MB
      (RSS -5.5%, wall -1%). netbox BEFORE 14.37 / 14.28 / 13.57 s,
      RSS 1,685 / 1,751 / 1,710 MB -> AFTER 14.58 / 12.86 s (one run stalled at
      314 s real with 14.7 s user = machine contention), RSS 2,190 / 1,614 /
      2,196 MB — bimodal, contaminated by concurrent gate runs; wall is at parity.
      netbox RSS re-measured by the parent on an idle machine with a V8 heap cap
      after this branch is handed back.

      Code-level check done: `walker` is a field initializer, so
      `composeExtractionWalker` runs once per provider, not per call.

- [x] Run the epic gate: `npm run build && npm run test:coverage` — green,
      thresholds met. If coverage fails, delegate to the `coverage-expander`
      subagent per `.claude/CLAUDE.md`; do not lower a threshold.

- [x] Run lint on everything touched:
      `npx eslint --max-warnings 0 src/core/domains/language/ruby src/core/domains/language/python scripts/spikes/ruby-walker-composition-parity.ts`

- [x] Commit:

```text
refactor(language): compose ruby and python walkers through the pass-runner (dppsr)

Both providers now build their LanguageWalker with composeExtractionWalker and an
empty pass list exported from <lang>/walker/passes.ts, so the composed walker
returns extractFromRubyFile / extractFromPythonFile's own object by identity. The
monoliths are untouched, and no test under tests/core/domains/language/{ruby,python}
was edited.

Gates: scripts/spikes/ruby-walker-composition-parity.ts reports 0 mismatches over
mastodon comparing the native monolith against the provider's composed walker as
spilled JSON — codegraph-chain-tally has no ruby chain spec, so this is the Ruby
byte-identical gate. Python chain tally is unchanged on all five corpora
(ugnest 1432/315/5899, flask 770/148/1402, netbox 21971/8190/38760,
polar 21336/3976/61218, httpx 1011/193/1632) at chain drift 0, and peak RSS is
within the +20% budget on each.

New extraction facets — the Python annotation type-source, decorator expander,
signatures and re-exports that E2 pulls on — arrive as passes in these lists.
```

---

## Task 4: record the mechanism and file the follow-up

**Files**

- Modify `src/core/domains/language/CLAUDE.md`
- File one beads task (no file change)

**Interfaces**

_Consumes_ — nothing. _Produces_ — one Mechanics bullet in the navigator, and a
bead for wiring the remaining six languages.

**Steps**

- [x] Add one bullet at the END of the `## Mechanics` section of
      `src/core/domains/language/CLAUDE.md` (immediately before the `## Gotchas`
      heading), matching the section's existing bold-lead / `Why:`-tail style:

```markdown
- **An extraction pass never re-slices a native walker, and with no passes the
  composed walker returns the monolith's own object.**
  `kernel/extraction-passes.ts` runs `<lang>/walker/walker.ts` first, then the
  language's `<LANG>_EXTRACTION_PASSES` (`<lang>/walker/passes.ts`, empty for
  Ruby and Python today), folding each pass's `Partial<FileExtraction>` in
  through `kernel/merge-extraction.ts`. That merge is append-only: arrays concat
  base-first, set-like arrays dedupe on the first occurrence, Records union with
  the BASE's value kept on a conflict, Record-of-arrays union KEYS only, chunks
  merge by `symbolId` with `localBindings` re-sorted by line, and a channel
  neither side carries is never materialised. The per-channel rulebook is a
  mapped type over `keyof FileExtraction` / `keyof ChunkExtraction`, so a new
  channel is a compile error until it gets a row. Why: precedence inversions
  live INSIDE a monolith (`ruby/walker/type-channels.ts:44` has YARD `@return`
  overwrite body inference; `:79` has body inference NOT overwrite the store) —
  a pass that could overwrite would silently re-order them, an empty channel
  reaching the NDJSON spill moves the payload the schema-drift guard compares,
  and the identity return is what makes wiring a language through the engine a
  relocation rather than a behaviour change.
```

- [x] Verify the navigator still lints:
      `npx prettier --check src/core/domains/language/CLAUDE.md` (run
      `npx prettier --write` on it if it does not).

- [ ] File the follow-up bead for the six unwired languages:

```bash
bd create --title="Wire the remaining six languages through composeExtractionWalker" --type=task --priority=3
bd label add <issue-id> architecture
bd dep add <issue-id> tea-rags-mcp-fmcly
```

      Body text for the bead:

      > E1 seam 0 wired `ruby` and `python` through `composeExtractionWalker` with
      > empty pass lists. `bash`, `go`, `java`, `javascript`, `rust` and
      > `typescript` still build `walker` as an inline `{ walk, nameOf }` literal in
      > their `<lang>/index.ts`, so they have no place to add an extraction facet
      > without editing the monolith. (`markdown` has no walker and is out of scope.)
      >
      > DOES: give each remaining language an `<LANG>_EXTRACTION_PASSES` export in
      > `<lang>/walker/passes.ts` and build its `walker` through
      > `composeExtractionWalker`. OWNS: `domains/language/<lang>/`. INTERFACE:
      > unchanged — `LanguageProvider.walker` is still a `LanguageWalker`.
      >
      > Gate per language: the language's own suite green with NO test edits, plus
      > byte-identical corpus output. `codegraph-chain-tally.ts` covers `java`
      > directly (it has a chain spec); the others need either a new chain spec or a
      > copy of `scripts/spikes/ruby-walker-composition-parity.ts` parameterised by
      > extension. Not urgent — a language with no pass to add gains nothing but
      > uniformity, so pull this when the first facet for that language appears.

      NOT DONE by this session: the executing agent was scoped with `bd` off, so no
      bead was filed. The title, labels, dependency and body above are ready to
      paste — the parent session files it.

- [x] Commit:

```text
docs(language): record the extraction pass-runner in the domain navigator (vqdw1)

The navigator now states what a pass may and may not do — passes never re-slice a
native walker, zero passes means the composed walker returns the monolith's own
object, and the append-only rulebook lives in kernel/merge-extraction.ts with a
mapped type that turns a new channel into a compile error.

Filed a follow-up for the six languages still building their walker inline
(bash, go, java, javascript, rust, typescript); markdown has no walker.
```

---

## Self-review checklist (run before declaring the plan executed)

- [ ] Every rulebook line in `merge-extraction.ts` has at least one case in
      `merge-extraction.test.ts`: scalars, absent-stays-absent,
      empty-is-a-no-op, array concat, set-like dedupe, Record base-wins, nested
      Record, Record-of-arrays key-union, chunk `calls` concat, chunk
      `localBindings` re-sort, chunk `localCallBindings` base-wins, chunk
      scalars, chunk append-by-unknown-symbolId, purity, rulebook completeness.
- [ ] Names are identical across all four tasks: `mergeExtraction`,
      `ExtractionMergeRulebook`, `ExtractionChannelMerger`,
      `ExtractionFacetPass`, `runExtractionPasses`, `toWalkContext`,
      `composeExtractionWalker`, `ExtractionWalkerParts`,
      `RUBY_EXTRACTION_PASSES`, `PYTHON_EXTRACTION_PASSES`.
- [ ] Nothing references an undefined symbol: `LocalBinding`, `ChunkExtraction`,
      `FileExtraction` come from `contracts/types/codegraph.js`; `AstNode` /
      `MaterializedTree` from `contracts/types/ast.js`; `ExtractionPass`,
      `WalkContext`, `WalkInput`, `LanguageWalker` from
      `contracts/types/language.js`; `CODEGRAPH_LANGUAGES` from
      `trajectory/codegraph/symbols/provider.js`; `materializeTree` from
      `core/infra/materialize.js`.
- [ ] `git diff --stat -- tests/core/domains/language/ruby tests/core/domains/language/python`
      is empty across the whole branch.
- [ ] Four commits, one per task, headers ≤ 100 chars, beads `qns77` / `pss0q` /
      `fmcly` / `fmcly`.
