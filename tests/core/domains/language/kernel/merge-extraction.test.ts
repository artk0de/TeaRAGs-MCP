/**
 * The append-only extraction merge (E1 seam 0, bd tea-rags-mcp-qns77). One case
 * per rulebook line in `kernel/merge-extraction.ts`, because the rulebook is the
 * contract: a channel that merges the wrong way corrupts the codegraph payload
 * silently — the spill still parses, the edges are just wrong.
 */
import { describe, expect, it } from "vitest";

import type { ChunkExtraction, FileExtraction } from "../../../../../src/core/contracts/types/codegraph.js";
import {
  mergeExtraction,
  type ExtractionMergeRulebook,
} from "../../../../../src/core/domains/language/kernel/merge-extraction.js";

function baseExtraction(overrides: Partial<FileExtraction> = {}): FileExtraction {
  return {
    relPath: "app/models/user.rb",
    language: "ruby",
    imports: [{ importText: "zeitwerk:Account", startLine: 1 }],
    chunks: [],
    fileScope: ["User"],
    ...overrides,
  };
}

function chunk(symbolId: string, overrides: Partial<ChunkExtraction> = {}): ChunkExtraction {
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
    expect(() => mergeExtraction(baseExtraction(), { relPath: "app/models/account.rb" })).toThrow(
      /relPath "app\/models\/account\.rb"/,
    );
  });

  it("throws when a pass claims a different language", () => {
    expect(() => mergeExtraction(baseExtraction(), { language: "python" })).toThrow(/language "python"/);
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
    expect(merged.imports.map((i) => i.importText)).toEqual(["zeitwerk:Account", "zeitwerk:Post"]);
    expect(merged.fileScope).toEqual(["User", "Admin::User"]);
  });

  it("concatenates inheritanceEdges and knownTargetCallArgs onto an absent base channel", () => {
    const merged = mergeExtraction(baseExtraction(), {
      inheritanceEdges: [{ source: "User", ancestor: "Base", kind: "super", ordinal: 0 }],
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
    expect(merged.chunks[0].calls.map((c) => c.member)).toEqual(["persist", "audit"]);
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
    expect(merged.chunks[0].localBindings?.firm).toEqual([{ line: 4, type: "Firm" }]);
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
    expect(merged.chunks.map((c) => c.symbolId)).toEqual(["User#save", "User#posts", "User#agents"]);
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
    expect(() =>
      // @ts-expect-error — `bogusChannel` is not a FileExtraction channel
      mergeExtraction(baseExtraction(), { bogusChannel: 1 }),
    ).not.toThrow();
  });
});
