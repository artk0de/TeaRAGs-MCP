import Parser from "tree-sitter";
import RustLang from "tree-sitter-rust";
import { describe, expect, it } from "vitest";

import { materializeTree } from "../../../../../../src/core/adapters/tree-sitter/materialize.js";
import type { CallContext, FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { LanguageFactory } from "../../../../../../src/core/domains/language/factory.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { RustLanguage } from "../../../../../../src/core/domains/language/rust/index.js";
import { CodegraphRunState } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { collectTypeDeclarationReaders } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/type-declaration-readers.js";

/**
 * The walker's inferred local shapes — an enum variant constructor, agreeing
 * `if` / `match` arms, a `*self` copy, a call-result `let` kept through
 * reassignment — are ADDITIVE (src/core/domains/language/CLAUDE.md): where the
 * type they spell does not place, or the kept binding cannot be typed, the
 * call reads exactly as it did before the shape existed. Each case is a tikv /
 * servo site the shapes moved.
 */
function edgesOf(code: string, materialized: boolean, symbolId = "run") {
  const language = new RustLanguage();
  const factory = new LanguageFactory();
  const runState = new CodegraphRunState([], new Map(), new Map(), collectTypeDeclarationReaders(factory));
  const symbolTable = new InMemoryGlobalSymbolTable();
  const relPath = "src/lib.rs";
  const parser = new Parser();
  parser.setLanguage(RustLang);
  const native = parser.parse(code);
  const tree = { rootNode: materialized ? materializeTree(native.rootNode, code) : native.rootNode };
  const chunks = collectSymbols(tree, language.walker.nameOf, "::", false, new DefaultSymbolIdComposer());
  const extraction: FileExtraction = language.walker.walk({ tree, code, relPath, language: "rust", chunks });
  symbolTable.upsertFile(
    relPath,
    extraction.chunks.map((chunk) => ({
      ...chunk,
      fqName: chunk.symbolId,
      shortName: chunk.symbolId.split(/#|\.|::/).at(-1)!,
      relPath,
    })),
  );
  runState.absorb(extraction, []);
  const chunk = extraction.chunks.find((entry) => entry.symbolId === symbolId)!;
  expect(chunk?.symbolId).toBe(symbolId);
  const ctx: CallContext = {
    callerFile: relPath,
    callerScope: chunk.scope,
    callerSymbolId: chunk.symbolId,
    imports: extraction.imports,
    symbolTable,
    localBindings: chunk.localBindings,
    callResultBindings: chunk.callResultBindings,
    structuredReturnTypes: runState.structuredReturnTypes,
    classFieldTypesByClassKey: runState.classFieldTypesByClassKey,
    typeDeclarations: runState.typeDeclarations,
  };
  return (callText: string): string | undefined => {
    const call = chunk.calls.find((entry) => entry.callText.replace(/\s+/g, "") === callText);
    expect(call?.callText.replace(/\s+/g, "")).toBe(callText);
    return language.resolver.resolve(call!, ctx)?.targetSymbolId ?? undefined;
  };
}

const tikvInstant = `
use self::time::{Instant as TiInstant, monotonic_raw_now};

pub mod time {
  pub enum Instant { Monotonic(u64), MonotonicCoarse(u64) }
  impl Instant {
    pub fn saturating_duration_since(&self, earlier: Instant) -> u64 { 0 }
  }
}
`;

const tikvTime = `
use codec::data_type::*;

pub struct Time;
impl Time {
  pub fn set_time_type(&mut self, time_type: u8) -> Result<(), ()> { Ok(()) }
}
pub trait AddSubDateConvertToTime {
  fn to_time(&self) -> Time;
}
`;

describe.each([false, true])("Rust walker-inferred locals are additive (materialized=%s)", (materialized) => {
  it("reads a variant-constructor local whose `use .. as` type does not place as the untyped baseline", () => {
    const shape = edgesOf(
      `${tikvInstant}
fn run(x: u64) {
  let deadline = TiInstant::Monotonic(x);
  let remain = deadline.saturating_duration_since(TiInstant::Monotonic(monotonic_raw_now()));
}
`,
      materialized,
    );
    const call = "deadline.saturating_duration_since(TiInstant::Monotonic(monotonic_raw_now()))";
    expect(shape(call)).toBe("time::Instant#saturating_duration_since");
  });

  it("keeps a variant-constructor local whose generated type only project impls reopen, where the member resolves", () => {
    const target = edgesOf(
      `
use crate::codegen::Bindings::SanitizerBinding::{SanitizerElement, SanitizerElementNamespace};

impl SanitizerElement {
  pub fn name(&self) -> &str { "" }
}
fn run(local: &str) {
  let element_name = SanitizerElement::SanitizerElementNamespace(SanitizerElementNamespace { name: local });
  let n = element_name.name();
}
`,
      materialized,
    );
    expect(target("element_name.name()")).toBe("SanitizerElement#name");
  });

  it("reads a `*self` copy whose impl type is a re-exported alias as the untyped baseline", () => {
    const target = edgesOf(
      `${tikvTime}
impl AddSubDateConvertToTime for DateTime {
  fn to_time(&self) -> Time {
    let mut t = *self;
    t.set_time_type(1);
    t
  }
}
`,
      materialized,
      "DateTime#to_time",
    );
    expect(target("t.set_time_type(1)")).toBe("Time#set_time_type");
  });

  it("does not hand a std `Cow` match-arm local's iterator chain to a project namesake", () => {
    const target = edgesOf(
      `
use std::borrow::Cow;
use regex::Regex;

pub struct Iter;
impl Iter {
  pub fn nth(&mut self, n: usize) -> Option<u8> { None }
}
pub trait ToInt {}
impl ToInt for std::borrow::Cow<'_, [u8]> {}
fn build() -> Option<Regex> { None }
fn run(metadata: &Option<Regex>, expr: &str) -> Option<()> {
  let regex = match metadata {
    Some(r) => Cow::Borrowed(r),
    None => match build() {
      Some(r) => Cow::Owned(r),
      None => return None,
    },
  };
  if let Some(m) = regex.find_iter(expr).nth(1) {}
  None
}
`,
      materialized,
    );
    expect(target("regex.find_iter(expr).nth(1)")).toBeUndefined();
  });

  it("does not hand a reassigned call-result local the fold cannot type to a project namesake", () => {
    const target = edgesOf(
      `
pub struct LogicalRect;
impl LogicalRect {
  pub fn inflate(&self, a: f32, b: f32) -> LogicalRect { LogicalRect }
}
pub trait ToWebRender {
  type Type;
  fn to_webrender(&self) -> Self::Type;
}
pub struct PhysicalRect;
impl ToWebRender for PhysicalRect {
  type Type = units::LayoutRect;
  fn to_webrender(&self) -> Self::Type { todo!() }
}
fn run(rect: &PhysicalRect, wavy: bool) {
  let mut rect = rect.to_webrender();
  let thickness = rect.height().ceil();
  if wavy {
    rect = rect.inflate(0.0, thickness);
  }
}
`,
      materialized,
    );
    expect(target("rect.inflate(0.0,thickness)")).toBeUndefined();
  });

  it("does not hand a reassigned `Option::unwrap_or` local of a macro-made type to a project namesake", () => {
    const target = edgesOf(
      `
pub struct ApproxDuration(u64);
impl ApproxDuration {
  fn saturating_sub(&self, rhs: ApproxDuration) -> Self { ApproxDuration(0) }
}
unicode_length_type! { Utf16CodeUnits }
fn run(end: Option<Utf16CodeUnits>, selection_end: Utf16CodeUnits, start: Utf16CodeUnits, len: Utf16CodeUnits) {
  let mut end = end.unwrap_or(selection_end);
  if end > len {
    end = len;
  }
  let old_length = end.saturating_sub(start);
}
`,
      materialized,
    );
    expect(target("end.saturating_sub(start)")).toBeUndefined();
  });
});
