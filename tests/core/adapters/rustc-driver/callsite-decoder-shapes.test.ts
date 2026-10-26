import { describe, expect, it } from "vitest";

import { decodeRustcCallSites } from "../../../../src/core/adapters/rustc-driver/callsite-decoder.js";

const base = {
  relPath: "src/main.rs",
  line: 4,
  col: 2,
  origin: "source",
  callKind: "method",
  callee: "fx::Store::get",
  calleeCrate: "fx",
  defKind: "assocFn",
  traitPath: null,
  resolvedImpl: null,
  implIsDerived: false,
  inProject: false,
  defRelPath: null,
  defLine: null,
};

const decode = (rows: Record<string, unknown>[], workspaceCrates: string[] = []) =>
  decodeRustcCallSites([rows.map((r) => JSON.stringify({ ...base, ...r })).join("\n")], "id", { workspaceCrates });

describe("decodeRustcCallSites row shapes", () => {
  it("serves a macro invocation as a macro definition of the macro's own def path", () => {
    const index = decode([
      {
        origin: "macroInvocation",
        callKind: "path",
        callee: "ignored",
        calleeCrate: "log",
        macroDefPath: "log::debug",
        defKind: "ignored",
        inProject: true,
        defRelPath: "src/macros.rs",
        defLine: 9,
      },
    ]);
    expect(index.definitionAt("src/main.rs", 4, 2)).toMatchObject({
      package: "log",
      name: "debug",
      kind: "macro",
      inProject: true,
      relPath: "src/macros.rs",
      line: 9,
    });
    expect(decode([{ origin: "macroInvocation", macroDefPath: 7 }]).definitionAt("src/main.rs", 4, 2)).toBeNull();
  });

  it("serves indirect callees (closure, fn pointer, fn param) without a crate and rejects unknown indirections", () => {
    for (const kind of ["closure", "fnPointer", "fnParam"]) {
      const index = decode([{ callKind: "local", calleeCrate: null, callee: "cb", defKind: kind }]);
      expect(index.definitionAt("src/main.rs", 4, 2)).toMatchObject({
        package: "",
        name: "cb",
        inProject: false,
        packageInProject: false,
        indirectCallee: kind,
      });
    }
    const bad = decode([{ callKind: "local", calleeCrate: null, callee: "cb", defKind: "assocFn" }]);
    expect(bad.definitionAt("src/main.rs", 4, 2)).toBeNull();
  });

  it("carries a definition expansion, keeping optional position fields only when well-typed", () => {
    const withPositions = decode([
      {
        defExpansion: {
          kind: "bang",
          macro: "bitflags",
          macroDefPath: "bitflags::bitflags",
          macroInProject: true,
          macroDefRelPath: "src/flags.rs",
          macroDefLine: 12,
          macroDefName: "bitflags",
        },
      },
    ]);
    expect(withPositions.definitionAt("src/main.rs", 4, 2)?.defExpansion).toEqual({
      kind: "bang",
      macro: "bitflags",
      macroDefPath: "bitflags::bitflags",
      macroInProject: true,
      macroDefRelPath: "src/flags.rs",
      macroDefLine: 12,
      macroDefName: "bitflags",
    });
    const minimal = decode([
      { defExpansion: { kind: "derive", macro: "Debug", macroDefPath: "core::Debug", macroInProject: false } },
    ]);
    expect(minimal.definitionAt("src/main.rs", 4, 2)?.defExpansion).toEqual({
      kind: "derive",
      macro: "Debug",
      macroDefPath: "core::Debug",
      macroInProject: false,
    });
    for (const malformed of [
      "nope",
      { kind: "weird", macro: "m", macroDefPath: "p", macroInProject: true },
      { kind: "attr", macro: 1, macroDefPath: "p", macroInProject: true },
      { kind: "attr", macro: "m", macroDefPath: "p", macroInProject: "yes" },
    ]) {
      const def = decode([{ defExpansion: malformed }]).definitionAt("src/main.rs", 4, 2);
      expect(def?.name).toBe("get");
      expect(def?.defExpansion).toBeUndefined();
    }
  });

  it("names the trait without generic arguments and keeps declaring vs impl trait apart", () => {
    const declaring = decode([{ callee: "std::io::Read::read", calleeCrate: "std", traitPath: "std::io::Read<T>" }]);
    expect(declaring.definitionAt("src/main.rs", 4, 2)).toMatchObject({ declaringTrait: "Read" });
    const impl = decode([
      {
        callee: "std::io::Read::<A>::read",
        calleeCrate: "std",
        traitPath: "std::convert::From::<Vec<u8>>",
        resolvedImpl: "fx::Impl::read",
      },
    ]);
    const def = impl.definitionAt("src/main.rs", 4, 2);
    expect(def).toMatchObject({ implTrait: "From", symbol: "rustc std fx::Impl::read", name: "read" });
    expect(def?.declaringTrait).toBeUndefined();
    expect(decode([{ callee: "bare" }]).definitionAt("src/main.rs", 4, 2)?.name).toBe("bare");
  });

  it("rejects rows with wrong field types, bad positions, non-objects and unparseable text", () => {
    const rows = [
      { relPath: 3 },
      { origin: 3 },
      { callee: 3 },
      { calleeCrate: 3 },
      { defKind: 3 },
      { line: 0 },
      { line: 1.5 },
      { col: -1 },
      { col: "1" },
    ];
    for (const row of rows) {
      expect(decode([row]).definitionAt("src/main.rs", 4, 2), JSON.stringify(row)).toBeNull();
    }
    const text = ["null", "7", "{not json", JSON.stringify({ ...base })].join("\n");
    expect(decodeRustcCallSites([text], "id").definitionAt("src/main.rs", 4, 2)?.name).toBe("get");
  });

  it("does not key columns past the minified-line cap", () => {
    const index = decode([{ col: 0x100000 }]);
    expect(index.definitionAt("src/main.rs", 4, 0x100000)).toBeNull();
  });

  it("learns workspace crates from in-project trait-free rows and from the runner", () => {
    const index = decode(
      [
        {
          line: 1,
          col: 0,
          calleeCrate: "learned",
          callee: "learned::f",
          inProject: true,
          defRelPath: "a.rs",
          defLine: 1,
        },
        { line: 2, col: 0, calleeCrate: "viaRunner", callee: "viaRunner::g" },
        { line: 3, col: 0, calleeCrate: "stranger", callee: "stranger::h" },
      ],
      ["viaRunner"],
    );
    expect(index.definitionAt("src/main.rs", 1, 0)?.packageInProject).toBe(true);
    expect(index.definitionAt("src/main.rs", 2, 0)?.packageInProject).toBe(true);
    expect(index.definitionAt("src/main.rs", 3, 0)?.packageInProject).toBe(false);
  });
});
