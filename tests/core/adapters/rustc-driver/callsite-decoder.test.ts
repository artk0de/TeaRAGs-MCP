import { describe, expect, it } from "vitest";

import { decodeRustcCallSites } from "../../../../src/core/adapters/rustc-driver/callsite-decoder.js";

interface Row {
  relPath: string;
  line: number;
  col: number;
  origin: "source" | "macro";
  macro: string | null;
  callKind: "method" | "path";
  callee: string;
  calleeCrate: string;
  defKind: string;
  traitPath: string | null;
  implSelfType: string | null;
  resolvedImpl: string | null;
  implIsDerived: boolean;
  inProject: boolean;
  defRelPath: string | null;
  defLine: number | null;
}

const row = (over: Partial<Row>): string =>
  JSON.stringify({
    relPath: "src/main.rs",
    line: 10,
    col: 8,
    origin: "source",
    macro: null,
    callKind: "method",
    callee: "fx_core::Store::get",
    calleeCrate: "fx_core",
    defKind: "assocFn",
    traitPath: null,
    implSelfType: null,
    resolvedImpl: null,
    implIsDerived: false,
    inProject: true,
    defRelPath: "src/store.rs",
    defLine: 3,
    ...over,
  });

const decode = (...lines: string[]) => decodeRustcCallSites([lines.join("\n")], "id-1");

describe("decodeRustcCallSites", () => {
  it("exposes the caller-supplied identity", () => {
    expect(decode().identity).toBe("id-1");
  });

  it("maps an in-project inherent method", () => {
    const index = decode(row({ callee: "fx_core::MemStore::put", implSelfType: "fx_core::MemStore" }));
    expect(index.definitionAt("src/main.rs", 10, 8)).toEqual({
      symbol: "rustc fx_core fx_core::MemStore::put",
      package: "fx_core",
      inProject: true,
      relPath: "src/store.rs",
      line: 3,
      name: "put",
      kind: "callable",
      packageInProject: true,
    });
  });

  it("maps an inherent associated fn called through a path", () => {
    const index = decode(
      row({ callKind: "path", callee: "fx_core::Config::<T>::new", defKind: "assocFn", implSelfType: "Config<T>" }),
    );
    const def = index.definitionAt("src/main.rs", 10, 8);
    expect(def).toMatchObject({ name: "new", kind: "callable", inProject: true });
    expect(def?.implTrait).toBeUndefined();
    expect(def?.declaringTrait).toBeUndefined();
  });

  it("maps an external std method as not in project", () => {
    const index = decode(
      row({
        callee: "std::result::Result::<T, E>::unwrap",
        calleeCrate: "std",
        inProject: false,
        defRelPath: null,
        defLine: null,
        implSelfType: "Result<T, E>",
      }),
    );
    const def = index.definitionAt("src/main.rs", 10, 8);
    expect(def).toEqual({
      symbol: "rustc std std::result::Result::<T, E>::unwrap",
      package: "std",
      inProject: false,
      name: "unwrap",
      kind: "callable",
      packageInProject: false,
    });
  });

  it("maps a trait method resolved to an impl with implTrait", () => {
    const index = decode(
      row({
        traitPath: "fx_core::Store",
        resolvedImpl: "<fx_core::MemStore as fx_core::Store>::get",
        defRelPath: "src/mem.rs",
        defLine: 21,
      }),
    );
    expect(index.definitionAt("src/main.rs", 10, 8)).toMatchObject({
      symbol: "rustc fx_core <fx_core::MemStore as fx_core::Store>::get",
      implTrait: "Store",
      inProject: true,
      relPath: "src/mem.rs",
      line: 21,
      name: "get",
    });
    expect(index.definitionAt("src/main.rs", 10, 8)?.declaringTrait).toBeUndefined();
  });

  it("maps a trait declaration (dyn or generic bound) with declaringTrait", () => {
    const index = decode(row({ traitPath: "fx_core::Store", resolvedImpl: null }));
    const def = index.definitionAt("src/main.rs", 10, 8);
    expect(def).toMatchObject({ declaringTrait: "Store", inProject: true, relPath: "src/store.rs", line: 3 });
    expect(def?.implTrait).toBeUndefined();
  });

  it("answers a derived impl as not in project while the package stays a workspace crate", () => {
    const index = decode(
      row({
        callee: "std::clone::Clone::clone",
        calleeCrate: "core",
        traitPath: "std::clone::Clone",
        resolvedImpl: "<fx_core::Point as std::clone::Clone>::clone",
        implIsDerived: true,
        inProject: true,
        defRelPath: "src/point.rs",
        defLine: 4,
      }),
      row({ line: 11, calleeCrate: "core" }),
    );
    const def = index.definitionAt("src/main.rs", 10, 8);
    expect(def).toMatchObject({ inProject: false, implTrait: "Clone", package: "core" });
    expect(def?.relPath).toBeUndefined();
    expect(def?.line).toBeUndefined();
    expect(def?.packageInProject).toBe(true);
  });

  it("maps ctor to type and other defKinds to other", () => {
    const index = decode(
      row({ col: 1, defKind: "ctor", callKind: "path", callee: "std::option::Option::<T>::Some" }),
      row({ col: 2, defKind: "const" }),
    );
    expect(index.definitionAt("src/main.rs", 10, 1)).toMatchObject({ kind: "type", name: "Some" });
    expect(index.definitionAt("src/main.rs", 10, 2)?.kind).toBe("other");
  });

  it("derives packageInProject from workspace crates passed by the runner", () => {
    const text = row({ calleeCrate: "dep", inProject: false, defRelPath: null, defLine: null });
    const without = decodeRustcCallSites([text], "i");
    const withCrates = decodeRustcCallSites([text], "i", { workspaceCrates: ["dep"] });
    expect(without.definitionAt("src/main.rs", 10, 8)?.packageInProject).toBe(false);
    expect(withCrates.definitionAt("src/main.rs", 10, 8)?.packageInProject).toBe(true);
  });

  it("never serves origin macro rows", () => {
    const index = decode(row({ origin: "macro", macro: "vec" }));
    expect(index.definitionAt("src/main.rs", 10, 8)).toBeNull();
  });

  it("dedupes identical rows from overlapping units", () => {
    const line = row({});
    const index = decodeRustcCallSites([line, `${line}\n${line}`], "i");
    expect(index.definitionAt("src/main.rs", 10, 8)).toMatchObject({ name: "get", inProject: true });
  });

  it("answers null when two different rows share one position", () => {
    const index = decode(row({ callee: "a::B::x" }), row({ callee: "a::C::x" }));
    expect(index.definitionAt("src/main.rs", 10, 8)).toBeNull();
  });

  it("answers null when rows with the same callee disagree on the resolution", () => {
    const index = decode(row({}), row({ resolvedImpl: "<a::B as fx_core::Store>::get", traitPath: "fx_core::Store" }));
    expect(index.definitionAt("src/main.rs", 10, 8)).toBeNull();
  });

  it("looks up a non-ASCII line by UTF-16 column and misses neighbours", () => {
    const index = decode(row({ line: 2, col: 17 }));
    expect(index.definitionAt("src/main.rs", 2, 17)).not.toBeNull();
    expect(index.definitionAt("src/main.rs", 2, 16)).toBeNull();
    expect(index.definitionAt("src/main.rs", 3, 17)).toBeNull();
    expect(index.definitionAt("src/other.rs", 2, 17)).toBeNull();
  });

  it("guards out-of-range lookups", () => {
    const index = decode(row({}));
    expect(index.definitionAt("src/main.rs", 0, 8)).toBeNull();
    expect(index.definitionAt("src/main.rs", 10, -1)).toBeNull();
    expect(index.definitionAt("src/main.rs", 10, 0x100000)).toBeNull();
  });

  it("skips malformed lines without throwing", () => {
    const index = decode(
      "not json",
      "",
      "{}",
      JSON.stringify({ relPath: "src/main.rs", line: "x", col: 1 }),
      row({ line: 5, col: 5, callee: "fx_core::ok" }),
    );
    expect(index.definitionAt("src/main.rs", 5, 5)).toMatchObject({ name: "ok" });
  });
});
