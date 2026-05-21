import { describe, expect, it } from "vitest";

import type { CallContext } from "../../../../../../../../src/core/contracts/types/codegraph.js";
import { RustCallResolver } from "../../../../../../../../src/core/domains/trajectory/codegraph/symbols/resolvers/rust/rust-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function ctx(
  callerFile: string,
  imports: { importText: string; startLine: number }[],
  table: InMemoryGlobalSymbolTable,
): CallContext {
  return { callerFile, callerScope: [], imports, symbolTable: table };
}

describe("RustCallResolver", () => {
  it("resolves `bar::baz` when import is `crate::foo::bar`", () => {
    const r = new RustCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("src/foo/bar.rs", [
      { symbolId: "baz", fqName: "baz", shortName: "baz", relPath: "src/foo/bar.rs", scope: [] },
    ]);
    const target = r.resolve(
      { callText: "bar::baz()", receiver: "bar", member: "baz", startLine: 1 },
      ctx("src/main.rs", [{ importText: "crate::foo::bar", startLine: 1 }], t),
    );
    expect(target?.targetRelPath).toBe("src/foo/bar.rs");
  });

  it("resolves super:: imports the same way as crate::", () => {
    const r = new RustCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("src/foo.rs", [
      { symbolId: "bar", fqName: "bar", shortName: "bar", relPath: "src/foo.rs", scope: [] },
    ]);
    const target = r.resolve(
      { callText: "foo::bar()", receiver: "foo", member: "bar", startLine: 1 },
      ctx("src/sub/x.rs", [{ importText: "super::foo", startLine: 1 }], t),
    );
    expect(target?.targetRelPath).toBe("src/foo.rs");
  });

  it("falls back to global short-name lookup", () => {
    const r = new RustCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("helpers.rs", [
      { symbolId: "util", fqName: "util", shortName: "util", relPath: "helpers.rs", scope: [] },
    ]);
    const target = r.resolve(
      { callText: "util()", receiver: null, member: "util", startLine: 1 },
      ctx("main.rs", [], t),
    );
    expect(target?.targetRelPath).toBe("helpers.rs");
  });

  it("returns null when no resolution path matches", () => {
    const r = new RustCallResolver();
    const target = r.resolve(
      { callText: "ghost()", receiver: null, member: "ghost", startLine: 1 },
      ctx("main.rs", [], new InMemoryGlobalSymbolTable()),
    );
    expect(target).toBeNull();
  });

  // Group import `use foo::{a, b};` — receiver `a` or `b` must match the
  // group, and the resolver must reduce the suffix to `foo/` (dropping the
  // braced segment). Drives the `last.startsWith("{")` branch in both
  // rustImportMatchesReceiver (inner.split callback) and rustImportSuffix.
  it("resolves group import `use foo::{bar, baz}` to a file ending in foo/bar.rs", () => {
    const r = new RustCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("crate/foo/bar.rs", [
      { symbolId: "bar", fqName: "bar", shortName: "bar", relPath: "crate/foo/bar.rs", scope: [] },
    ]);
    const target = r.resolve(
      { callText: "bar()", receiver: "bar", member: "bar", startLine: 1 },
      ctx("crate/main.rs", [{ importText: "crate::foo::{bar, baz}", startLine: 1 }], t),
    );
    expect(target?.targetRelPath).toBe("crate/foo/bar.rs");
  });

  // Receiver that doesn't appear in the braced group must fall through to
  // the global short-name fallback — verifies the negative case of the
  // `inner.includes(receiver)` branch.
  it("group import does NOT match a receiver outside the braces", () => {
    const r = new RustCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    // No matching symbol — explicit null return path.
    const target = r.resolve(
      { callText: "qux()", receiver: "qux", member: "qux", startLine: 1 },
      ctx("crate/main.rs", [{ importText: "crate::foo::{bar, baz}", startLine: 1 }], t),
    );
    expect(target).toBeNull();
  });

  // Resolver accepts both `<path>.rs` AND `<path>/mod.rs` for module-style
  // layouts. Covers the OR branch in the `.endsWith` filter.
  it("resolves to <module>/mod.rs when bare .rs path is absent", () => {
    const r = new RustCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("src/foo/bar/mod.rs", [
      { symbolId: "baz", fqName: "baz", shortName: "baz", relPath: "src/foo/bar/mod.rs", scope: [] },
    ]);
    const target = r.resolve(
      { callText: "bar::baz()", receiver: "bar", member: "baz", startLine: 1 },
      ctx("src/main.rs", [{ importText: "crate::foo::bar", startLine: 1 }], t),
    );
    expect(target?.targetRelPath).toBe("src/foo/bar/mod.rs");
  });
});
