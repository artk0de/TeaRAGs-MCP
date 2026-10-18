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

function def(t: InMemoryGlobalSymbolTable, relPath: string, name: string, symbolId = name): void {
  t.upsertFile(relPath, [{ symbolId, fqName: name, shortName: name, relPath, scope: [] }]);
}

describe("Rust resolver — import-bound bare calls and external classification", () => {
  it("classifies a call on a literal receiver external when the member has no project definition", () => {
    const r = new RustCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    // A primitive can only carry a std inherent or std trait method unless the
    // project implements a trait for it — and that trait method would BE an
    // in-project definition, which vetoes the std reading.
    const call = { callText: "10.into()", receiver: "10", member: "into", startLine: 1 };
    expect(r.targetsExternalImport?.(call, ctx("src/main.rs", [], t))).toBe(true);
  });

  it("keeps a literal receiver's call in-project when the member is declared in the project", () => {
    const r = new RustCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    def(t, "src/numeric.rs", "step", "MySteps::step");
    const call = { callText: "10.step()", receiver: "10", member: "step", startLine: 1 };
    expect(r.targetsExternalImport?.(call, ctx("src/main.rs", [], t))).toBe(false);
  });

  it("resolves a bare call bound by a direct crate import against the imported file", () => {
    const r = new RustCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    def(t, "src/flags/parse.rs", "parse_low_raw");
    const target = r.resolve(
      { callText: "parse_low_raw(args)", receiver: null, member: "parse_low_raw", startLine: 201 },
      ctx("src/flags/defs.rs", [{ importText: "crate::flags::parse::parse_low_raw", startLine: 35 }], t),
    );
    expect(target?.targetRelPath).toBe("src/flags/parse.rs");
    expect(target?.targetSymbolId).toBe("parse_low_raw");
  });

  it("resolves a bare call bound by a self/super import the same way", () => {
    const r = new RustCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    def(t, "src/flags/parse.rs", "parse_low_raw");
    const target = r.resolve(
      { callText: "parse_low_raw(args)", receiver: null, member: "parse_low_raw", startLine: 201 },
      ctx("src/flags/mod.rs", [{ importText: "self::parse::parse_low_raw", startLine: 35 }], t),
    );
    expect(target?.targetRelPath).toBe("src/flags/parse.rs");
  });

  it("answers hasInProjectDefinition for rust files only — a foreign namesake is no candidate", () => {
    const r = new RustCallResolver();
    const rust = new InMemoryGlobalSymbolTable();
    def(rust, "helpers.rs", "util");
    const foreign = new InMemoryGlobalSymbolTable();
    def(foreign, "paginator.py", "range");

    expect(
      r.hasInProjectDefinition?.(
        { callText: "util()", receiver: null, member: "util", startLine: 1 },
        ctx("main.rs", [], rust),
      ),
    ).toBe(true);
    expect(
      r.hasInProjectDefinition?.(
        { callText: "range(x)", receiver: null, member: "range", startLine: 1 },
        ctx("main.rs", [], foreign),
      ),
    ).toBe(false);
  });

  it("classifies a std macro invocation with no project definition as external", () => {
    const r = new RustCallResolver();
    expect(
      r.targetsExternalImport?.(
        { callText: "vec![]", receiver: null, member: "vec", startLine: 1 },
        ctx("main.rs", [], new InMemoryGlobalSymbolTable()),
      ),
    ).toBe(true);
  });

  it("keeps a macro name the project defines in the denominator", () => {
    const r = new RustCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    def(t, "src/macros.rs", "format");
    expect(
      r.targetsExternalImport?.(
        { callText: 'format!("{}", x)', receiver: null, member: "format", startLine: 9 },
        ctx("main.rs", [], t),
      ),
    ).toBe(false);
  });

  it("classifies a std prelude type receiver as external when no project namesake exists", () => {
    const r = new RustCallResolver();
    expect(
      r.targetsExternalImport?.(
        { callText: "String::new()", receiver: "String", member: "new", startLine: 3 },
        ctx("main.rs", [], new InMemoryGlobalSymbolTable()),
      ),
    ).toBe(true);
  });

  it("keeps a project type that shares a prelude name in the denominator", () => {
    const r = new RustCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    def(t, "src/writer.rs", "String");
    expect(
      r.targetsExternalImport?.(
        { callText: "String::new()", receiver: "String", member: "new", startLine: 3 },
        ctx("main.rs", [], t),
      ),
    ).toBe(false);
  });

  it("classifies a receiver bound by an external-crate import as external", () => {
    const r = new RustCallResolver();
    expect(
      r.targetsExternalImport?.(
        { callText: "SearcherBuilder::new()", receiver: "SearcherBuilder", member: "new", startLine: 7 },
        ctx(
          "src/main.rs",
          [{ importText: "grep_searcher::SearcherBuilder", startLine: 1 }],
          new InMemoryGlobalSymbolTable(),
        ),
      ),
    ).toBe(true);
  });

  it("does not classify a project-bound receiver import as external", () => {
    const r = new RustCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    def(t, "src/flags/parse.rs", "Parser");
    expect(
      r.targetsExternalImport?.(
        { callText: "Parser::new()", receiver: "Parser", member: "new", startLine: 7 },
        ctx("src/flags/defs.rs", [{ importText: "crate::flags::parse::Parser", startLine: 1 }], t),
      ),
    ).toBe(false);
  });

  it("classifies a bare call bound by an external import as external", () => {
    const r = new RustCallResolver();
    expect(
      r.targetsExternalImport?.(
        { callText: 'from_str("{}")', receiver: null, member: "from_str", startLine: 12 },
        ctx("src/main.rs", [{ importText: "serde_json::from_str", startLine: 1 }], new InMemoryGlobalSymbolTable()),
      ),
    ).toBe(true);
  });

  it("never classifies an unbound undeclared bare call as external — absence is not proof", () => {
    const r = new RustCallResolver();
    expect(
      r.targetsExternalImport?.(
        { callText: "frobnicate()", receiver: null, member: "frobnicate", startLine: 12 },
        ctx("main.rs", [], new InMemoryGlobalSymbolTable()),
      ),
    ).toBe(false);
  });

  it("does not let a foreign namesake trip or block the short-name fallback", () => {
    const r = new RustCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    def(t, "paginator.py", "util");
    def(t, "helpers.rs", "util");
    const target = r.resolve(
      { callText: "util()", receiver: null, member: "util", startLine: 1 },
      ctx("main.rs", [], t),
    );
    expect(target?.targetRelPath).toBe("helpers.rs");
  });
});
