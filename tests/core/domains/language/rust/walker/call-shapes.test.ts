import Parser from "tree-sitter";
import RustLang from "tree-sitter-rust";
import { describe, expect, it } from "vitest";

import { materializeTree } from "../../../../../../src/core/adapters/tree-sitter/materialize.js";
import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { RustLanguage } from "../../../../../../src/core/domains/language/rust/index.js";

function extract(src: string, materialized: boolean): FileExtraction {
  const language = new RustLanguage();
  const parser = new Parser();
  parser.setLanguage(RustLang);
  const parsed = parser.parse(src);
  expect(parsed.rootNode.hasError).toBe(false);
  const tree = { rootNode: materialized ? materializeTree(parsed.rootNode, src) : parsed.rootNode };
  const chunks = collectSymbols(
    tree,
    (node) => language.walker.nameOf(node),
    language.kernel.scopeSeparator ?? ".",
    language.kernel.disambiguateOverloads ?? false,
    new DefaultSymbolIdComposer(),
  );
  return language.walker.walk({ tree, code: src, relPath: "src/calls.rs", language: "rust", chunks });
}

describe.each([false, true])("Rust call shapes — materialized=%s", (materialized) => {
  it("captures turbofish over direct free, scoped, qualified and method callees", () => {
    const src = [
      "fn run(worker: Worker) {",
      "    build::<u8>();",
      "    tools::build::<u8>();",
      "    <Worker as Factory>::build::<u8>();",
      "    worker.build::<u8>();",
      "    Worker::<u8>::build();",
      "}",
    ].join("\n");
    const calls = extract(src, materialized).chunks.find(({ symbolId }) => symbolId === "run")?.calls;

    expect(
      calls?.map(({ callText, receiver, member, startLine }) => ({ callText, receiver, member, startLine })),
    ).toEqual([
      { callText: "build::<u8>()", receiver: null, member: "build", startLine: 2 },
      { callText: "tools::build::<u8>()", receiver: "tools", member: "build", startLine: 3 },
      {
        callText: "<Worker as Factory>::build::<u8>()",
        receiver: "<Worker as Factory>",
        member: "build",
        startLine: 4,
      },
      { callText: "worker.build::<u8>()", receiver: "worker", member: "build", startLine: 5 },
      { callText: "Worker::<u8>::build()", receiver: "Worker::<u8>", member: "build", startLine: 6 },
    ]);
  });

  it("locates same-line duplicate calls at expression starts in UTF-16 code units", () => {
    const line = '    let _ = "é🦀"; ping(); ping(); tools::build::<u8>(); notify!("🦀");';
    const src = ["fn run() {", line, "}"].join("\n");
    const calls = extract(src, materialized).chunks.find(({ symbolId }) => symbolId === "run")?.calls;
    const first = line.indexOf("ping()");
    const second = line.indexOf("ping()", first + 1);
    // The Node tree-sitter binding exposes UTF-16 columns, not UTF-8 bytes.
    expect(Buffer.byteLength(line.slice(0, first), "utf8")).not.toBe(first);
    expect(calls?.map(({ callText, startLine, startColumn }) => ({ callText, startLine, startColumn }))).toEqual([
      { callText: "ping()", startLine: 2, startColumn: first },
      { callText: "ping()", startLine: 2, startColumn: second },
      { callText: "tools::build::<u8>()", startLine: 2, startColumn: line.indexOf("tools::") },
      { callText: 'notify!("🦀")', startLine: 2, startColumn: line.indexOf("notify!") },
    ]);
  });

  it("leaves expression callees omitted instead of promoting namesake callable values", () => {
    const src = [
      "fn callback() {}",
      "fn run(callback: fn(), worker: Worker) {",
      "    (callback)();",
      "    (*callback)();",
      "    (worker.callback)();",
      "    (tools::callback)();",
      "    (*tools::callback)();",
      "    (|| callback())();",
      "    factory()();",
      "}",
    ].join("\n");
    const calls = extract(src, materialized).chunks.find(({ symbolId }) => symbolId === "run")?.calls;

    // Inner calls remain real sites; the enclosing callable expressions are not
    // declarations. Resolving their values requires a later lexical-flow slice.
    expect(calls?.map(({ callText }) => callText)).toEqual(["callback()", "factory()"]);
  });
});
