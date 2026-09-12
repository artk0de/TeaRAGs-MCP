/**
 * The seam itself (E2 seam 2, bd tea-rags-mcp-9fgdi): real Python, parsed by the
 * project's engine, run through `PythonLanguage`'s COMPOSED walker so the pass
 * actually runs and `mergeExtraction` actually folds. Calling
 * `extractFromPythonFile` directly here would test the monolith and nothing else.
 *
 * What is pinned is the MERGED extraction — the walker's constructor inference
 * and the pass's annotation facts coexisting on one channel, in line order.
 */
import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import type { FileExtraction } from "../../../../../../../src/core/contracts/types/codegraph.js";
import { TypeFactStore } from "../../../../../../../src/core/domains/language/kernel/type-fact-store.js";
import type { TypeFact } from "../../../../../../../src/core/domains/language/kernel/type-facts.js";
import { PythonLanguage } from "../../../../../../../src/core/domains/language/python/index.js";
import { PYTHON_TYPE_SOURCE_ORDER } from "../../../../../../../src/core/domains/language/python/walker/passes/annotation-type-facts.js";

const SOURCE = [
  "from svc import Session, Repo",
  "",
  "class Service:",
  "    repo: Repo",
  "",
  "    def __init__(self, session: Optional[Session]) -> None:",
  "        self.session: Optional[Session] = session",
  "",
  '    def run(self, target: "Repo") -> Session:',
  "        target = Repo()",
  "        return target.open()",
  "",
].join("\n");

const CHUNKS = [
  { symbolId: "Service", startLine: 3, endLine: 11, scope: [] },
  { symbolId: "Service#__init__", startLine: 6, endLine: 7, scope: ["Service"] },
  { symbolId: "Service#run", startLine: 9, endLine: 11, scope: ["Service"] },
];

function extract(): FileExtraction {
  const parser = new Parser();
  parser.setLanguage(PyLang as unknown as Parser.Language);
  return new PythonLanguage().walker.walk({
    tree: parser.parse(SOURCE),
    code: SOURCE,
    relPath: "pkg/service.py",
    language: "python",
    chunks: CHUNKS,
  });
}

function chunkOf(extraction: FileExtraction, symbolId: string) {
  return extraction.chunks.find((c) => c.symbolId === symbolId);
}

describe("pythonAnnotationTypeFacetPass — merged into the composed walker", () => {
  it("fills classFieldTypes from the class body AND the annotated self assignment", () => {
    // Neither reaches the monolith: `collectPythonClassFieldTypes` wants a
    // `self.` LHS (so the class-body `repo: Repo` is invisible) and
    // `extractTypeName` returns null for `Optional[...]`.
    expect(extract().classFieldTypes?.["Service"]).toEqual({ repo: "Repo", session: "Session" });
  });

  it("keys the return annotation by the callee's symbolId and files nothing for `-> None`", () => {
    const returns = extract().structuredReturnTypes ?? {};
    expect(returns["Service#run"]).toEqual({ form: "instance", name: "Session" });
    expect(Object.keys(returns)).toEqual(["Service#run"]);
  });

  it("publishes neither of the two channels Python drops or re-keys", () => {
    const extraction = extract();
    expect(extraction.functionReturnTypes).toBeUndefined();
    expect(extraction.ivarTypes).toBeUndefined();
  });

  it("keeps both bindings for one variable, line-sorted, pass then monolith", () => {
    // The pass binds `target` at the `def` line from the `"Repo"` forward ref;
    // the monolith binds it again at the reassignment. `resolveLocalBindingType`
    // reads the greatest line <= the call, so the reassignment supersedes the
    // parameter annotation below line 10 — Python's actual semantics.
    // The monolith's entry carries the statement span it establishes (bd
    // tea-rags-mcp-w205u); the pass's parameter-annotation entry carries none.
    expect(chunkOf(extract(), "Service#run")?.localBindings?.["target"]).toEqual([
      { line: 9, type: "Repo" },
      { line: 10, type: "Repo", endLine: 10 },
    ]);
  });

  it("carries the union on the binding the monolith drops entirely", () => {
    const session = chunkOf(extract(), "Service#__init__")?.localBindings?.["session"];
    expect(session).toEqual([
      {
        line: 6,
        type: "Session",
        typeRef: { form: "union", members: [{ form: "instance", name: "Session" }, { form: "nil" }] },
      },
    ]);
  });
});

describe("PYTHON_TYPE_SOURCE_ORDER — the rank the two disjoint sources cannot exercise", () => {
  const coordinate = {
    kind: "param",
    symbolScope: ["Service"],
    methodName: "run",
    name: "target",
    line: 9,
  } as const;
  const annotated: TypeFact = { ...coordinate, source: "annotations", type: { form: "instance", name: "Repo" } };
  const documented: TypeFact = { ...coordinate, source: "docstring", type: { form: "instance", name: "Wrong" } };

  it("lets the annotation outrank the docstring at one coordinate", () => {
    const store = TypeFactStore.fromFacts([annotated, documented], PYTHON_TYPE_SOURCE_ORDER);
    expect(store.localBindingsForChunk(9, 11)["target"]).toEqual([{ line: 9, type: "Repo" }]);
  });

  it("resolves the same way whichever order the facts arrived in", () => {
    const store = TypeFactStore.fromFacts([documented, annotated], PYTHON_TYPE_SOURCE_ORDER);
    expect(store.localBindingsForChunk(9, 11)["target"]).toEqual([{ line: 9, type: "Repo" }]);
  });

  it("ranks annotations over docstring over the walker's own inference", () => {
    expect(PYTHON_TYPE_SOURCE_ORDER).toEqual(["annotations", "docstring", "ast"]);
  });
});
