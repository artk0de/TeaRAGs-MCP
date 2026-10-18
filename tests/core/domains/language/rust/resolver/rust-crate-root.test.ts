import { describe, expect, it } from "vitest";

import type { CallContext } from "../../../../../../src/core/contracts/types/codegraph.js";
import { RustCallResolver } from "../../../../../../src/core/domains/language/rust/resolver/rust-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function ctx(
  callerFile: string,
  imports: { importText: string; startLine: number }[],
  table: InMemoryGlobalSymbolTable,
): CallContext {
  return { callerFile, callerScope: [], imports, symbolTable: table };
}

function def(t: InMemoryGlobalSymbolTable, relPath: string, name: string, fq = name, scope: string[] = []): void {
  t.upsertFile(relPath, [{ symbolId: fq, fqName: fq, shortName: name, relPath, scope }]);
}

describe("Rust crate:: import roots inferred from the symbol table", () => {
  it("roots crate:: at the main.rs-marked crate in a src-less layout", () => {
    const r = new RustCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    def(t, "crates/core/main.rs", "main");
    def(t, "crates/core/flags/parse.rs", "Parser");
    def(t, "crates/core/flags/parse.rs", "new", "Parser.new", ["Parser"]);
    const target = r.resolve(
      { callText: "Parser::new()", receiver: "Parser", member: "new", startLine: 7 },
      ctx("crates/core/flags/defs.rs", [{ importText: "crate::flags::parse::Parser", startLine: 1 }], t),
    );
    expect(target?.targetRelPath).toBe("crates/core/flags/parse.rs");
  });

  it("roots crate:: at the lib.rs-marked crate in a components layout", () => {
    const r = new RustCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    def(t, "components/script/lib.rs", "script_lib");
    def(t, "components/script/dom/node.rs", "walk");
    const target = r.resolve(
      { callText: "node::walk()", receiver: "node", member: "walk", startLine: 3 },
      ctx("components/script/dom/x.rs", [{ importText: "crate::dom::node", startLine: 1 }], t),
    );
    expect(target?.targetRelPath).toBe("components/script/dom/node.rs");
  });

  it("roots crate:: at the src tree when lib.rs lives in src/", () => {
    const r = new RustCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    def(t, "src/lib.rs", "tikv_lib");
    def(t, "src/server/y.rs", "start");
    const target = r.resolve(
      { callText: "y::start()", receiver: "y", member: "start", startLine: 9 },
      ctx("src/server/x.rs", [{ importText: "crate::server::y", startLine: 1 }], t),
    );
    expect(target?.targetRelPath).toBe("src/server/y.rs");
  });

  it("falls back to any ancestor hit when no crate marker is indexed", () => {
    const r = new RustCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    def(t, "core/flags/parse.rs", "Parser");
    def(t, "core/flags/parse.rs", "new", "Parser.new", ["Parser"]);
    const target = r.resolve(
      { callText: "Parser::new()", receiver: "Parser", member: "new", startLine: 7 },
      ctx("core/flags/defs.rs", [{ importText: "crate::flags::parse::Parser", startLine: 1 }], t),
    );
    expect(target?.targetRelPath).toBe("core/flags/parse.rs");
  });

  it("pins a crate:: import to the caller's own marked crate, never a sibling's namesake", () => {
    const r = new RustCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    def(t, "crates/x/main.rs", "x_main");
    def(t, "crates/y/main.rs", "y_main");
    def(t, "crates/x/flags/parse.rs", "Parser");
    def(t, "crates/y/flags/parse.rs", "Parser");
    def(t, "crates/x/flags/parse.rs", "new", "Parser.new", ["Parser"]);
    def(t, "crates/y/flags/parse.rs", "new", "Parser.new", ["Parser"]);
    const target = r.resolve(
      { callText: "Parser::new()", receiver: "Parser", member: "new", startLine: 7 },
      ctx("crates/x/flags/defs.rs", [{ importText: "crate::flags::parse::Parser", startLine: 1 }], t),
    );
    expect(target?.targetRelPath).toBe("crates/x/flags/parse.rs");
  });

  it("resolves a bare call bound by a direct import in a src-less layout", () => {
    const r = new RustCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    def(t, "crates/core/main.rs", "main");
    def(t, "crates/core/flags/parse.rs", "parse_low_raw");
    const target = r.resolve(
      { callText: "parse_low_raw(args)", receiver: null, member: "parse_low_raw", startLine: 201 },
      ctx("crates/core/flags/defs.rs", [{ importText: "crate::flags::parse::parse_low_raw", startLine: 35 }], t),
    );
    expect(target?.targetRelPath).toBe("crates/core/flags/parse.rs");
  });
});
