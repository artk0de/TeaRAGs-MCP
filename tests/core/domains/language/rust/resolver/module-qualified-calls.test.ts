import Parser from "tree-sitter";
import RustLang from "tree-sitter-rust";
import { describe, expect, it } from "vitest";

import { materializeTree } from "../../../../../../src/core/adapters/tree-sitter/materialize.js";
import type { CallContext, FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { RustLanguage } from "../../../../../../src/core/domains/language/rust/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function fixture(files: Record<string, string>, mainFile = "src/main.rs") {
  const language = new RustLanguage();
  const symbolTable = new InMemoryGlobalSymbolTable();
  const extractions: FileExtraction[] = [];
  for (const [relPath, code] of Object.entries(files)) {
    const parser = new Parser();
    parser.setLanguage(RustLang);
    const native = parser.parse(code);
    const tree = { rootNode: materializeTree(native.rootNode, code) };
    const chunks = collectSymbols(tree, language.walker.nameOf, "::", false, new DefaultSymbolIdComposer());
    symbolTable.upsertFile(
      relPath,
      chunks.map((chunk) => ({
        ...chunk,
        fqName: chunk.symbolId,
        shortName: chunk.symbolId.split(/#|\.|::/).at(-1)!,
        relPath,
      })),
    );
    extractions.push(language.walker.walk({ tree, code, relPath, language: "rust", chunks }));
  }
  return {
    resolve(text: string, file = mainFile) {
      const extraction = extractions.find((entry) => entry.relPath === file)!;
      const chunk = extraction.chunks.find((entry) => entry.calls.some((call) => call.callText === text))!;
      const call = chunk.calls.find((entry) => entry.callText === text)!;
      const ctx: CallContext = {
        callerFile: file,
        callerScope: chunk.scope,
        callerSymbolId: chunk.symbolId,
        imports: extraction.imports,
        symbolTable,
        localBindings: chunk.localBindings,
        callResultBindings: chunk.callResultBindings,
        structuredReturnTypes: Object.assign({}, ...extractions.map((f) => f.structuredReturnTypes)),
        typeDeclarations: Object.fromEntries(extractions.map((f) => [f.relPath, f.typeDeclarations ?? []])),
      };
      return language.resolver.resolve(call, ctx);
    },
  };
}

describe("Rust module-qualified constant calls", () => {
  it("resolves through a module imported with a self binding from a workspace crate", () => {
    const f = fixture({
      "servo_base/generic_channel/mod.rs": `
pub fn channel<T>() -> (Sender<T>, Receiver<T>) { todo!() }
`,
      "src/main.rs": `
use servo_base::generic_channel::{self, GenericSharedMemory};
fn run() {
    let (tx, rx) = generic_channel::channel();
}
`,
    });
    expect(f.resolve("generic_channel::channel()")).toEqual({
      targetRelPath: "servo_base/generic_channel/mod.rs",
      targetSymbolId: "channel",
    });
  });

  it("resolves through a module imported with a self binding from the caller's own crate", () => {
    const f = fixture({
      "src/registry/mod.rs": `
pub fn lookup() {}
`,
      "src/main.rs": `
use crate::registry::{self, Entry};
fn run() {
    registry::lookup();
}
`,
    });
    expect(f.resolve("registry::lookup()")).toEqual({
      targetRelPath: "src/registry/mod.rs",
      targetSymbolId: "lookup",
    });
  });

  it("resolves a module path nested under the imported module", () => {
    const f = fixture({
      "src/net/mod.rs": `
pub mod tcp {
    pub fn connect() {}
}
`,
      "src/main.rs": `
use crate::net;
fn run() {
    net::tcp::connect();
}
`,
    });
    expect(f.resolve("net::tcp::connect()")).toEqual({
      targetRelPath: "src/net/mod.rs",
      targetSymbolId: "tcp.connect",
    });
  });
});
