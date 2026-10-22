import { describe, expect, it } from "vitest";

import type { TypeDeclarationFact } from "../../../../../../src/core/contracts/types/codegraph-extraction.js";
import type { SymbolDefinitionKind } from "../../../../../../src/core/contracts/types/codegraph-symbols.js";
import type { CallContext, LocalBinding } from "../../../../../../src/core/contracts/types/codegraph.js";
import { RustCallResolver } from "../../../../../../src/core/domains/language/rust/resolver/rust-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

// bd tea-rags-mcp-s3i8m.3 — a receiver or path whose type is a std/core/alloc
// type leaves the denominator through the external channel unless the project
// itself defines the member on that type (an extension trait impl) or on a
// trait / blanket owner the std type could reach; a project type's derived
// std-trait member (no hand-written body anywhere) is generated code.

interface Def {
  relPath: string;
  symbolId: string;
  kind?: SymbolDefinitionKind;
}

function table(defs: Def[]): InMemoryGlobalSymbolTable {
  const t = new InMemoryGlobalSymbolTable();
  const byFile = new Map<string, Def[]>();
  for (const d of defs) byFile.set(d.relPath, [...(byFile.get(d.relPath) ?? []), d]);
  for (const [relPath, fileDefs] of byFile) {
    t.upsertFile(
      relPath,
      fileDefs.map((d) => {
        const path = d.symbolId.split(/::|#|\./);
        const shortName = path.at(-1) ?? d.symbolId;
        return {
          symbolId: d.symbolId,
          fqName: d.symbolId,
          shortName,
          relPath,
          scope: path.slice(0, -1),
          ...(d.kind === undefined ? {} : { symbolKind: d.kind }),
        };
      }),
    );
  }
  return t;
}

function fact(typeId: string, symbolKind: SymbolDefinitionKind = "class"): TypeDeclarationFact {
  return { typeId, symbolKind, line: 1, reopens: false };
}

function ctx(
  t: InMemoryGlobalSymbolTable,
  opts: {
    imports?: string[];
    bindings?: Record<string, LocalBinding[]>;
    typeDeclarations?: Record<string, readonly TypeDeclarationFact[]>;
    callerFile?: string;
    callerScope?: string[];
  } = {},
): CallContext {
  return {
    callerFile: opts.callerFile ?? "src/main.rs",
    callerScope: opts.callerScope ?? [],
    imports: (opts.imports ?? []).map((importText) => ({ importText, startLine: 1 })),
    symbolTable: t,
    ...(opts.bindings === undefined ? {} : { localBindings: opts.bindings }),
    ...(opts.typeDeclarations === undefined ? {} : { typeDeclarations: opts.typeDeclarations }),
  };
}

function call(callText: string, receiver: string | null, member: string, startLine = 10) {
  return { callText, receiver, member, startLine };
}

const r = new RustCallResolver();

describe("Rust std terminal classification — nested use trees", () => {
  const projectNew = table([{ relPath: "src/parser.rs", symbolId: "Parser.new" }]);

  it("reads a module bound inside a nested std group as std", () => {
    const c = ctx(projectNew, { imports: ["std::{\n    ffi::{OsStr, OsString},\n    io,\n    path::Path,\n}"] });
    expect(r.targetsExternalImport?.(call("io::Error::new(k, e)", "io::Error", "new"), c)).toBe(true);
  });

  it("reads a leading-brace group binding by binding — walkdir is external, crate is not", () => {
    const c = ctx(projectNew, { imports: ["{\n    same_file::Handle,\n    walkdir::WalkDir,\n}"] });
    expect(r.targetsExternalImport?.(call("WalkDir::new(p)", "WalkDir", "new"), c)).toBe(true);
  });

  it("reads `self` inside a group as the module binding", () => {
    const c = ctx(projectNew, {
      imports: ["{\n    grep_matcher::LineTerminator,\n    regex_syntax::hir::{self, Hir},\n}"],
    });
    expect(r.targetsExternalImport?.(call("hir::ClassBytes::new(x)", "hir::ClassBytes", "new"), c)).toBe(true);
  });

  it("resolves a bare call bound through a nested crate group to the imported file", () => {
    const t = table([
      { relPath: "src/flags/parse.rs", symbolId: "parse_low_raw" },
      { relPath: "src/other.rs", symbolId: "parse_low_raw" },
    ]);
    const c = ctx(t, { imports: ["crate::{\n    flags::{parse::parse_low_raw, defs},\n    other,\n}"] });
    const target = r.resolve(call("parse_low_raw(args)", null, "parse_low_raw"), c);
    expect(target?.targetRelPath).toBe("src/flags/parse.rs");
  });

  it("resolves an item a group imports from `super` — the inline test module's own file", () => {
    const t = table([{ relPath: "crates/cli/src/escape.rs", symbolId: "unescape" }]);
    const c = ctx(t, { callerFile: "crates/cli/src/escape.rs", imports: ["super::{escape, unescape}"] });
    expect(r.resolve(call("unescape(s)", null, "unescape"), c)?.targetRelPath).toBe("crates/cli/src/escape.rs");
  });

  it("lets a workspace-crate module import the path map cannot place fall to the later passes", () => {
    const t = table([
      { relPath: "crates/grep/src/lib.rs", symbolId: "grep_entry" },
      { relPath: "crates/cli/src/pattern.rs", symbolId: "pattern_from_os" },
    ]);
    const c = ctx(t, { callerFile: "crates/grep/examples/simplegrep.rs", imports: ["grep::{cli, printer}"] });
    expect(r.resolve(call("cli::pattern_from_os(a)", "cli", "pattern_from_os"), c)?.targetRelPath).toBe(
      "crates/cli/src/pattern.rs",
    );
  });
});

describe("Rust std terminal classification — std paths and std-typed receivers", () => {
  const projectMembers = table([
    { relPath: "src/a.rs", symbolId: "Thing", kind: "class" },
    { relPath: "src/a.rs", symbolId: "Thing.from", kind: "method" },
    { relPath: "src/a.rs", symbolId: "Thing.current_dir", kind: "method" },
    { relPath: "src/a.rs", symbolId: "Thing#is_none", kind: "method" },
    { relPath: "src/a.rs", symbolId: "Thing#len", kind: "method" },
  ]);
  const thingDecl = { "src/a.rs": [fact("Thing")] };

  it("classifies a fully qualified std path call external", () => {
    const c = ctx(projectMembers, { typeDeclarations: thingDecl });
    expect(r.targetsExternalImport?.(call("std::path::PathBuf::from(x)", "std::path::PathBuf", "from"), c)).toBe(true);
    expect(r.targetsExternalImport?.(call("std::env::current_dir()", "std::env", "current_dir"), c)).toBe(true);
  });

  it("does not let a project struct sharing a std type's name veto its fully qualified std path", () => {
    const t = table([
      { relPath: "src/error.rs", symbolId: "Error", kind: "class" },
      { relPath: "src/error.rs", symbolId: "Error.new", kind: "method" },
    ]);
    const c = ctx(t, { typeDeclarations: { "src/error.rs": [fact("Error")] } });
    expect(r.targetsExternalImport?.(call("std::io::Error::new(k, e)", "std::io::Error", "new"), c)).toBe(true);
  });

  it("classifies a receiver bound to Option external when only a project struct shares the member", () => {
    const c = ctx(projectMembers, {
      typeDeclarations: thingDecl,
      bindings: { res: [{ line: 1, type: "Option" }] },
    });
    expect(r.targetsExternalImport?.(call("res.is_none()", "res", "is_none"), c)).toBe(true);
  });

  it("classifies a primitive-typed receiver external (`lib: &str`)", () => {
    const c = ctx(projectMembers, { typeDeclarations: thingDecl, bindings: { lib: [{ line: 1, type: "str" }] } });
    expect(r.targetsExternalImport?.(call("lib.len()", "lib", "len"), c)).toBe(true);
  });

  it("classifies Box<String> external but leaves Box<ProjectType> to the deref reading", () => {
    const boxed = (arg: string): LocalBinding => ({
      line: 1,
      type: "Box",
      typeRef: { form: "instance", name: "Box", args: [{ form: "instance", name: arg }] },
    });
    const std = ctx(projectMembers, { typeDeclarations: thingDecl, bindings: { b: [boxed("String")] } });
    expect(r.targetsExternalImport?.(call("b.len()", "b", "len"), std)).toBe(true);
    const own = ctx(projectMembers, { typeDeclarations: thingDecl, bindings: { b: [boxed("Thing")] } });
    expect(r.targetsExternalImport?.(call("b.len()", "b", "len"), own)).toBe(false);
  });

  it("does not let an impl block for Box shadow std Box", () => {
    const t = table([
      { relPath: "src/sink.rs", symbolId: "Box" },
      { relPath: "src/sink.rs", symbolId: "Box#finish", kind: "method" },
      { relPath: "src/parser.rs", symbolId: "Parser", kind: "class" },
      { relPath: "src/parser.rs", symbolId: "Parser.new", kind: "method" },
    ]);
    const c = ctx(t, { typeDeclarations: { "src/sink.rs": [], "src/parser.rs": [fact("Parser")] } });
    expect(r.targetsExternalImport?.(call("Box::new(x)", "Box", "new"), c)).toBe(true);
  });

  it("keeps a project struct that shadows a std name in the denominator", () => {
    const t = table([
      { relPath: "src/vec.rs", symbolId: "Vec", kind: "class" },
      { relPath: "src/other.rs", symbolId: "Other.new", kind: "method" },
    ]);
    const c = ctx(t, { typeDeclarations: { "src/vec.rs": [fact("Vec")] } });
    expect(r.targetsExternalImport?.(call("Vec::new()", "Vec", "new"), c)).toBe(false);
  });
});

describe("Rust std terminal classification — precision guards", () => {
  it("keeps an extension-trait member the project implements for Vec in-project", () => {
    const t = table([
      { relPath: "src/ext.rs", symbolId: "Vec" },
      { relPath: "src/ext.rs", symbolId: "Vec#hexify", kind: "method" },
      { relPath: "src/ext.rs", symbolId: "Vec.from_hex", kind: "method" },
    ]);
    const c = ctx(t, { typeDeclarations: { "src/ext.rs": [] }, bindings: { v: [{ line: 1, type: "Vec" }] } });
    expect(r.targetsExternalImport?.(call("v.hexify()", "v", "hexify"), c)).toBe(false);
    expect(r.resolve(call("v.hexify()", "v", "hexify"), c)?.targetSymbolId).toBe("Vec#hexify");
    expect(r.targetsExternalImport?.(call("Vec::from_hex(s)", "Vec", "from_hex"), c)).toBe(false);
    expect(r.resolve(call("Vec::from_hex(s)", "Vec", "from_hex"), c)?.targetSymbolId).toBe("Vec.from_hex");
  });

  it("keeps a member a project trait declares — a trait impl for the std type may provide it", () => {
    const t = table([
      { relPath: "src/ext.rs", symbolId: "ByteExt", kind: "interface" },
      { relPath: "src/ext.rs", symbolId: "ByteExt#find_byte", kind: "method" },
    ]);
    const c = ctx(t, {
      typeDeclarations: { "src/ext.rs": [fact("ByteExt", "interface")] },
      bindings: { bytes: [{ line: 1, type: "[u8]" }] },
    });
    expect(r.targetsExternalImport?.(call("bytes.find_byte(b)", "bytes", "find_byte"), c)).toBe(false);
  });

  it("keeps a member a blanket impl owns — its owner is no declared project type", () => {
    const t = table([{ relPath: "src/ext.rs", symbolId: "T#describe", kind: "method" }]);
    const c = ctx(t, { typeDeclarations: { "src/ext.rs": [] }, bindings: { s: [{ line: 1, type: "String" }] } });
    expect(r.targetsExternalImport?.(call("s.describe()", "s", "describe"), c)).toBe(false);
  });
});

describe("Rust concrete project type — derived std-trait members", () => {
  const t = table([
    { relPath: "src/region.rs", symbolId: "Region", kind: "class" },
    { relPath: "src/region.rs", symbolId: "Region.new", kind: "method" },
    { relPath: "src/other.rs", symbolId: "Other", kind: "class" },
    { relPath: "src/other.rs", symbolId: "Other.default", kind: "method" },
    { relPath: "src/other.rs", symbolId: "Other#clone", kind: "method" },
  ]);
  const decls = { "src/region.rs": [fact("Region")], "src/other.rs": [fact("Other")] };

  it("classifies a derived Default with no hand-written body external, never a guess", () => {
    const c = ctx(t, { typeDeclarations: decls });
    const site = call("Region::default()", "Region", "default");
    expect(r.resolve(site, c)).toBeNull();
    expect(r.targetsExternalImport?.(site, c)).toBe(true);
  });

  it("classifies a derived Clone on a concretely typed receiver external", () => {
    const c = ctx(t, { typeDeclarations: decls, bindings: { cfg: [{ line: 1, type: "Region" }] } });
    const site = call("cfg.clone()", "cfg", "clone");
    expect(r.resolve(site, c)).toBeNull();
    expect(r.targetsExternalImport?.(site, c)).toBe(true);
  });

  it("resolves a hand-written impl declared in another file than the type", () => {
    const split = table([
      { relPath: "src/region.rs", symbolId: "Region", kind: "class" },
      { relPath: "src/region/default.rs", symbolId: "Region.default", kind: "method" },
      { relPath: "src/other.rs", symbolId: "Other.default", kind: "method" },
    ]);
    const c = ctx(split, { typeDeclarations: { "src/region.rs": [fact("Region")] } });
    expect(r.resolve(call("Region::default()", "Region", "default"), c)?.targetRelPath).toBe("src/region/default.rs");
  });

  it("keeps a non-trait member the type misses in the denominator", () => {
    const c = ctx(t, { typeDeclarations: decls });
    expect(r.targetsExternalImport?.(call("Region::frobnicate()", "Region", "frobnicate"), c)).toBe(false);
  });
});
