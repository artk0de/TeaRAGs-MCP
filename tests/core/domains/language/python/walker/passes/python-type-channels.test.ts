/**
 * Python's channel adapter over the kernel projection (E2 seam 2, bd
 * tea-rags-mcp-9fgdi). Stores are built from hand-written facts — the mapping
 * from source syntax to facts is Task 1–3's business; what is pinned here is
 * which `FileExtraction` channel each answer lands on and under what key.
 */
import { describe, expect, it } from "vitest";

import type { WalkContext } from "../../../../../../../src/core/contracts/types/language.js";
import { TypeFactStore } from "../../../../../../../src/core/domains/language/kernel/type-fact-store.js";
import type { TypeFact } from "../../../../../../../src/core/domains/language/kernel/type-facts.js";
import {
  pythonStructuredReturnKey,
  pythonTypeChannels,
} from "../../../../../../../src/core/domains/language/python/walker/passes/python-type-channels.js";

const ORDER = ["annotations", "docstring", "ast"] as const;

const CHUNKS: WalkContext["chunks"] = [{ symbolId: "Svc#run", startLine: 1, endLine: 10, scope: ["Svc"] }];

/** The file every channel is keyed against — the run-global field address needs one. */
const RELPATH = "pkg/svc.py";

function returnFact(symbolScope: string[], methodName: string, classForm?: boolean): TypeFact {
  const fact: TypeFact = {
    kind: "return",
    source: "annotations",
    symbolScope,
    methodName,
    type: { form: "instance", name: "Session" },
  };
  if (classForm === true) fact.classForm = true;
  return fact;
}

function ivarFact(symbolScope: string[], name: string, type: string): TypeFact {
  return {
    kind: "ivar",
    source: "annotations",
    symbolScope,
    name,
    line: 3,
    type: { form: "instance", name: type },
  };
}

function channelsOf(facts: TypeFact[]) {
  return pythonTypeChannels(TypeFactStore.fromFacts(facts, ORDER), { chunks: CHUNKS, relPath: RELPATH });
}

describe("pythonStructuredReturnKey", () => {
  // The bare-name spelling this pinned until E5.1c widened to `<relPath>::<name>`
  // — one bare `get_client` entry spoke for polar's six (bd tea-rags-mcp-1v12o.1.7).
  it("qualifies a module-level def with the file that declares it", () => {
    expect(pythonStructuredReturnKey("#run", RELPATH)).toBe("pkg/svc.py::run");
    expect(pythonStructuredReturnKey(".run", RELPATH)).toBe("pkg/svc.py::run");
  });

  it("keeps a single-class instance key as it stands", () => {
    expect(pythonStructuredReturnKey("Svc#run", RELPATH)).toBe("Svc#run");
  });

  it("rewrites the kernel's `::` scope join to Python's `.` scope separator", () => {
    expect(pythonStructuredReturnKey("Outer::Inner#run", RELPATH)).toBe("Outer.Inner#run");
    expect(pythonStructuredReturnKey("Outer::Inner.run", RELPATH)).toBe("Outer.Inner.run");
  });
});

describe("pythonTypeChannels — structuredReturnTypes", () => {
  it("keys a module-level def by the file that declares it", () => {
    expect(channelsOf([returnFact([], "run")]).structuredReturnTypes).toEqual({
      "pkg/svc.py::run": { form: "instance", name: "Session" },
    });
  });

  it("keys an instance method `Cls#method`", () => {
    expect(Object.keys(channelsOf([returnFact(["Svc"], "run")]).structuredReturnTypes ?? {})).toEqual(["Svc#run"]);
  });

  it("keys a classmethod / staticmethod `Cls.method`", () => {
    expect(Object.keys(channelsOf([returnFact(["Svc"], "run", true)]).structuredReturnTypes ?? {})).toEqual([
      "Svc.run",
    ]);
  });

  it("keys a nested class with Python's `.` scope separator", () => {
    expect(Object.keys(channelsOf([returnFact(["Outer", "Inner"], "run")]).structuredReturnTypes ?? {})).toEqual([
      "Outer.Inner#run",
    ]);
  });
});

describe("pythonTypeChannels — ivarTypes is re-keyed to classFieldTypes", () => {
  it("keys the class by its SHORT name and leaves the member bare", () => {
    const out = channelsOf([ivarFact(["Outer", "Inner"], "svc", "Svc")]);
    expect(out.classFieldTypes).toEqual({ Inner: { svc: "Svc" } });
    expect(out.ivarTypes).toBeUndefined();
    expect(Object.keys(out)).not.toContain("ivarTypes");
  });

  it("merges two same-short-named nested classes into one entry", () => {
    const out = channelsOf([ivarFact(["A", "Cfg"], "x", "X"), ivarFact(["B", "Cfg"], "y", "Y")]);
    expect(out.classFieldTypes).toEqual({ Cfg: { x: "X", y: "Y" } });
  });
});

describe("pythonTypeChannels — functionReturnTypes is dropped", () => {
  it("never keys the flat map, even when the store answers one", () => {
    const store = TypeFactStore.fromFacts([returnFact(["Svc"], "run")], ORDER);
    expect(store.returnTypeByMethod()).toEqual({ run: "Session" });
    expect(Object.keys(pythonTypeChannels(store, { chunks: CHUNKS, relPath: RELPATH }))).not.toContain(
      "functionReturnTypes",
    );
  });
});

describe("pythonTypeChannels — emit only non-empty", () => {
  it("returns no keys at all for an empty store", () => {
    expect(
      Object.keys(pythonTypeChannels(TypeFactStore.fromFacts([], ORDER), { chunks: CHUNKS, relPath: RELPATH })),
    ).toEqual([]);
  });

  it("passes the kernel's chunk records straight through", () => {
    const param: TypeFact = {
      kind: "param",
      source: "annotations",
      symbolScope: ["Svc"],
      methodName: "run",
      name: "session",
      line: 4,
      type: { form: "instance", name: "Session" },
    };
    const out = channelsOf([param]);
    expect(Object.keys(out)).toEqual(["chunks"]);
    expect(out.chunks?.[0]?.localBindings).toEqual({ session: [{ line: 4, type: "Session" }] });
  });
});
