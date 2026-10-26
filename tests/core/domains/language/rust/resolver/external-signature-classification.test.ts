import { describe, expect, it } from "vitest";

import type { SymbolDefinitionKind } from "../../../../../../src/core/contracts/types/codegraph-symbols.js";
import type { CallContext, LocalBinding } from "../../../../../../src/core/contracts/types/codegraph.js";
import type {
  RustExternalMember,
  RustExternalSignatureTableData,
} from "../../../../../../src/core/contracts/types/language.js";
import { RustExternalSignatureLookup } from "../../../../../../src/core/domains/language/rust/external-signatures/lookup.js";
import {
  RustResolveEnvironment,
  withRustResolveEnvironment,
} from "../../../../../../src/core/domains/language/rust/resolver/resolve-environment.js";
import { RustCallResolver } from "../../../../../../src/core/domains/language/rust/resolver/rust-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

// bd tea-rags-mcp-s3i8m.7 T3 arm C — inherent proof. Rust path resolution and
// method probing take a type's inherent item before any trait item, and the
// orphan rule forbids a project inherent impl on a foreign type: a member the
// external signature table holds as INHERENT on a std/dependency type is
// external even when a project trait or blanket owner of the same name exists.

interface Def {
  relPath: string;
  symbolId: string;
  kind?: SymbolDefinitionKind;
}

function symbols(defs: Def[]): InMemoryGlobalSymbolTable {
  const t = new InMemoryGlobalSymbolTable();
  const byFile = new Map<string, Def[]>();
  for (const d of defs) byFile.set(d.relPath, [...(byFile.get(d.relPath) ?? []), d]);
  for (const [relPath, fileDefs] of byFile) {
    t.upsertFile(
      relPath,
      fileDefs.map((d) => {
        const path = d.symbolId.split(/::|#|\./);
        return {
          symbolId: d.symbolId,
          fqName: d.symbolId,
          shortName: path.at(-1) ?? d.symbolId,
          relPath,
          scope: path.slice(0, -1),
          ...(d.kind === undefined ? {} : { symbolKind: d.kind }),
        };
      }),
    );
  }
  return t;
}

function member(selfKind: RustExternalMember["selfKind"], stable = true): RustExternalMember {
  return {
    returns: { type: { form: "instance", name: "Self" }, genericParameters: ["T"] },
    methodGenericParameters: [],
    selfKind,
    stable,
  };
}

const STD_DATA: RustExternalSignatureTableData = {
  crates: ["std"],
  paths: {
    "std::vec::Vec": "std::vec::Vec",
    "alloc::vec::Vec": "std::vec::Vec",
    "std::prelude::rust_2021::Vec": "std::vec::Vec",
    "std::boxed::Box": "std::boxed::Box",
    "std::prelude::rust_2021::Box": "std::boxed::Box",
  },
  types: {
    "std::vec::Vec": {
      inherent: {
        new: member("none"),
        with_capacity: member("none"),
        push: member("mut"),
        into_boxed_slice: member("value"),
        nightly_only: member("ref", false),
        split_ambiguous: "ambiguous",
      },
      associated: {},
      fields: {},
    },
    "std::boxed::Box": { inherent: { new: member("none") }, associated: {}, fields: {} },
  },
  aliases: {},
} as unknown as RustExternalSignatureTableData;

const SIGNATURES = new RustExternalSignatureLookup(STD_DATA, "test-identity");

function ctx(
  t: InMemoryGlobalSymbolTable,
  opts: { bindings?: Record<string, LocalBinding[]>; withTable?: boolean } = {},
): CallContext {
  const base: CallContext = {
    callerFile: "src/main.rs",
    callerScope: [],
    imports: [],
    symbolTable: t,
    typeDeclarations: { "src/store.rs": [] },
    ...(opts.bindings === undefined ? {} : { localBindings: opts.bindings }),
  };
  return opts.withTable === false
    ? base
    : withRustResolveEnvironment(base, new RustResolveEnvironment(undefined, SIGNATURES));
}

function call(callText: string, receiver: string | null, member: string, startLine = 10) {
  return { callText, receiver, member, startLine };
}

const r = new RustCallResolver();

/** A project `new` whose owner no project type declares (an impl block) — today it keeps every `X::new` unproven. */
const PROJECT_NEW = symbols([{ relPath: "src/store.rs", symbolId: "Store.new", kind: "method" }]);
/** A project trait declaring `push` — today any method-style `push` on a std type stays unproven. */
const PROJECT_PUSH_TRAIT = symbols([
  { relPath: "src/store.rs", symbolId: "Stack", kind: "interface" },
  { relPath: "src/store.rs", symbolId: "Stack#push", kind: "method" },
  { relPath: "src/store.rs", symbolId: "Stack#into_boxed_slice", kind: "method" },
  { relPath: "src/store.rs", symbolId: "Stack#nightly_only", kind: "method" },
  { relPath: "src/store.rs", symbolId: "Stack#split_ambiguous", kind: "method" },
  { relPath: "src/store.rs", symbolId: "Stack#with_capacity", kind: "method" },
]);
const VEC_BINDING = { v: [{ line: 1, type: "Vec<u8>" }] };

describe("Rust inherent proof — path style (`StdType::assoc`)", () => {
  it("classifies a prelude std type's inherent associated fn external despite a project namesake owner", () => {
    const c = ctx(PROJECT_NEW);
    expect(r.targetsExternalImport?.(call("Box::new(x)", "Box", "new"), c)).toBe(true);
    expect(r.targetsExternalImport?.(call("Vec::with_capacity(4)", "Vec", "with_capacity"), c)).toBe(true);
    expect(r.targetsExternalImport?.(call("Vec::new()", "Vec", "new"), c)).toBe(true);
  });

  it("reads a core/alloc spelling of a std type through the table's canonical path", () => {
    const c = ctx(PROJECT_NEW);
    expect(r.targetsExternalImport?.(call("alloc::vec::Vec::new()", "alloc::vec::Vec", "new"), c)).toBe(true);
  });

  it("is byte-identical to today without a table", () => {
    const c = ctx(PROJECT_NEW, { withTable: false });
    expect(r.targetsExternalImport?.(call("Box::new(x)", "Box", "new"), c)).toBe(false);
    expect(r.targetsExternalImport?.(call("alloc::vec::Vec::new()", "alloc::vec::Vec", "new"), c)).toBe(false);
  });

  it("lets a project type shadowing the std name veto the proof", () => {
    const t = symbols([
      { relPath: "src/vec.rs", symbolId: "Vec", kind: "class" },
      { relPath: "src/vec.rs", symbolId: "Vec.new", kind: "method" },
    ]);
    expect(r.targetsExternalImport?.(call("Vec::new()", "Vec", "new"), ctx(t))).toBe(false);
  });
});

describe("Rust inherent proof — method style", () => {
  it("classifies an inherent `&mut self` member external over a project trait namesake", () => {
    const c = ctx(PROJECT_PUSH_TRAIT, { bindings: VEC_BINDING });
    expect(r.targetsExternalImport?.(call("v.push(1)", "v", "push"), c)).toBe(true);
    expect(r.targetsExternalImport?.(call("v.push(1)", "v", "push"), { ...c, languageConfig: undefined })).toBe(false);
  });

  it("stays silent on an ambiguous member, an unstable member and an associated fn without self", () => {
    const c = ctx(PROJECT_PUSH_TRAIT, { bindings: VEC_BINDING });
    expect(r.targetsExternalImport?.(call("v.split_ambiguous()", "v", "split_ambiguous"), c)).toBe(false);
    expect(r.targetsExternalImport?.(call("v.nightly_only()", "v", "nightly_only"), c)).toBe(false);
    expect(r.targetsExternalImport?.(call("v.with_capacity(1)", "v", "with_capacity"), c)).toBe(false);
  });

  it("keeps an extension trait on Vec<u8> in the denominator", () => {
    const t = symbols([
      { relPath: "src/ext.rs", symbolId: "Vec" },
      { relPath: "src/ext.rs", symbolId: "Vec#write_i64", kind: "method" },
      { relPath: "src/ext.rs", symbolId: "Vec#push", kind: "method" },
      { relPath: "src/ext.rs", symbolId: "Vec#into_boxed_slice", kind: "method" },
    ]);
    const c = { ...ctx(t, { bindings: VEC_BINDING }), typeDeclarations: { "src/ext.rs": [] } };
    expect(r.targetsExternalImport?.(call("v.write_i64(1)", "v", "write_i64"), c)).toBe(false);
    // A by-ref trait method on the type itself is probed before the `&mut self` inherent one.
    expect(r.targetsExternalImport?.(call("v.push(1)", "v", "push"), c)).toBe(false);
    // A by-value inherent method is probed first, before any trait method at that step.
    expect(r.targetsExternalImport?.(call("v.into_boxed_slice()", "v", "into_boxed_slice"), c)).toBe(true);
  });
});
