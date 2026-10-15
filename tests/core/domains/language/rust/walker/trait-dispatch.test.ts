import Parser from "tree-sitter";
import RustLang from "tree-sitter-rust";
import { describe, expect, it } from "vitest";

import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { materializeTree } from "../../../../../../src/core/domains/ingest/pipeline/chunker/materialize.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { RustLanguage } from "../../../../../../src/core/domains/language/rust/index.js";

function extract(src: string): FileExtraction {
  const language = new RustLanguage();
  const parser = new Parser();
  parser.setLanguage(RustLang);
  const rootNode = materializeTree(parser.parse(src).rootNode, src);
  const tree = { rootNode };
  const chunks = collectSymbols(
    tree,
    (node) => language.walker.nameOf(node),
    language.kernel.scopeSeparator ?? ".",
    language.kernel.disambiguateOverloads ?? false,
    new DefaultSymbolIdComposer(),
  );
  return language.walker.walk({ tree, code: src, relPath: "src/worker.rs", language: "rust", chunks });
}

describe("Rust walker — trait and impl dispatch facts", () => {
  it("publishes trait declarations, implementing methods, associated methods, and impl edges", () => {
    const extraction = extract(
      [
        "trait Runner {",
        "    fn run(&self);",
        "    fn make() -> Self;",
        "}",
        "struct Worker;",
        "impl Runner for Worker {",
        "    fn run(&self) {}",
        "    fn make() -> Self { Worker }",
        "}",
      ].join("\n"),
    );

    expect(extraction.typeDeclarations).toContainEqual({
      typeId: "Runner",
      symbolKind: "interface",
      line: 1,
      reopens: false,
    });
    expect(extraction.chunks.map(({ symbolId, symbolKind }) => [symbolId, symbolKind])).toEqual(
      expect.arrayContaining([
        ["Runner", "interface"],
        ["Worker", "class"],
        ["Worker#run", "method"],
        ["Worker.make", "method"],
      ]),
    );
    expect(extraction.inheritanceEdges).toEqual([
      { source: "Worker", ancestor: "Runner", kind: "implements", ordinal: 0 },
    ]);
  });

  it("captures qualified, trait-object, and unqualified calls without inventing an impl edge", () => {
    const extraction = extract(
      [
        "trait Runner { fn run(&self); }",
        "struct Worker;",
        "impl Runner for Worker { fn run(&self) {} }",
        "fn invoke(r: &dyn Runner, worker: Worker) {",
        "    r.run();",
        "    <Worker as Runner>::run(&worker);",
        "    run();",
        "}",
      ].join("\n"),
    );

    const invoke = extraction.chunks.find(({ symbolId }) => symbolId === "invoke");
    expect(invoke?.calls).toEqual([
      { callText: "r.run()", receiver: "r", member: "run", startLine: 5 },
      {
        callText: "<Worker as Runner>::run(&worker)",
        receiver: "<Worker as Runner>",
        member: "run",
        startLine: 6,
      },
      { callText: "run()", receiver: null, member: "run", startLine: 7 },
    ]);
    expect(extraction.inheritanceEdges).toEqual([
      { source: "Worker", ancestor: "Runner", kind: "implements", ordinal: 0 },
    ]);
  });

  it("keeps an external trait as an unresolved constraint while preserving the local impl method", () => {
    const extraction = extract(
      [
        "struct Worker;",
        "impl std::fmt::Display for Worker {",
        "    fn fmt(&self, f: &mut Formatter) -> Result { todo!() }",
        "}",
      ].join("\n"),
    );

    expect(extraction.chunks.map(({ symbolId }) => symbolId)).toContain("Worker#fmt");
    expect(extraction.inheritanceEdges).toEqual([
      { source: "Worker", ancestor: "Display", kind: "implements", ordinal: 0 },
    ]);
  });

  it("does not treat an inherent impl as a trait implementation", () => {
    const extraction = extract(["struct Worker;", "impl Worker {", "    fn run(&self) {}", "}"].join("\n"));

    expect(extraction.inheritanceEdges).toBeUndefined();
    expect(extraction.chunks.map(({ symbolId }) => symbolId)).toContain("Worker#run");
  });
});
