import { describe, expect, it } from "vitest";

import type { FileExtraction } from "../../../../../src/core/contracts/types/codegraph.js";
import type { WalkContext } from "../../../../../src/core/contracts/types/language.js";
import { mergeExtraction } from "../../../../../src/core/domains/language/kernel/merge-extraction.js";
import { typeFactChannels } from "../../../../../src/core/domains/language/kernel/type-fact-channels.js";
import { TypeFactStore } from "../../../../../src/core/domains/language/kernel/type-fact-store.js";
import type { TypeFact } from "../../../../../src/core/domains/language/kernel/type-facts.js";

const ORDER = ["annotations", "ast"] as const;

const CHUNKS: WalkContext["chunks"] = [
  { symbolId: "app.svc#run", startLine: 1, endLine: 10, scope: ["Svc"] },
  { symbolId: "app.svc#idle", startLine: 11, endLine: 20, scope: ["Svc"] },
];

function paramFact(line: number, name: string, type: string): TypeFact {
  return {
    kind: "param",
    source: "annotations",
    symbolScope: ["Svc"],
    methodName: "run",
    name,
    line,
    type: { form: "instance", name: type },
  };
}

describe("typeFactChannels", () => {
  it("emits nothing at all for an empty store", () => {
    const out = typeFactChannels(TypeFactStore.fromFacts([], ORDER), CHUNKS);
    expect(Object.keys(out)).toEqual([]);
  });

  it("emits only the channels the facts actually populate", () => {
    const out = typeFactChannels(TypeFactStore.fromFacts([paramFact(4, "req", "Request")], ORDER), CHUNKS);
    expect(Object.keys(out).sort()).toEqual(["chunks"]);
    expect(out.chunks).toEqual([
      {
        symbolId: "app.svc#run",
        scope: ["Svc"],
        startLine: 1,
        endLine: 10,
        calls: [],
        localBindings: { req: [{ line: 4, type: "Request" }] },
      },
    ]);
  });

  it("skips a chunk whose line range holds no binding", () => {
    const out = typeFactChannels(TypeFactStore.fromFacts([paramFact(4, "req", "Request")], ORDER), CHUNKS);
    expect(out.chunks?.map((c) => c.symbolId)).toEqual(["app.svc#run"]);
  });

  it("keeps each variable's bindings sorted by line", () => {
    const store = TypeFactStore.fromFacts([paramFact(8, "v", "Late"), paramFact(2, "v", "Early")], ORDER);
    expect(typeFactChannels(store, CHUNKS).chunks?.[0]?.localBindings?.["v"]?.map((b) => b.line)).toEqual([2, 8]);
  });

  it("emits the three file-level channels from return and ivar facts", () => {
    const facts: TypeFact[] = [
      {
        kind: "return",
        source: "annotations",
        symbolScope: ["Svc"],
        methodName: "run",
        type: { form: "instance", name: "Result" },
      },
      {
        kind: "ivar",
        source: "annotations",
        symbolScope: ["Svc"],
        name: "@repo",
        type: { form: "instance", name: "Repo" },
      },
    ];
    const out = typeFactChannels(TypeFactStore.fromFacts(facts, ORDER), CHUNKS);
    expect(Object.keys(out).sort()).toEqual(["functionReturnTypes", "ivarTypes", "structuredReturnTypes"]);
    expect(out.functionReturnTypes).toEqual({ run: "Result" });
    expect(out.structuredReturnTypes).toEqual({ "Svc#run": { form: "instance", name: "Result" } });
    expect(out.ivarTypes).toEqual({ Svc: { "@repo": "Repo" } });
  });

  it("leaves a base extraction's absent channels absent when merged", () => {
    const base: FileExtraction = {
      relPath: "app/svc.py",
      language: "python",
      imports: [],
      fileScope: [],
      chunks: [{ symbolId: "app.svc#run", scope: ["Svc"], calls: [] }],
    };
    const merged = mergeExtraction(base, typeFactChannels(TypeFactStore.fromFacts([], ORDER), CHUNKS));
    expect("functionReturnTypes" in merged).toBe(false);
    expect("ivarTypes" in merged).toBe(false);
    expect(merged.chunks).toEqual(base.chunks);
  });

  it("merges into the chunk the walker already emitted, matched by symbolId", () => {
    const base: FileExtraction = {
      relPath: "app/svc.py",
      language: "python",
      imports: [],
      fileScope: [],
      chunks: [{ symbolId: "app.svc#run", scope: ["Svc"], calls: [] }],
    };
    const store = TypeFactStore.fromFacts([paramFact(4, "req", "Request")], ORDER);
    const merged = mergeExtraction(base, typeFactChannels(store, CHUNKS));
    expect(merged.chunks).toHaveLength(1);
    expect(merged.chunks[0]?.localBindings).toEqual({ req: [{ line: 4, type: "Request" }] });
  });
});
