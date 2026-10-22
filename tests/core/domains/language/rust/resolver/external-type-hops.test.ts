import Parser from "tree-sitter";
import RustLang from "tree-sitter-rust";
import { describe, expect, it } from "vitest";

import {
  resolveLocalBinding,
  type CallContext,
  type FileExtraction,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import type {
  RustExternalFunction,
  RustExternalMember,
  RustExternalSignatureTableData,
  RustExternalTypeExpr,
  RustExternalTypeSignatures,
  TypeRef,
} from "../../../../../../src/core/contracts/types/language.js";
import { LanguageFactory } from "../../../../../../src/core/domains/language/factory.js";
import {
  collectSymbols,
  DefaultSymbolIdComposer,
  type NominalTypeRef,
} from "../../../../../../src/core/domains/language/kernel/index.js";
import { RustExternalSignatureLookup } from "../../../../../../src/core/domains/language/rust/external-signatures/lookup.js";
import { RustLanguage } from "../../../../../../src/core/domains/language/rust/index.js";
import { rustDeclaredCallResultType } from "../../../../../../src/core/domains/language/rust/resolver/declared-call-result-type.js";
import { rustDeclaredMemberReturnType } from "../../../../../../src/core/domains/language/rust/resolver/declared-return-type.js";
import {
  rustExternalFieldType,
  rustStdTerminalTargetsExternal,
} from "../../../../../../src/core/domains/language/rust/resolver/external-type-hops.js";
import { rustPatternBindingType } from "../../../../../../src/core/domains/language/rust/resolver/pattern-binding-type.js";
import {
  RustResolveEnvironment,
  withRustResolveEnvironment,
} from "../../../../../../src/core/domains/language/rust/resolver/resolve-environment.js";
import { rustTypedMissIsProven } from "../../../../../../src/core/domains/language/rust/resolver/rust-type-member-lookup.js";
import { rustExpressionType } from "../../../../../../src/core/domains/language/rust/resolver/strategies/rust-type-receiver.js";
import { CodegraphRunState } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { collectTypeDeclarationReaders } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/type-declaration-readers.js";

// bd tea-rags-mcp-s3i8m.7 T3b — the receiver fold reads a std/dependency
// receiver's member return from the external signature table (spec step 4)
// and follows a table `Deref::Target` for a member the type does not answer
// itself (spec step 5): `m.lock().unwrap().m()` reaches `Store#m`.

const instance = (name: string, args?: TypeRef[]): NominalTypeRef =>
  args === undefined ? { form: "instance", name } : { form: "instance", name, args };
const expr = (type: TypeRef, genericParameters: string[] = ["T"]): RustExternalTypeExpr => ({
  type,
  genericParameters,
});
const method = (returns: TypeRef, genericParameters: string[] = ["T"]): RustExternalMember => ({
  returns: expr(returns, genericParameters),
  methodGenericParameters: [],
  selfKind: "ref",
  stable: true,
});
const signaturesOf = (partial: Partial<RustExternalTypeSignatures>): RustExternalTypeSignatures => ({
  inherent: {},
  fields: {},
  associated: {},
  traitMembers: {},
  ...partial,
});
const T = instance("T");
const tuple = (...elements: TypeRef[]): TypeRef => ({ form: "tuple", elements });
// A free function's generics are its own: nothing at the call site binds them (bd s3i8m.7 T-A1).
const freeFunction = (returns: TypeRef, functionGenericParameters: string[] = ["T"]): RustExternalFunction => ({
  returns: expr(returns, []),
  functionGenericParameters,
  stable: true,
});
const deref = { "std::ops::Deref": ["deref"], "std::fmt::Debug": ["fmt"] };

const DATA: RustExternalSignatureTableData = {
  crates: ["std", "demo"],
  paths: {
    "std::sync::Mutex": "std::sync::Mutex",
    "std::sync::MutexGuard": "std::sync::MutexGuard",
    "std::cell::RefCell": "std::cell::RefCell",
    "std::cell::Ref": "std::cell::Ref",
    "std::option::Option": "std::option::Option",
    "std::prelude::rust_2021::Option": "std::option::Option",
    "std::result::Result": "std::result::Result",
    "std::prelude::rust_2021::Result": "std::result::Result",
    "demo::Client": "demo::Client",
    "demo::Store": "demo::Store",
    "std::vec::Vec": "std::vec::Vec",
    "std::sync::Arc": "std::sync::Arc",
    "std::collections::HashMap": "std::collections::HashMap",
    "demo::Url": "demo::Url",
    "std::ops::Range": "std::ops::Range",
    "demo::Config": "demo::Config",
    "demo::Handle": "demo::Handle",
  },
  types: {
    "std::sync::Mutex": signaturesOf({
      inherent: {
        lock: method(instance("std::sync::LockResult", [instance("std::sync::MutexGuard", [T])])),
      },
    }),
    "std::sync::MutexGuard": signaturesOf({
      inherent: { map: { ...method(T), selfKind: "none" } },
      associated: { "Deref::Target": expr(T) },
      traitMembers: deref,
    }),
    "std::cell::RefCell": signaturesOf({ inherent: { borrow: method(instance("std::cell::Ref", [T])) } }),
    "std::cell::Ref": signaturesOf({
      inherent: { clone: { ...method(instance("std::cell::Ref", [T])), selfKind: "none" } },
      associated: { "Deref::Target": expr(T) },
      traitMembers: deref,
    }),
    "std::result::Result": signaturesOf({
      inherent: { ok: { ...method(instance("std::option::Option", [T]), ["T", "E"]), selfKind: "value" } },
    }),
    "demo::Client": signaturesOf({ inherent: { get: method(instance("demo::Store"), []) } }),
    "std::vec::Vec": signaturesOf({
      inherent: {
        new: { ...method(instance("Self")), selfKind: "none" },
        with_capacity: { ...method(instance("Self")), selfKind: "none" },
      },
    }),
    "std::sync::Arc": signaturesOf({
      inherent: { new: { ...method(instance("std::sync::Arc", [T])), selfKind: "none" } },
    }),
    "std::collections::HashMap": signaturesOf({
      inherent: {
        with_capacity: {
          ...method(instance("std::collections::HashMap", [instance("K"), instance("V"), instance("RandomState")]), [
            "K",
            "V",
          ]),
          selfKind: "none",
        },
      },
    }),
    "demo::Url": signaturesOf({
      inherent: {
        parse: {
          ...method(instance("std::result::Result", [instance("Self"), instance("demo::ParseError")]), []),
          selfKind: "none",
        },
      },
    }),
    "std::ops::Range": signaturesOf({
      fields: { start: expr(instance("Idx"), ["Idx"]), end: expr(instance("Idx"), ["Idx"]) },
    }),
    "demo::Config": signaturesOf({ fields: { client: expr(instance("demo::Client"), []) } }),
    "demo::Handle": signaturesOf({ associated: { "Deref::Target": expr(T) }, traitMembers: deref }),
  },
  aliases: {
    "std::sync::LockResult": expr(instance("std::result::Result", [T, instance("std::sync::PoisonError", [T])])),
    "std::io::Result": expr(instance("std::result::Result", [T, instance("std::io::Error")])),
  },
  functionPaths: {
    "std::sync::mpsc::channel": "std::sync::mpsc::channel",
    "std::sync::mpsc::sync_channel": "std::sync::mpsc::sync_channel",
    "crossbeam_channel::unbounded": "crossbeam_channel::unbounded",
    "ipc::channel": "ipc::channel",
    "tempfile::tempdir": "tempfile::tempdir",
  },
  functions: {
    "std::sync::mpsc::channel": freeFunction(
      tuple(instance("std::sync::mpsc::Sender", [T]), instance("std::sync::mpsc::Receiver", [T])),
    ),
    "std::sync::mpsc::sync_channel": freeFunction(
      tuple(instance("std::sync::mpsc::SyncSender", [T]), instance("std::sync::mpsc::Receiver", [T])),
    ),
    "crossbeam_channel::unbounded": freeFunction(
      tuple(instance("crossbeam_channel::Sender", [T]), instance("crossbeam_channel::Receiver", [T])),
    ),
    "ipc::channel": freeFunction(
      instance("std::result::Result", [
        tuple(instance("ipc::IpcSender", [T]), instance("ipc::IpcReceiver", [T])),
        instance("std::io::Error"),
      ]),
    ),
    "tempfile::tempdir": freeFunction(instance("std::io::Result", [instance("tempfile::TempDir")]), []),
  },
};
const SIGNATURES = new RustExternalSignatureLookup(DATA, "t3b-identity");

function fixture(files: Record<string, string>) {
  const language = new RustLanguage();
  const factory = new LanguageFactory();
  const runState = new CodegraphRunState([], new Map(), new Map(), collectTypeDeclarationReaders(factory));
  const symbolTable = new InMemoryGlobalSymbolTable();
  const extractions: FileExtraction[] = [];
  for (const [relPath, code] of Object.entries(files)) {
    const parser = new Parser();
    parser.setLanguage(RustLang);
    const tree = { rootNode: parser.parse(code).rootNode };
    const chunks = collectSymbols(tree, language.walker.nameOf, "::", false, new DefaultSymbolIdComposer());
    const extraction = language.walker.walk({ tree, code, relPath, language: "rust", chunks });
    // The walker's chunks carry `symbolKind`, which the free-function arms filter on.
    symbolTable.upsertFile(
      relPath,
      extraction.chunks.map((chunk) => ({
        ...chunk,
        fqName: chunk.symbolId,
        shortName: chunk.symbolId.split(/#|\.|::/).at(-1)!,
        relPath,
      })),
    );
    extractions.push(extraction);
    runState.absorb(extraction, []);
  }
  const ctxOf = (text: string, withTable: boolean, file = "src/main.rs") => {
    const extraction = extractions.find((entry) => entry.relPath === file)!;
    const chunk = extraction.chunks.find((entry) => entry.calls.some((call) => call.callText === text))!;
    const call = chunk.calls.find((entry) => entry.callText === text)!;
    const base: CallContext = {
      callerFile: file,
      callerScope: chunk.scope,
      callerSymbolId: chunk.symbolId,
      imports: extraction.imports,
      symbolTable,
      localBindings: chunk.localBindings,
      callResultBindings: chunk.callResultBindings,
      classFieldTypes: extraction.classFieldTypes,
      classFieldTypesByClassKey: runState.classFieldTypesByClassKey,
      structuredReturnTypes: Object.assign({}, ...extractions.map((entry) => entry.structuredReturnTypes)),
      typeDeclarations: runState.typeDeclarations,
    };
    const ctx = withTable ? withRustResolveEnvironment(base, new RustResolveEnvironment(undefined, SIGNATURES)) : base;
    return { call, ctx };
  };
  return {
    ctxOf,
    resolve(text: string, withTable = true, file = "src/main.rs") {
      const { call, ctx } = ctxOf(text, withTable, file);
      return language.resolver.resolve(call, ctx);
    },
  };
}

// `Other#m` keeps the short-name read of `m` from settling on `Store#m` alone.
const STORES = `struct Store; struct Other;
impl Store { fn m(&self) {} } impl Other { fn m(&self) {} }`;
const storeM = { targetRelPath: "src/main.rs", targetSymbolId: "Store#m" };

describe("Rust external signature table — member returns and Deref targets (s3i8m.7 T3b)", () => {
  it("follows a Mutex guard's table Deref::Target: `self.m.lock().unwrap().m()` reaches Store#m", () => {
    const f = fixture({
      "src/main.rs": `use std::sync::Mutex;
${STORES}
struct Holder { m: Mutex<Store> }
impl Holder { fn run(&self) { self.m.lock().unwrap().m(); } }`,
    });
    expect(f.resolve("self.m.lock().unwrap().m()")).toEqual(storeM);
  });

  it("follows a RefCell Ref's Deref::Target: `self.c.borrow().m()` reaches Store#m", () => {
    const f = fixture({
      "src/main.rs": `use std::cell::RefCell;
${STORES}
struct Holder { c: RefCell<Store> }
impl Holder { fn run(&self) { self.c.borrow().m(); } }`,
    });
    expect(f.resolve("self.c.borrow().m()")).toEqual(storeM);
  });

  it("types a std member the hand tables do not know from the table's declared return", () => {
    const f = fixture({
      "src/main.rs": `${STORES}
struct Holder { r: Result<Store, String> }
impl Holder { fn run(&self) { self.r.ok().unwrap().m(); } }`,
    });
    expect(f.resolve("self.r.ok().unwrap().m()")).toEqual(storeM);
  });

  it("is byte-identical to the old read without a table", () => {
    const f = fixture({
      "src/main.rs": `use std::sync::Mutex;
${STORES}
struct Holder { m: Mutex<Store> }
impl Holder { fn run(&self) { self.m.lock().unwrap().m(); } }`,
    });
    expect(f.resolve("self.m.lock().unwrap().m()", false)).not.toEqual(storeM);
  });

  it("lets a project namesake of a std type in the answer veto the table read", () => {
    const f = fixture({
      "src/main.rs": `use std::sync::Mutex;
${STORES}
struct MutexGuard;
struct Holder { m: Mutex<Store> }
impl Holder { fn run(&self) { self.m.lock().unwrap().m(); } }`,
    });
    const { call, ctx } = f.ctxOf("self.m.lock().unwrap().m()", true);
    const without = f.ctxOf("self.m.lock().unwrap().m()", false);
    const language = new RustLanguage();
    expect(language.resolver.resolve(call, ctx)).toEqual(language.resolver.resolve(without.call, without.ctx));
  });

  it("never places a dependency type's return on a project namesake", () => {
    const f = fixture({
      "src/main.rs": `use demo::Client;
${STORES}
fn run(c: Client) { c.get(); }`,
    });
    // The project's own `Store` shares the dependency type's short name: silent.
    expect(rustDeclaredMemberReturnType(instance("Client"), "get", f.ctxOf("c.get()", true).ctx)).toBeUndefined();
    // Without a namesake the dependency type travels by its canonical path, unplaced.
    const plain = fixture({ "src/main.rs": `use demo::Client;\nfn run(c: Client) { c.get(); }` });
    const { ctx } = plain.ctxOf("c.get()", true);
    expect(rustDeclaredMemberReturnType(instance("Client"), "get", ctx)).toEqual(instance("demo::Store"));
    expect(rustDeclaredMemberReturnType(instance("Client"), "get", plain.ctxOf("c.get()", false).ctx)).toBeUndefined();
  });

  it("keeps a guard whose Deref target the fold cannot see unproven (CONTINUE, never a dropped edge)", () => {
    const f = fixture({ "src/main.rs": `${STORES}\nfn run(c: Client) { c.get(); }` });
    const { ctx } = f.ctxOf("c.get()", true);
    expect(rustTypedMissIsProven(instance("std::sync::MutexGuard"), "m", ctx)).toBe(false);
    const without = f.ctxOf("c.get()", false).ctx;
    expect(rustTypedMissIsProven(instance("std::sync::MutexGuard"), "m", without)).toBe(true);
  });

  it("judges a guard's terminal member on its Deref target, never on the guard alone", () => {
    const f = fixture({ "src/main.rs": `${STORES}\nfn run(c: Client) { c.get(); }` });
    const { ctx } = f.ctxOf("c.get()", true);
    const guardOf = (args?: TypeRef[]) => instance("std::sync::MutexGuard", args);
    // A std target judges the member: `guard.len()` on `MutexGuard<String>` is std.
    expect(rustStdTerminalTargetsExternal(guardOf([instance("String")]), "len", ctx)).toBe(true);
    // A project target proves nothing; one the fold cannot spell keeps the pre-table verdict.
    expect(rustStdTerminalTargetsExternal(guardOf([instance("src/main.rs::Store")]), "m", ctx)).toBe(false);
    expect(rustStdTerminalTargetsExternal(guardOf(), "m", ctx)).toBe(true);
    // The guard's own trait member stays std; without a table the guard is a plain std terminal.
    expect(rustStdTerminalTargetsExternal(guardOf(), "fmt", ctx)).toBe(true);
    expect(rustStdTerminalTargetsExternal(guardOf(), "m", f.ctxOf("c.get()", false).ctx)).toBe(true);
  });
});

describe("Rust external signature table — `ExtType::assoc(..)` path-call results (s3i8m.7 T3c)", () => {
  const callResultOf = (code: string, local: string, callText: string, withTable = true) => {
    const f = fixture({ "src/main.rs": code });
    const { call, ctx } = f.ctxOf(callText, withTable);
    return rustDeclaredCallResultType(local, call.startLine, ctx);
  };

  it("types `let v = Vec::new()` as the table's `Self`", () => {
    const code = `fn run() {\n  let v = Vec::new();\n  v.len();\n}`;
    expect(callResultOf(code, "v", "v.len()")).toEqual(instance("Vec"));
  });

  it("is byte-identical to the old read without a table", () => {
    const code = `fn run() {\n  let v = Vec::new();\n  v.len();\n}`;
    expect(callResultOf(code, "v", "v.len()", false)).toBeUndefined();
  });

  it("drops arguments nothing binds: `HashMap::with_capacity(n)` is a bare `HashMap`", () => {
    const code = `fn run() {\n  let h = HashMap::with_capacity(4);\n  h.len();\n}`;
    expect(callResultOf(code, "h", "h.len()")).toEqual(instance("HashMap"));
  });

  it("wraps a typed argument: `Arc::new(s)` with `s: Store` is `Arc<Store>`", () => {
    const code = `${STORES}
fn run(s: Store) {
  let a = Arc::new(s);
  a.m();
}`;
    expect(callResultOf(code, "a", "a.m()")).toEqual(instance("Arc", [instance("src/main.rs::Store")]));
  });

  it("types the wrapped local through its own call-result binding: `Arc::new(Vec::new())` via `v`", () => {
    const code = `fn run() {\n  let v = Vec::new();\n  let a = Arc::new(v);\n  a.len();\n}`;
    expect(callResultOf(code, "a", "a.len()")).toEqual(instance("Arc", [instance("Vec")]));
  });

  it("keeps `Arc::new(x)` argument-less when `x` is untyped", () => {
    const code = `fn run() {\n  let a = Arc::new(make());\n  a.len();\n}`;
    expect(callResultOf(code, "a", "a.len()")).toEqual(instance("Arc"));
  });

  it("canonicalises a dependency type through the caller's imports and unwraps `?`", () => {
    const code = `use demo::Url;
fn run(s: &str) -> Option<()> {
  let u = Url::parse(s)?;
  u.host();
  None
}`;
    expect(callResultOf(code, "u", "u.host()")).toEqual(instance("demo::Url"));
  });

  it("lets a project namesake veto the table", () => {
    const code = `struct Vec;\nfn run() {\n  let v = Vec::new();\n  v.len();\n}`;
    expect(callResultOf(code, "v", "v.len()")).toBeUndefined();
  });

  it("never types a module function call", () => {
    const code = `fn run() {\n  let d = fs::read(p);\n  d.len();\n}`;
    expect(callResultOf(code, "d", "d.len()")).toBeUndefined();
  });
});

describe("Rust external signature table — public fields of external types (s3i8m.7 T3c)", () => {
  it("types `self.r.start` from `Range<Store>`'s table field and reaches Store#m", () => {
    const f = fixture({
      "src/main.rs": `${STORES}
struct Holder { r: std::ops::Range<Store> }
impl Holder { fn run(&self) { self.r.start.m(); } }`,
    });
    expect(f.resolve("self.r.start.m()")).toEqual(storeM);
    expect(f.resolve("self.r.start.m()", false)).not.toEqual(storeM);
  });

  it("types a dependency struct's public field through its canonical path", () => {
    const f = fixture({ "src/main.rs": `use demo::Config;\nfn run(c: Config) { c.client.get(); }` });
    const { ctx } = f.ctxOf("c.client.get()", true);
    expect(rustExternalFieldType(instance("Config"), "client", ctx)).toEqual(instance("demo::Client"));
    expect(rustExternalFieldType(instance("Config"), "missing", ctx)).toBeUndefined();
    const without = f.ctxOf("c.client.get()", false).ctx;
    expect(rustExternalFieldType(instance("Config"), "client", without)).toBeUndefined();
  });

  it("lets a project namesake of the field's type veto the table", () => {
    const code = `use demo::Config;\nstruct Client;\nfn run(c: Config) { c.client.get(); }`;
    const { ctx } = fixture({ "src/main.rs": code }).ctxOf("c.client.get()", true);
    expect(rustExternalFieldType(instance("Config"), "client", ctx)).toBeUndefined();
  });
});

describe("Rust std-trait return model — Clone / ToString / Ord / PartialEq / Hash (s3i8m.7 T3c)", () => {
  const ctxFor = (code: string, withTable = true) =>
    fixture({ "src/main.rs": `${code}\nfn run(c: Client) { c.get(); }` }).ctxOf("c.get()", withTable).ctx;
  const store = instance("src/main.rs::Store");
  const ordering = instance("Ordering");

  it("answers the implementor-independent returns on a typed receiver", () => {
    const ctx = ctxFor(STORES);
    const client = instance("demo::Client");
    expect(rustDeclaredMemberReturnType(client, "to_string", ctx)).toEqual(instance("String"));
    expect(rustDeclaredMemberReturnType(client, "eq", ctx)).toEqual(instance("bool"));
    expect(rustDeclaredMemberReturnType(client, "cmp", ctx)).toEqual(ordering);
    expect(rustDeclaredMemberReturnType(client, "partial_cmp", ctx)).toEqual(instance("Option", [ordering]));
    expect(rustDeclaredMemberReturnType(client, "hash", ctx)).toEqual({ form: "tuple", elements: [] });
    expect(rustDeclaredMemberReturnType(store, "to_string", ctx)).toEqual(instance("String"));
  });

  it("answers `Self` for clone / to_owned when the receiver has no Deref target to hand them to", () => {
    const ctx = ctxFor(STORES);
    const vecOfStore = instance("Vec", [store]);
    expect(rustDeclaredMemberReturnType(vecOfStore, "clone", ctx)).toEqual(vecOfStore);
    expect(rustDeclaredMemberReturnType(store, "clone", ctx)).toEqual(store);
    expect(rustDeclaredMemberReturnType(store, "to_owned", ctx)).toEqual(store);
    expect(rustDeclaredMemberReturnType(instance("usize"), "clone", ctx)).toEqual(instance("usize"));
    expect(rustDeclaredMemberReturnType(instance("str"), "to_owned", ctx)).toEqual(instance("String"));
  });

  it("hands clone through a dependency type's Deref and stays silent when the target is unspellable", () => {
    const ctx = ctxFor(STORES);
    expect(rustDeclaredMemberReturnType(instance("demo::Handle", [store]), "clone", ctx)).toEqual(store);
    expect(rustDeclaredMemberReturnType(instance("demo::Handle"), "clone", ctx)).toBeUndefined();
    // An implementor-independent member answers even through an unspellable target.
    expect(rustDeclaredMemberReturnType(instance("demo::Handle"), "to_string", ctx)).toEqual(instance("String"));
  });

  it("keeps a project impl's declared clone and lets a project namesake veto the model", () => {
    const declared = ctxFor(`${STORES}\nimpl Clone for Store { fn clone(&self) -> Self { Store } }`);
    expect(rustDeclaredMemberReturnType(store, "clone", declared)).toEqual(store);
    const shadowed = ctxFor(`${STORES}\nstruct Ordering;`);
    expect(rustDeclaredMemberReturnType(instance("demo::Client"), "cmp", shadowed)).toBeUndefined();
  });

  it("is byte-identical to the old read without a table", () => {
    const ctx = ctxFor(STORES, false);
    expect(rustDeclaredMemberReturnType(instance("demo::Client"), "to_string", ctx)).toBeUndefined();
    expect(rustDeclaredMemberReturnType(store, "clone", ctx)).toBeUndefined();
  });

  it("types `Type::default()` on an external type as the type itself", () => {
    const f = fixture({
      "src/main.rs": `use demo::Client;\nfn run() {\n  let c = Client::default();\n  c.get();\n}`,
    });
    const { call, ctx } = f.ctxOf("c.get()", true);
    expect(rustDeclaredCallResultType("c", call.startLine, ctx)).toEqual(instance("demo::Client"));
  });
});

describe("Rust external signature table — free-function roots (s3i8m.7 T-A2)", () => {
  /** The type of the pattern-bound `local` read at `callText`. */
  const patternTypeOf = (files: Record<string, string>, local: string, callText: string, withTable = true) => {
    const f = fixture(files);
    const { call, ctx } = f.ctxOf(callText, withTable);
    const binding = resolveLocalBinding(ctx.localBindings, local, call.startLine, call.startColumn);
    expect(binding?.valueKind).toBe("patternProjection");
    return rustPatternBindingType(binding!, ctx, rustExpressionType);
  };
  const main = (code: string) => ({ "src/main.rs": code });

  it("types `let (tx, rx) = channel()` through `use std::sync::mpsc::channel`", () => {
    const code = `use std::sync::mpsc::channel;\nfn run() {\n  let (tx, rx) = channel();\n  tx.send(1);\n}`;
    expect(patternTypeOf(main(code), "tx", "tx.send(1)")).toEqual(instance("std::sync::mpsc::Sender"));
  });

  it("types a module-qualified call through `use std::sync::mpsc`", () => {
    const code = `use std::sync::mpsc;\nfn run() {\n  let (tx, _) = mpsc::sync_channel(1);\n  tx.send(1);\n}`;
    expect(patternTypeOf(main(code), "tx", "tx.send(1)")).toEqual(instance("std::sync::mpsc::SyncSender"));
  });

  it("types a call whose head is a dependency crate name", () => {
    const code = `fn run() {\n  let (s, r) = crossbeam_channel::unbounded();\n  r.recv();\n}`;
    expect(patternTypeOf(main(code), "r", "r.recv()")).toEqual(instance("crossbeam_channel::Receiver"));
  });

  it("peels an `.unwrap()` tail off a `Result<(A, B), E>` scrutinee", () => {
    const code = `fn run() {\n  let (a, b) = ipc::channel().unwrap();\n  a.send(1);\n}`;
    expect(patternTypeOf(main(code), "a", "a.send(1)")).toEqual(instance("ipc::IpcSender"));
  });

  it("peels `?` and `.expect(..)` tails alike", () => {
    const tried = `fn run() -> std::io::Result<()> {\n  let (a, b) = ipc::channel()?;\n  a.send(1);\n  Ok(())\n}`;
    expect(patternTypeOf(main(tried), "a", "a.send(1)")).toEqual(instance("ipc::IpcSender"));
    const expected = `fn run() {\n  let (a, b) = ipc::channel().expect("ipc (pair)");\n  b.recv();\n}`;
    expect(patternTypeOf(main(expected), "b", "b.recv()")).toEqual(instance("ipc::IpcReceiver"));
  });

  it("types a glob-only binding when the project declares no function of the name", () => {
    const code = `use std::sync::mpsc::*;\nfn run() {\n  let (tx, rx) = channel();\n  tx.send(1);\n}`;
    expect(patternTypeOf(main(code), "tx", "tx.send(1)")).toEqual(instance("std::sync::mpsc::Sender"));
  });

  it("lets a same-file project `fn channel()` answer: the table is never asked", () => {
    const code = `${STORES}
fn channel() -> (Store, Other) { todo!() }
fn run() {\n  let (tx, rx) = channel();\n  tx.m();\n}`;
    expect(patternTypeOf(main(code), "tx", "tx.m()")).toEqual(instance("src/main.rs::Store"));
  });

  it("gives no table answer for a name an import binds to `crate::`", () => {
    const code = `use crate::chan::channel;\nfn run() {\n  let (tx, rx) = channel();\n  tx.send(1);\n}`;
    expect(patternTypeOf(main(code), "tx", "tx.send(1)")).toBeUndefined();
  });

  it("declines a glob-only binding when the project declares a `fn channel`", () => {
    const files = {
      "src/main.rs": `use std::sync::mpsc::*;\nfn run() {\n  let (tx, rx) = channel();\n  tx.send(1);\n}`,
      "src/chan.rs": `pub fn channel() -> u8 { 0 }`,
    };
    expect(patternTypeOf(files, "tx", "tx.send(1)")).toBeUndefined();
  });

  it("declines a module head the project declares", () => {
    const code = `mod ipc { pub fn channel() {} }\nfn run() {\n  let (a, b) = ipc::channel().unwrap();\n  a.send(1);\n}`;
    expect(patternTypeOf(main(code), "a", "a.send(1)")).toBeUndefined();
  });

  it("leaves an unknown function, or a missing table, untyped", () => {
    const unknown = `use std::sync::mpsc::bounded;\nfn run() {\n  let (tx, rx) = bounded();\n  tx.send(1);\n}`;
    expect(patternTypeOf(main(unknown), "tx", "tx.send(1)")).toBeUndefined();
    const known = `use std::sync::mpsc::channel;\nfn run() {\n  let (tx, rx) = channel();\n  tx.send(1);\n}`;
    expect(patternTypeOf(main(known), "tx", "tx.send(1)", false)).toBeUndefined();
  });

  it("types a plain `let d = tempfile::tempdir()?` through the table's alias-expanded return", () => {
    const code = `fn run() -> std::io::Result<()> {\n  let d = tempfile::tempdir()?;\n  d.path();\n  Ok(())\n}`;
    const f = fixture(main(code));
    const { call, ctx } = f.ctxOf("d.path()", true);
    expect(rustDeclaredCallResultType("d", call.startLine, ctx)).toEqual(instance("tempfile::TempDir"));
    const without = f.ctxOf("d.path()", false);
    expect(rustDeclaredCallResultType("d", without.call.startLine, without.ctx)).toBeUndefined();
  });
});
