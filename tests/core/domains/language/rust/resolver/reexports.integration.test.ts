import Parser from "tree-sitter";
import RustLang from "tree-sitter-rust";
import { describe, expect, it } from "vitest";

import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph-extraction.js";
import { LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import {
  extractFromRustFile,
  type RustExtractInput,
} from "../../../../../../src/core/domains/language/rust/walker/walker.js";
import { CallEdgeResolutionRunner } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/resolution-runner.js";
import { CodegraphRunState } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function extract(relPath: string, code: string, chunks: RustExtractInput["chunks"] = []): FileExtraction {
  const parser = new Parser();
  parser.setLanguage(RustLang);
  return extractFromRustFile({
    tree: parser.parse(code),
    code,
    relPath,
    language: "rust",
    chunks,
  });
}

describe("Rust pub-use extraction through resolver context", () => {
  it("forwards real pub-use facts while excluding private use statements", () => {
    const facade = extract(
      "src/facade.rs",
      [
        "pub use crate::api::run as public;",
        "pub use crate::foo::{bar as grouped, baz};",
        "pub use crate::foo::*;",
        "use crate::private::run as hidden;",
      ].join("\n"),
    );

    expect(facade.moduleReexports).toEqual([
      { exportedName: "public", sourceModule: "crate::api", sourceName: "run" },
      { exportedName: "grouped", sourceModule: "crate::foo", sourceName: "bar" },
      { exportedName: "baz", sourceModule: "crate::foo", sourceName: "baz" },
      { exportedName: "*", sourceModule: "crate::foo" },
    ]);
    expect(facade.imports.map(({ importText }) => importText)).toEqual([
      "crate::api::run as public",
      "crate::foo::{bar as grouped, baz}",
      "crate::foo::*",
      "crate::private::run as hidden",
    ]);

    const caller = extract("src/main.rs", "use crate::facade::public;\nfn main() { public(); }\n", [
      { symbolId: "main", scope: [], startLine: 2, endLine: 2 },
    ]);
    const state = new CodegraphRunState();
    state.absorb(facade, []);

    const symbols = new InMemoryGlobalSymbolTable();
    symbols.upsertFile("src/api.rs", [
      { symbolId: "run", fqName: "run", shortName: "run", relPath: "src/api.rs", scope: [] },
    ]);

    const edges = new CallEdgeResolutionRunner(new LanguageFactory(), state).resolve(caller, symbols);

    expect(edges.methodEdges).toEqual([
      {
        sourceSymbolId: "main",
        targetRelPath: "src/api.rs",
        targetSymbolId: "run",
        callExpression: "public()",
      },
    ]);
  });
});
