import Parser from "tree-sitter";
import RustLang from "tree-sitter-rust";
import { describe, expect, it } from "vitest";

import { materializeTree } from "../../../../../../src/core/adapters/tree-sitter/materialize.js";
import type { CallContext, FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { RustLanguage } from "../../../../../../src/core/domains/language/rust/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function fixture(files: Record<string, string>) {
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
  const structuredReturnTypes = Object.assign({}, ...extractions.map((file) => file.structuredReturnTypes));
  const typeDeclarations = Object.fromEntries(extractions.map((file) => [file.relPath, file.typeDeclarations ?? []]));
  return {
    language,
    resolve(text: string, file = "src/main.rs") {
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
        structuredReturnTypes,
        typeDeclarations,
      };
      return { target: language.resolver.resolve(call, ctx), call, ctx };
    },
  };
}

describe("Rust import-placed receiver types", () => {
  it("places a receiver type bound by a crate:: import and resolves its member", () => {
    const f = fixture({
      "src/channel.rs": `
pub struct Receiver;
impl Receiver { pub fn recv(&self) {} }
`,
      "src/main.rs": `
mod channel;
use crate::channel::Receiver;
fn pump(receiver: Receiver) {
    receiver.recv();
}
`,
    });
    expect(f.resolve("receiver.recv()").target).toEqual({
      targetRelPath: "src/channel.rs",
      targetSymbolId: "Receiver#recv",
    });
  });

  it("keeps an external import-bound receiver type unplaced and classifies it external", () => {
    const f = fixture({
      "src/main.rs": `
use mozjs::JSContext;
fn gc(cx: &JSContext) {
    cx.no_gc();
}
`,
    });
    const outcome = f.resolve("cx.no_gc()");
    expect(outcome.target).toBeNull();
    expect(f.language.resolver.targetsExternalImport?.(outcome.call, outcome.ctx)).toBe(true);
  });

  it("classifies a std trait constructor with no project definition as external", () => {
    const f = fixture({
      "src/main.rs": `
fn make<T: Default>() -> T {
    Default::default()
}
`,
    });
    const outcome = f.resolve("Default::default()");
    expect(outcome.target).toBeNull();
    expect(f.language.resolver.targetsExternalImport?.(outcome.call, outcome.ctx)).toBe(true);
  });

  it("keeps a project type that shares a std trait name in the denominator", () => {
    const f = fixture({
      "src/main.rs": `
struct Default;
impl Default { fn def(&self) {} }
fn make() {
    Default::def();
}
`,
    });
    const outcome = f.resolve("Default::def()");
    expect(f.language.resolver.targetsExternalImport?.(outcome.call, outcome.ctx)).toBe(false);
    expect(outcome.target).toEqual({ targetRelPath: "src/main.rs", targetSymbolId: "Default#def" });
  });

  it("resolves a self method chain through the declared return of the first hop", () => {
    const f = fixture({
      "src/main.rs": `
struct Window;
impl Window { fn upper(&self) {} }
struct Frame;
impl Frame {
    fn window(&self) -> Window { todo!() }
    fn paint(&self) {
        self.window().upper();
    }
}
`,
    });
    expect(f.resolve("self.window().upper()").target).toEqual({
      targetRelPath: "src/main.rs",
      targetSymbolId: "Window#upper",
    });
  });
});
