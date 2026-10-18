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

  it("places a type bound from a workspace crate the table knows only as a directory", () => {
    const f = fixture({
      "script_bindings/lib.rs": `
pub struct Str;
impl Str { pub fn as_ref(&self) -> &str { todo!() } }
`,
      "src/main.rs": `
use script_bindings::Str;
fn describe(s: Str) {
    s.as_ref();
}
`,
    });
    expect(f.resolve("s.as_ref()").target).toEqual({
      targetRelPath: "script_bindings/lib.rs",
      targetSymbolId: "Str#as_ref",
    });
  });

  it("places a DECLARED RETURN type bound from a workspace crate across the chain fold", () => {
    const f = fixture({
      "script_bindings/lib.rs": `
pub struct Str;
impl Str { pub fn as_ref(&self) -> &str { todo!() } }
pub struct Str2;
impl Str2 { pub fn same_name(&self) {} }
`,
      "src/decoy.rs": `
pub struct Decoy;
impl Decoy { pub fn same_name(&self) {} }
`,
      "src/main.rs": `
mod decoy;
use crate::decoy::Decoy;
use script_bindings::Str2;
struct Frame;
impl Frame {
    fn s(&self) -> Str2 { todo!() }
}
fn paint(fr: Frame) {
    fr.s().same_name();
}
`,
    });
    expect(f.resolve("fr.s().same_name()").target).toEqual({
      targetRelPath: "script_bindings/lib.rs",
      targetSymbolId: "Str2#same_name",
    });
  });

  it("keeps a std-rooted return type unplaced and leaves the chain to decline", () => {
    const f = fixture({
      "src/main.rs": `
struct Counter;
impl Counter {
    fn name(&self) -> String { todo!() }
    fn run(&self) {
        self.name().as_ref();
    }
}
`,
    });
    expect(f.resolve("self.name().as_ref()").target).toBeNull();
  });

  it("auto-derefs a project smart pointer to its Deref target for the terminal member", () => {
    const f = fixture({
      "src/smart.rs": `
pub struct Dom<T> { value: T }
impl<T> Dom<T> {
    pub fn deref(&self) -> &T { todo!() }
}
`,
      "src/window.rs": `
pub struct Window;
impl Window { pub fn paint(&self) {} }
`,
      "src/main.rs": `
mod smart;
mod window;
use crate::smart::Dom;
use crate::window::Window;
fn render(d: Dom<Window>) {
    d.paint();
}
`,
    });
    expect(f.resolve("d.paint()").target).toEqual({
      targetRelPath: "src/window.rs",
      targetSymbolId: "Window#paint",
    });
  });

  it("types a chain hop through the Deref target of the receiver", () => {
    const f = fixture({
      "src/smart.rs": `
pub struct Dom<T> { value: T }
impl<T> Dom<T> {
    pub fn deref(&self) -> &T { todo!() }
}
`,
      "src/window.rs": `
pub struct Window;
pub struct TitleBar;
impl Window {
    pub fn title_bar(&self) -> &TitleBar { todo!() }
}
impl TitleBar { pub fn draw(&self) {} }
`,
      "src/decoy.rs": `
pub struct Decoy;
impl Decoy { pub fn draw(&self) {} }
`,
      "src/main.rs": `
mod smart;
mod window;
mod decoy;
use crate::smart::Dom;
use crate::window::Window;
fn render(d: Dom<Window>) {
    d.title_bar().draw();
}
`,
    });
    expect(f.resolve("d.title_bar().draw()").target).toEqual({
      targetRelPath: "src/window.rs",
      targetSymbolId: "TitleBar#draw",
    });
  });

  it("keeps the owner's own member ahead of the Deref target's", () => {
    const f = fixture({
      "src/smart.rs": `
pub struct Dom<T> { value: T }
impl<T> Dom<T> {
    pub fn deref(&self) -> &T { todo!() }
    pub fn paint(&self) {}
}
`,
      "src/window.rs": `
pub struct Window;
impl Window { pub fn paint(&self) {} }
`,
      "src/main.rs": `
mod smart;
mod window;
use crate::smart::Dom;
use crate::window::Window;
fn render(d: Dom<Window>) {
    d.paint();
}
`,
    });
    expect(f.resolve("d.paint()").target).toEqual({
      targetRelPath: "src/smart.rs",
      targetSymbolId: "Dom#paint",
    });
  });

  it("derefs through an impl whose generic parameter carries a trait bound", () => {
    const f = fixture({
      "src/smart.rs": `
pub trait DomObject {}
pub struct Dom<T> { value: T }
impl<T: DomObject> Deref for Dom<T> {
    type Target = T;
    fn deref(&self) -> &T { todo!() }
}
`,
      "src/window.rs": `
pub struct Window;
impl Window { pub fn paint(&self) {} }
`,
      "src/main.rs": `
mod smart;
mod window;
use crate::smart::Dom;
use crate::window::Window;
fn render(d: Dom<Window>) {
    d.paint();
}
`,
    });
    expect(f.resolve("d.paint()").target).toEqual({
      targetRelPath: "src/window.rs",
      targetSymbolId: "Window#paint",
    });
  });

  it("derefs through a Self::Target declared return", () => {
    const f = fixture({
      "src/smart.rs": `
pub struct Root<T> { value: T }
impl<T> Deref for Root<T> {
    type Target = T;
    fn deref(&self) -> &Self::Target { todo!() }
}
`,
      "src/window.rs": `
pub struct Window;
impl Window { pub fn focus(&self) {} }
`,
      "src/main.rs": `
mod smart;
mod window;
use crate::smart::Root;
use crate::window::Window;
fn render(w: Root<Window>) {
    w.focus();
}
`,
    });
    expect(f.resolve("w.focus()").target).toEqual({
      targetRelPath: "src/window.rs",
      targetSymbolId: "Window#focus",
    });
  });
});
