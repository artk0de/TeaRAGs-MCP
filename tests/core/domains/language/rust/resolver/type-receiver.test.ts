/**
 * bd tea-rags-mcp-7266 — a call whose receiver statically NAMES a type:
 *
 *   - a type path `Parser::new()` / `Self::helper()` — the receiver IS the type;
 *   - a constructor's result `Parser::new().parse(args)` — the receiver is the
 *     value an associated constructor (`new` / `from` / `default` / `with_*`)
 *     returns, the same heuristic that already types `let p = Parser::new();`,
 *     and it holds for ripgrep's `fn new() -> &'static Parser` because the
 *     heuristic never reads the declared return type.
 *
 * Before this pass neither reached the type: `Parser::new()` went to the global
 * short-name fallback, which drops on the dozens of `new` defs a crate carries
 * (ripgrep: `constant` receivers resolved 125 of 1389), and an in-project type
 * without the member (`LowArgs::default()` — derived `Default`) was handed to
 * an unrelated sole `default` def in another file.
 */
import { describe, expect, it } from "vitest";

import type { CallContext, CallRef, SymbolDefinition } from "../../../../../../src/core/contracts/types/codegraph.js";
import { RustCallResolver } from "../../../../../../src/core/domains/language/rust/resolver/rust-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const PARSE = "crates/core/flags/parse.rs";
const GLOB = "crates/globset/src/glob.rs";

const sym = (symbolId: string, relPath: string, scope: string[] = []): SymbolDefinition => ({
  symbolId,
  fqName: symbolId,
  shortName: symbolId.split(/#|\.|::/).pop() ?? symbolId,
  relPath,
  scope,
});

/** ripgrep's shape: `Parser` declared in two files, `new` declared on several types. */
function ripgrepTable(): InMemoryGlobalSymbolTable {
  const t = new InMemoryGlobalSymbolTable();
  t.upsertFile(PARSE, [
    sym("Parser", PARSE),
    sym("Parser.new", PARSE, ["Parser"]),
    sym("Parser#parse", PARSE, ["Parser"]),
    sym("FlagMap", PARSE),
    sym("FlagMap.new", PARSE, ["FlagMap"]),
    sym("LowArgs", PARSE),
    sym("parse_low", PARSE),
  ]);
  t.upsertFile(GLOB, [
    sym("Parser", GLOB),
    sym("Parser.new", GLOB, ["Parser"]),
    sym("Parser#parse", GLOB, ["Parser"]),
    sym("GlobOptions", GLOB),
    sym("GlobOptions.default", GLOB, ["GlobOptions"]),
  ]);
  t.upsertFile("crates/globset/src/lib.rs", [
    sym("GlobSetBuilder", "crates/globset/src/lib.rs"),
    sym("GlobSetBuilder.new", "crates/globset/src/lib.rs", ["GlobSetBuilder"]),
    sym("GlobSetBuilder#add", "crates/globset/src/lib.rs", ["GlobSetBuilder"]),
  ]);
  return t;
}

const call = (callText: string, receiver: string | null, member: string, startLine = 72): CallRef => ({
  callText,
  receiver,
  member,
  startLine,
});

const ctx = (over: Partial<CallContext> = {}): CallContext => ({
  callerFile: PARSE,
  callerScope: [],
  imports: [],
  symbolTable: ripgrepTable(),
  ...over,
});

describe("RustCallResolver — type-naming receivers (7266)", () => {
  const r = new RustCallResolver();

  it("resolves a type-path call `Parser::new()` to the same-file associated fn", () => {
    expect(r.resolve(call("Parser::new()", "Parser", "new", 70), ctx())).toEqual({
      targetRelPath: PARSE,
      targetSymbolId: "Parser.new",
    });
  });

  it("resolves a method on a constructor's result `Parser::new().parse(args)` (reference-returning ctor)", () => {
    expect(r.resolve(call("Parser::new().parse(rawargs, &mut args)", "Parser::new()", "parse", 143), ctx())).toEqual({
      targetRelPath: PARSE,
      targetSymbolId: "Parser#parse",
    });
  });

  it("resolves a type-path call to the one file that declares the type when the caller does not", () => {
    const target = r.resolve(
      call("GlobSetBuilder::new()", "GlobSetBuilder", "new", 56),
      ctx({
        callerFile: "crates/cli/src/decompress.rs",
        imports: [{ importText: "globset::{Glob, GlobSetBuilder}", startLine: 1 }],
      }),
    );
    expect(target).toEqual({ targetRelPath: "crates/globset/src/lib.rs", targetSymbolId: "GlobSetBuilder.new" });
  });

  it("resolves the first hop of a builder chain on another file's type", () => {
    const t = ripgrepTable();
    // A second `add` makes the short-name fallback ambiguous — only the type reaches it.
    t.upsertFile("crates/ignore/src/types.rs", [
      sym("TypesBuilder#add", "crates/ignore/src/types.rs", ["TypesBuilder"]),
    ]);
    const target = r.resolve(
      call("GlobSetBuilder::new().add(glob)", "GlobSetBuilder::new()", "add", 57),
      ctx({ callerFile: "crates/cli/src/decompress.rs", symbolTable: t }),
    );
    expect(target).toEqual({ targetRelPath: "crates/globset/src/lib.rs", targetSymbolId: "GlobSetBuilder#add" });
  });

  it("drops a member an in-project type does not declare instead of routing it to another type", () => {
    // `LowArgs` derives `Default`; the sole `default` def belongs to GlobOptions.
    expect(r.resolve(call("LowArgs::default()", "LowArgs", "default", 71), ctx())).toBeNull();
  });

  it("types `Self::helper()` as the enclosing impl type", () => {
    const t = ripgrepTable();
    t.upsertFile("src/worker.rs", [
      sym("Worker", "src/worker.rs"),
      sym("Worker.helper", "src/worker.rs", ["Worker"]),
      sym("Other.helper", "src/other.rs", ["Other"]),
    ]);
    const target = r.resolve(
      call("Self::helper()", "Self", "helper", 5),
      ctx({ callerFile: "src/worker.rs", callerScope: ["Worker"], symbolTable: t }),
    );
    expect(target).toEqual({ targetRelPath: "src/worker.rs", targetSymbolId: "Worker.helper" });
  });

  it("reaches a type declared inside a module (`mod flags { struct Parser }`)", () => {
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("src/lib.rs", [
      sym("flags", "src/lib.rs"),
      sym("flags::Config", "src/lib.rs", ["flags"]),
      sym("flags::Config.load", "src/lib.rs", ["flags", "Config"]),
      sym("Other.load", "src/other.rs", ["Other"]),
    ]);
    expect(
      r.resolve(call("Config::load()", "Config", "load", 9), ctx({ callerFile: "src/lib.rs", symbolTable: t })),
    ).toEqual({
      targetRelPath: "src/lib.rs",
      targetSymbolId: "flags::Config.load",
    });
  });

  it("leaves a type the project does not declare to the later passes", () => {
    const t = ripgrepTable();
    t.upsertFile("src/cmd.rs", [sym("spawn_all", "src/cmd.rs")]);
    // `Command` is std's; the sole in-project `spawn_all` must still resolve by short name.
    expect(r.resolve(call("Command::spawn_all()", "Command", "spawn_all", 3), ctx({ symbolTable: t }))).toEqual({
      targetRelPath: "src/cmd.rs",
      targetSymbolId: "spawn_all",
    });
  });

  it("leaves a std type that shadows an in-project type name to the later passes", () => {
    const t = ripgrepTable();
    t.upsertFile("src/error.rs", [sym("Error", "src/error.rs"), sym("Error.new", "src/error.rs", ["Error"])]);
    // `use std::io::Error;` binds `Error` to std — the project's Error is not the receiver.
    const target = r.resolve(
      call("Error::new(kind, msg)", "Error", "new", 12),
      ctx({ callerFile: "src/io.rs", imports: [{ importText: "std::io::Error", startLine: 1 }], symbolTable: t }),
    );
    expect(target?.targetSymbolId).not.toBe("Error.new");
  });

  it("never answers with a namesake from another language", () => {
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("src/config.rs", [sym("Config", "src/config.rs")]);
    // A TypeScript static spells `Config.load` exactly like a Rust associated fn.
    t.upsertFile("web/config.ts", [sym("Config", "web/config.ts"), sym("Config.load", "web/config.ts", ["Config"])]);
    expect(
      r.resolve(call("Config::load()", "Config", "load", 3), ctx({ callerFile: "src/main.rs", symbolTable: t })),
    ).toBeNull();
  });

  it("does not treat a value receiver spelled in CapWords (`P.get()`) as a type path", () => {
    const t = ripgrepTable();
    t.upsertFile("src/p.rs", [sym("P", "src/p.rs"), sym("get_or_init", "src/lazy.rs")]);
    // `P` is a `static`; the call is a method on the value, not `P::get_or_init`.
    expect(r.resolve(call("P.get_or_init(f)", "P", "get_or_init", 4), ctx({ symbolTable: t }))).toEqual({
      targetRelPath: "src/lazy.rs",
      targetSymbolId: "get_or_init",
    });
  });
});
