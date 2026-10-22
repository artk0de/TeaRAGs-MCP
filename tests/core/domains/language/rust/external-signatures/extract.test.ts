/**
 * Rust external signature table extractor (bd s3i8m.7 T1). A pure pass from
 * external crate sources (a mini sysroot + one registry crate under
 * `tests/fixtures/rust-external-signatures/`) to a JSON-safe table keyed by
 * canonical type paths, read back through `RustExternalSignatureLookup`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import Parser from "tree-sitter";
import RustLang from "tree-sitter-rust";
import { beforeAll, describe, expect, it } from "vitest";

import type { AstNode, RustExternalSignatureTableData } from "../../../../../../src/core/contracts/index.js";
import {
  extractRustExternalSignatures,
  RustExternalSignatureLookup,
  type RustExternalSourceFile,
} from "../../../../../../src/core/domains/language/rust/external-signatures/index.js";

const FIXTURES = join(process.cwd(), "tests/fixtures/rust-external-signatures");
const LIBRARY = join(FIXTURES, "sysroot/lib/rustlib/src/rust/library");
const DEMO = join(FIXTURES, "cargo-home/registry/src/index.crates.io-x/demo-0.1.0/src");

const parser = new Parser();
parser.setLanguage(RustLang);
const parse = (source: string): AstNode => parser.parse(source).rootNode;

function crateSources(crate: string, srcRoot: string): RustExternalSourceFile[] {
  const files: RustExternalSourceFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".rs")) {
        files.push({ crate, relPath: relative(srcRoot, path), source: readFileSync(path, "utf8") });
      }
    }
  };
  walk(srcRoot);
  return files;
}

const sysrootSources = (library: string): RustExternalSourceFile[] =>
  ["core", "alloc", "std"].flatMap((crate) => crateSources(crate, join(library, crate, "src")));

const instance = (name: string, ...args: object[]) =>
  args.length > 0 ? { form: "instance", name, args } : { form: "instance", name };

describe("extractRustExternalSignatures — mini sysroot", () => {
  let data: RustExternalSignatureTableData;
  let table: RustExternalSignatureLookup;

  beforeAll(() => {
    data = extractRustExternalSignatures(sysrootSources(LIBRARY), parse);
    table = new RustExternalSignatureLookup(data, "fixture");
  });

  it("canonicalizes every public spelling to the shortest public path, std first", () => {
    expect(data.paths["std::sync::Mutex"]).toBe("std::sync::Mutex");
    expect(data.paths["std::sync::poison::Mutex"]).toBe("std::sync::Mutex");
    expect(data.paths["core::option::Option"]).toBe("std::option::Option");
    expect(data.paths["std::prelude::rust_2024::Option"]).toBe("std::option::Option");
    expect(data.paths["alloc::vec::Vec"]).toBe("std::vec::Vec");
    expect(data.paths["std::prelude::rust_2024::Vec"]).toBe("std::vec::Vec");
  });

  it("keeps the private sys decoy out of the table", () => {
    expect(Object.keys(data.paths).filter((spelling) => spelling.includes("sys"))).toEqual([]);
    expect(Object.keys(data.types).filter((path) => path.includes("sys"))).toEqual([]);
  });

  it("answers the stable public lock over impl generics, not the decoys", () => {
    expect(table.inherentMember("std::sync::Mutex", "lock")).toEqual({
      returns: {
        type: instance("std::sync::LockResult", instance("std::sync::MutexGuard", instance("T"))),
        genericParameters: ["T"],
      },
      methodGenericParameters: [],
      selfKind: "ref",
      stable: true,
    });
    expect(table.inherentMember("std::sync::Mutex", "new")).toEqual({
      returns: { type: instance("std::sync::Mutex", instance("T")), genericParameters: ["T"] },
      methodGenericParameters: [],
      selfKind: "none",
      stable: true,
    });
    expect(table.inherentMember("std::sync::Mutex", "get_mut")).toMatchObject({
      returns: { type: instance("std::sync::LockResult", instance("T")) },
      selfKind: "mut",
    });
  });

  it("records a non-nominal return as a member without returns, unstable", () => {
    expect(table.inherentMember("std::sync::Mutex", "data_ptr")).toEqual({
      methodGenericParameters: [],
      selfKind: "ref",
      stable: false,
    });
  });

  it("keeps method-level generics apart from the impl's", () => {
    expect(table.inherentMember("std::option::Option", "map")).toEqual({
      returns: { type: instance("std::option::Option", instance("U")), genericParameters: ["T"] },
      methodGenericParameters: ["U", "F"],
      selfKind: "value",
      stable: true,
    });
    expect(table.inherentMember("std::option::Option", "is_some")).toMatchObject({
      returns: { type: instance("bool") },
    });
    expect(table.inherentMember("std::io::Error", "description")).toMatchObject({ returns: { type: instance("str") } });
    expect(table.inherentMember("std::vec::Vec", "push")).toMatchObject({
      returns: { type: { form: "tuple", elements: [] } },
      selfKind: "mut",
    });
  });

  it("skips private fns, cfg(test) impls and macro-generated impls", () => {
    expect(table.inherentMember("std::option::Option", "private_helper")).toBeUndefined();
    expect(table.inherentMember("std::sync::Mutex", "test_only")).toBeUndefined();
    expect(table.inherentMember("std::option::Option", "generated")).toBeUndefined();
  });

  it("unions cfg arms: a conflicting member is ambiguous, an agreeing one is answered", () => {
    expect(table.inherentMember("std::io::Stdin", "handle")).toBe("ambiguous");
    expect(table.inherentMember("std::io::Stdin", "output")).toMatchObject({
      returns: { type: instance("std::io::Output") },
    });
  });

  it("resolves alias heads and expands public aliases", () => {
    expect(table.inherentMember("std::io::Stdin", "try_clone")).toMatchObject({
      returns: { type: instance("std::io::Result", instance("std::io::Stdin")) },
    });
    expect(table.alias("std::sync::LockResult")).toEqual({
      type: instance("std::result::Result", instance("T"), instance("std::sync::PoisonError", instance("T"))),
      genericParameters: ["T"],
    });
    expect(table.alias("std::io::Result")).toEqual({
      type: instance("std::result::Result", instance("T"), instance("std::io::Error")),
      genericParameters: ["T"],
    });
  });

  it("reads the closed associated types from trait impls, never from an impl for a reference", () => {
    expect(table.associatedType("std::sync::MutexGuard", "Deref::Target")).toEqual({
      type: instance("T"),
      genericParameters: ["T"],
    });
    expect(table.associatedType("std::vec::Vec", "IntoIterator::IntoIter")).toEqual({
      type: instance("std::vec::IntoIter", instance("T")),
      genericParameters: ["T"],
    });
    expect(table.associatedType("std::option::Iter", "Iterator::Item")).toEqual({
      type: instance("A"),
      genericParameters: ["A"],
    });
    expect(table.associatedType("std::vec::Vec", "Deref::Target")).toBeUndefined();
    expect(data.types["std::vec::Vec"]?.traitMembers["std::ops::Deref"]).toEqual(["deref"]);
  });

  it("answers pub fields only, positional over the struct's parameters", () => {
    expect(table.field("std::io::Output", "status")).toEqual({
      type: instance("std::io::Stdin"),
      genericParameters: [],
    });
    expect(table.field("std::io::Output", "error")).toEqual({
      type: instance("std::option::Option", instance("std::io::Error")),
      genericParameters: [],
    });
    expect(table.field("std::io::Output", "buffer")).toBeUndefined();
    expect(table.field("std::io::Output", "internal")).toBeUndefined();
    expect(table.field("std::sync::MutexGuard", "poisoned")).toEqual({
      type: instance("std::sync::poison::mutex::PoisonFlag"),
      genericParameters: ["T"],
    });
  });

  it("canonicalizes a caller spelling through its use declarations and the prelude", () => {
    expect(table.canonicalType("Mutex", ["use std::sync::Mutex;"])).toBe("std::sync::Mutex");
    expect(table.canonicalType("sync::Mutex", ["use std::sync;"])).toBe("std::sync::Mutex");
    expect(table.canonicalType("Guard", ["use std::sync::{Mutex, MutexGuard as Guard};"])).toBe(
      "std::sync::MutexGuard",
    );
    expect(table.canonicalType("Mutex", ["use std::sync::*;"])).toBe("std::sync::Mutex");
    expect(table.canonicalType("std::sync::poison::Mutex", [])).toBe("std::sync::Mutex");
    expect(table.canonicalType("Option", [])).toBe("std::option::Option");
    expect(table.canonicalType("Mutex", [])).toBeUndefined();
    expect(table.canonicalType("Mutex", ["use crate::sync::Mutex;"])).toBeUndefined();
  });

  it("is JSON-safe", () => {
    expect(JSON.parse(JSON.stringify(data))).toEqual(JSON.parse(JSON.stringify(data)));
    const roundTripped = new RustExternalSignatureLookup(JSON.parse(JSON.stringify(data)), "fixture");
    expect(roundTripped.inherentMember("std::sync::Mutex", "lock")).toEqual(
      table.inherentMember("std::sync::Mutex", "lock"),
    );
    expect(roundTripped.inherentMember("std::sync::Mutex", "constructor")).toBeUndefined();
    expect(roundTripped.identity).toBe("fixture");
  });
});

const tuple = (...elements: object[]) => ({ form: "tuple", elements });

describe("extractRustExternalSignatures — free functions (bd s3i8m.7 T-A1)", () => {
  let data: RustExternalSignatureTableData;
  let table: RustExternalSignatureLookup;

  beforeAll(() => {
    data = extractRustExternalSignatures(sysrootSources(LIBRARY), parse);
    table = new RustExternalSignatureLookup(data, "fixture");
  });

  it("extracts a pub fn under its canonical path with a tuple return in canonical element paths", () => {
    expect(data.functionPaths?.["std::sync::mpsc::channel"]).toBe("std::sync::mpsc::channel");
    expect(table.freeFunction("std::sync::mpsc::channel")).toEqual({
      returns: {
        type: tuple(
          instance("std::sync::mpsc::Sender", instance("T")),
          instance("std::sync::mpsc::Receiver", instance("T")),
        ),
        genericParameters: [],
      },
      functionGenericParameters: ["T"],
      stable: true,
    });
    expect(table.freeFunction("std::sync::mpsc::sync_channel")).toMatchObject({
      returns: {
        type: tuple(
          instance("std::sync::mpsc::SyncSender", instance("T")),
          instance("std::sync::mpsc::Receiver", instance("T")),
        ),
      },
    });
  });

  it("leaves non-pub and cfg(test) fns out; a std fn without #[stable] is unstable", () => {
    expect(table.freeFunction("std::sync::mpsc::private_channel")).toBeUndefined();
    expect(table.freeFunction("std::sync::mpsc::test_channel")).toBeUndefined();
    expect(Object.keys(data.functionPaths ?? {}).filter((path) => /private|test_channel/.test(path))).toEqual([]);
    expect(table.freeFunction("std::sync::mpsc::preview_channel")).toMatchObject({ stable: false });
  });

  it("stores an inherent member whose return is a tuple (was dropped before)", () => {
    expect(table.inherentMember("std::sync::mpsc::Receiver", "split")).toEqual({
      returns: {
        type: tuple(
          instance("std::sync::mpsc::Sender", instance("T")),
          instance("std::sync::mpsc::Receiver", instance("T")),
        ),
        genericParameters: ["T"],
      },
      methodGenericParameters: [],
      selfKind: "ref",
      stable: true,
    });
  });

  it("canonicalizes a caller's function spelling through its use declarations, without a prelude arm", () => {
    expect(table.canonicalFunction("channel", ["use std::sync::mpsc::channel;"])).toBe("std::sync::mpsc::channel");
    expect(table.canonicalFunction("mpsc::sync_channel", ["use std::sync::mpsc;"])).toBe(
      "std::sync::mpsc::sync_channel",
    );
    expect(table.canonicalFunction("make", ["use std::sync::mpsc::{channel as make};"])).toBe(
      "std::sync::mpsc::channel",
    );
    expect(table.canonicalFunction("channel", ["use std::sync::mpsc::*;"])).toBe("std::sync::mpsc::channel");
    expect(table.canonicalFunction("std::sync::mpsc::channel", [])).toBe("std::sync::mpsc::channel");
    expect(table.canonicalFunction("channel", [])).toBeUndefined();
    expect(table.canonicalFunction("channel", ["use crate::sync::mpsc::channel;"])).toBeUndefined();
    expect(table.canonicalFunction("Mutex", ["use std::sync::Mutex;"])).toBeUndefined();
  });

  it("answers no function from a table without the function namespace, nor from Object.prototype", () => {
    const bare = new RustExternalSignatureLookup({ crates: [], paths: {}, types: {}, aliases: {} }, "bare");
    expect(bare.freeFunction("std::sync::mpsc::channel")).toBeUndefined();
    expect(bare.canonicalFunction("std::sync::mpsc::channel", [])).toBeUndefined();
    const roundTripped = new RustExternalSignatureLookup(JSON.parse(JSON.stringify(data)), "fixture");
    expect(roundTripped.freeFunction("constructor")).toBeUndefined();
    expect(roundTripped.canonicalFunction("constructor", [])).toBeUndefined();
    expect(roundTripped.freeFunction("std::sync::mpsc::channel")).toEqual(
      table.freeFunction("std::sync::mpsc::channel"),
    );
  });
});

describe("extractRustExternalSignatures — the value namespace beside the type namespace", () => {
  const KRATE: RustExternalSourceFile[] = [
    {
      crate: "krate",
      relPath: "lib.rs",
      source: [
        "pub mod spawn;",
        "pub use spawn::spawn;",
        "pub mod channel;",
        "pub use crate::channel::{bounded, unbounded};",
        "pub struct Handle;",
        "#[cfg(unix)]",
        "pub fn pick() -> Handle { loop {} }",
        "#[cfg(windows)]",
        "pub fn pick() -> u32 { 0 }",
        "#[cfg(unix)]",
        "pub fn same() -> Handle { loop {} }",
        "#[cfg(windows)]",
        "pub fn same() -> Handle { loop {} }",
      ].join("\n"),
    },
    {
      crate: "krate",
      relPath: "spawn.rs",
      source: "pub struct JoinHandle;\npub fn spawn() -> JoinHandle { loop {} }\n",
    },
    {
      crate: "krate",
      relPath: "channel.rs",
      source: [
        "pub struct Sender;",
        "pub fn bounded(cap: usize) -> (Sender, Sender) { loop {} }",
        "pub fn unbounded() -> (Sender, Sender) { loop {} }",
      ].join("\n"),
    },
  ];
  let data: RustExternalSignatureTableData;
  let table: RustExternalSignatureLookup;

  beforeAll(() => {
    data = extractRustExternalSignatures(KRATE, parse);
    table = new RustExternalSignatureLookup(data, "krate");
  });

  it("binds `mod spawn; pub use spawn::spawn;` in both namespaces without a collision", () => {
    expect(data.functionPaths?.["krate::spawn"]).toBe("krate::spawn");
    expect(data.functionPaths?.["krate::spawn::spawn"]).toBe("krate::spawn");
    expect(table.freeFunction("krate::spawn")).toMatchObject({
      returns: { type: instance("krate::spawn::JoinHandle") },
      stable: true,
    });
    expect(data.paths["krate::spawn::JoinHandle"]).toBe("krate::spawn::JoinHandle");
    expect(data.paths["krate::spawn"]).toBeUndefined();
    expect(table.canonicalType("spawn", ["use krate::spawn;"])).toBeUndefined();
  });

  it("makes a re-exported fn canonical at its shortest public path", () => {
    expect(data.functionPaths?.["krate::channel::unbounded"]).toBe("krate::unbounded");
    expect(table.canonicalFunction("unbounded", ["use krate::unbounded;"])).toBe("krate::unbounded");
    expect(table.canonicalFunction("channel::bounded", ["use krate::channel;"])).toBe("krate::bounded");
    expect(table.freeFunction("krate::unbounded")).toEqual({
      returns: {
        type: tuple(instance("krate::channel::Sender"), instance("krate::channel::Sender")),
        genericParameters: [],
      },
      functionGenericParameters: [],
      stable: true,
    });
  });

  it("answers ambiguous for cfg arms with different returns and the agreed return otherwise", () => {
    expect(table.freeFunction("krate::pick")).toBe("ambiguous");
    expect(table.freeFunction("krate::same")).toMatchObject({ returns: { type: instance("krate::Handle") } });
  });
});

describe("extractRustExternalSignatures — a registry crate alone", () => {
  let table: RustExternalSignatureLookup;
  let data: RustExternalSignatureTableData;

  beforeAll(() => {
    data = extractRustExternalSignatures(crateSources("demo", DEMO), parse);
    table = new RustExternalSignatureLookup(data, "demo");
  });

  it("keys the crate's facade path and spells std references as absolute paths", () => {
    expect(data.paths["demo::client::Client"]).toBe("demo::Client");
    expect(table.inherentMember("demo::Client", "shared")).toEqual({
      returns: { type: instance("std::sync::Arc", instance("demo::Client")), genericParameters: [] },
      methodGenericParameters: [],
      selfKind: "ref",
      stable: true,
    });
    expect(table.inherentMember("demo::Client", "nickname")).toMatchObject({
      returns: { type: instance("std::option::Option", instance("std::string::String")) },
    });
    expect(table.inherentMember("demo::Client", "new")).toMatchObject({
      returns: { type: instance("Self") },
      selfKind: "none",
    });
    expect(table.inherentMember("demo::Client", "internal")).toBeUndefined();
    expect(table.field("demo::Client", "name")).toEqual({
      type: instance("std::string::String"),
      genericParameters: [],
    });
  });
});

function localRustLibrary(): string | undefined {
  try {
    const sysroot = execFileSync("rustc", ["--print", "sysroot"], { encoding: "utf8" }).trim();
    const library = join(sysroot, "lib/rustlib/src/rust/library");
    return existsSync(join(library, "std/src/lib.rs")) ? library : undefined;
  } catch {
    return undefined;
  }
}

const REAL_LIBRARY = localRustLibrary();

describe.skipIf(REAL_LIBRARY === undefined)("extractRustExternalSignatures — local rust-src smoke", () => {
  it("answers std::sync::Mutex::lock from the real library and keeps the sys decoys out", () => {
    const data = extractRustExternalSignatures(sysrootSources(REAL_LIBRARY as string), parse);
    const table = new RustExternalSignatureLookup(data, "real");
    const lock = table.inherentMember("std::sync::Mutex", "lock");
    expect(lock).toMatchObject({
      returns: { type: instance("std::sync::LockResult", instance("std::sync::MutexGuard", instance("T"))) },
      selfKind: "ref",
      stable: true,
    });
    expect(Object.keys(data.types).filter((path) => path.startsWith("std::sys::"))).toEqual([]);
    expect(table.canonicalType("Vec", [])).toBe("std::vec::Vec");
  }, 120_000);
});
