import { describe, expect, it } from "vitest";

import type { CallContext } from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  parseRustImportPath,
  rustFollowReexports,
  rustImportBindings,
  rustImportCandidatePaths,
  rustImportCandidateSuffix,
  rustImportContainsReceiver,
  rustImportGlobCandidatePaths,
  rustImportIsExternal,
  rustImportMatchesReceiver,
  rustImportSuffix,
  rustMacroPathIsExternal,
  rustModuleCandidatePaths,
  rustReexportSourcePaths,
} from "../../../../../../src/core/domains/language/rust/resolver/strategies/shared.js";

function ctxWith(files: string[], moduleReexports?: Record<string, unknown[]>): CallContext {
  const known = new Set(files);
  return {
    callerFile: "src/main.rs",
    callerScope: [],
    imports: [],
    symbolTable: {
      hasFile: (path: string) => known.has(path),
      hasDirNamed: () => false,
      lookupByShortName: () => [],
    },
    moduleReexports,
  } as unknown as CallContext;
}

describe("Rust use-tree parsing", () => {
  it("flattens nested groups, self members and aliases into one binding per leaf", () => {
    const bindings = rustImportBindings("use std::{ffi::{OsStr, OsString as Os}, io::{self, Read},};");
    expect(bindings?.map((b) => [b.localName, b.moduleSegments.join("::"), b.sourceName])).toEqual([
      ["OsStr", "std::ffi", "OsStr"],
      ["Os", "std::ffi", "OsString"],
      ["io", "std::io", null],
      ["Read", "std::io", "Read"],
    ]);
    expect(rustImportBindings("use crate::{a, b::c};")?.map((b) => b.prefix)).toEqual(["crate", "crate"]);
    expect(rustImportBindings("use a::{*};")?.[0]).toMatchObject({ globImport: true, localName: "*" });
  });

  it("answers null for every malformed shape instead of guessing", () => {
    for (const text of [
      "use std::{io",
      "use std::io}",
      "use std::{io}x;",
      "use std x::{io};",
      "use {self};",
      "use std::{};",
      "use std::{a, b::};",
      "use std::{a::* as x};",
      "use std::{bad-name::x};",
      "use ::;",
      "use crate;",
      "use a::*::b;",
      "use a::b-c;",
      "use a::b as c-d;",
    ]) {
      expect(rustImportBindings(text), text).toBeNull();
    }
    expect(rustImportBindings("use a::{b, , c};")?.map((b) => b.localName)).toEqual(["b", "c"]);
  });

  it("reads receivers, suffixes and containment across plain, aliased and glob imports", () => {
    expect(rustImportMatchesReceiver("use a::b::C;", "C")).toBe(true);
    expect(rustImportMatchesReceiver("use a::b::C;", "D")).toBe(false);
    expect(rustImportMatchesReceiver("use a::b::*;", "b")).toBe(true);
    expect(rustImportSuffix("use a::b::C;")).toBe("a/b/C");
    expect(rustImportSuffix("use {self};")).toBeNull();
    expect(rustImportCandidateSuffix("use a::b::C;", "C")).toBe("a/b/C");
    expect(rustImportCandidateSuffix("use a::b::C;", "X")).toBeNull();
    expect(parseRustImportPath("use a::b::C as D;", "D")).toMatchObject({ receiverMatches: true });
    expect(parseRustImportPath("use a::b::C;", "Z")).toMatchObject({ receiverMatches: false });
    expect(rustImportContainsReceiver("use a::b::C;", "b")).toBe(true);
    expect(rustImportContainsReceiver("use a::b::C;", "z")).toBe(false);
    // Malformed text falls back to a plain path-segment scan.
    expect(rustImportContainsReceiver("use a::b::{c", "b")).toBe(true);
    expect(rustImportContainsReceiver("use a::b::{c", "q")).toBe(false);
  });

  it("places module and glob candidates from the caller's directory chain", () => {
    expect(rustModuleCandidatePaths("use crate::util::x;", "src/app/main.rs")).toEqual([
      "src/util/x.rs",
      "src/util/x/mod.rs",
    ]);
    expect(rustModuleCandidatePaths("use self::peer;", "src/net/client.rs")).toEqual([
      "src/net/client/peer.rs",
      "src/net/client/peer/mod.rs",
    ]);
    expect(rustModuleCandidatePaths("use super::super::top;", "src/a/b/mod.rs")).toEqual([
      "src/top.rs",
      "src/top/mod.rs",
    ]);
    expect(rustModuleCandidatePaths("use pkg::thing;", "src/lib.rs")).toEqual(["pkg/thing.rs", "pkg/thing/mod.rs"]);
    expect(rustModuleCandidatePaths("use std::{io", "src/lib.rs")).toBeNull();
    expect(rustImportGlobCandidatePaths("use crate::prelude::*;", "src/lib.rs")).toEqual([
      "src/prelude.rs",
      "src/prelude/mod.rs",
    ]);
    expect(rustImportGlobCandidatePaths("use crate::prelude::X;", "src/lib.rs")).toEqual([]);
    expect(rustImportGlobCandidatePaths("use std::{io", "src/lib.rs")).toBeNull();
  });

  it("scans every ancestor for crate roots, preferring directories that hold a crate marker", () => {
    const marked = ctxWith(["crates/core/src/lib.rs"]);
    const markedPaths = rustImportCandidatePaths("use crate::net::Conn;", "Conn", "crates/core/src/a/b.rs", marked);
    expect(markedPaths).toContain("crates/core/src/net/Conn.rs");
    expect(markedPaths).not.toContain("crates/core/src/a/net/Conn.rs");
    const unmarked = ctxWith([]);
    expect(rustImportCandidatePaths("use crate::net::Conn;", "Conn", "pkg/src/b.rs", unmarked)).toContain(
      "pkg/src/net/Conn.rs",
    );
    expect(rustImportCandidatePaths("use a::B;", "Other", "src/lib.rs")).toEqual([]);
    expect(rustImportCandidatePaths("use a::{b", "b", "src/lib.rs")).toBeNull();
  });
});

describe("Rust path-head externality and re-export following", () => {
  it("proves std heads and unknown crate heads external, own-crate and project modules internal", () => {
    const ctx = ctxWith(["local.rs", "other/mod.rs"]);
    expect(rustImportIsExternal("use std::io::Read;", ctx)).toBe(true);
    expect(rustImportIsExternal("use walkdir::WalkDir;", ctx)).toBe(true);
    expect(rustImportIsExternal("use local::Thing;", ctx)).toBe(false);
    expect(rustImportIsExternal("use other::Thing;", ctx)).toBe(false);
    expect(rustImportIsExternal("use crate::x::Y;", ctx)).toBe(false);
    expect(rustImportIsExternal("use {walkdir::W, crate::E};", ctx, "E")).toBe(false);
    expect(rustImportIsExternal("use {walkdir::W, crate::E};", ctx, "W")).toBe(true);
    expect(rustImportIsExternal("use std::{io", ctx)).toBe(false);
    expect(rustMacroPathIsExternal("crate", [], ctx)).toBe(false);
    expect(rustMacroPathIsExternal("std", [], ctx)).toBe(true);
    expect(rustMacroPathIsExternal("log", [], ctx)).toBe(true);
    const def = { relPath: "src/log.rs" } as never;
    expect(rustMacroPathIsExternal("log", [def], ctx)).toBe(false);
  });

  it("resolves a pub-use source module relative to the module that wrote it", () => {
    const ctx = ctxWith(["src/net/peer.rs", "src/net/mod.rs"]);
    expect(rustReexportSourcePaths("self", "src/net/mod.rs", ctx)).toEqual(["src/net/mod.rs"]);
    expect(rustReexportSourcePaths("super", "src/net/peer.rs", ctx)).toEqual([
      "src/net.rs",
      "src/net/mod.rs",
      "src/net/lib.rs",
      "src/net/main.rs",
    ]);
    expect(rustReexportSourcePaths("crate::util", "src/net/mod.rs", ctx)).toContain("src/util.rs");
    expect(rustReexportSourcePaths("peer", "src/net/mod.rs", ctx)).toEqual(["src/net/peer.rs", "src/net/peer/mod.rs"]);
    expect(rustReexportSourcePaths("serde", "src/net/mod.rs", ctx)).toBe("external");
    expect(rustReexportSourcePaths("ghost", "src/net/mod.rs", ctxWith(["ghost.rs"]))).toBeNull();
    expect(rustReexportSourcePaths("a::::b", "src/net/mod.rs", ctx)).toBeNull();
    expect(rustReexportSourcePaths("a::b-c", "src/net/mod.rs", ctx)).toBeNull();
  });

  it("follows named and glob re-exports to the single defining file and reports when the walk stays open", () => {
    const def = (relPath: string, symbolId: string) => ({ relPath, symbolId }) as never;
    const defsOf = (name: string) =>
      name === "Conn"
        ? [def("src/net/conn.rs", "Conn")]
        : name === "Twin"
          ? [def("src/a.rs", "Twin"), def("src/b.rs", "Twin")]
          : [];
    const files = ["src/lib.rs", "src/net/mod.rs", "src/net/conn.rs", "src/a.rs", "src/b.rs"];

    const named = ctxWith(files, {
      "src/net/mod.rs": [{ exportedName: "Conn", sourceModule: "conn" }],
    });
    expect(rustFollowReexports("use crate::net::Conn;", "Conn", "src/lib.rs", named, defsOf)).toEqual({
      target: { targetRelPath: "src/net/conn.rs", targetSymbolId: "Conn" },
      open: false,
    });

    const glob = ctxWith(files, { "src/net/mod.rs": [{ exportedName: "*", sourceModule: "conn" }] });
    expect(rustFollowReexports("use crate::net::Conn;", "Conn", "src/lib.rs", glob, defsOf).target).not.toBeNull();

    const externalNamed = ctxWith(files, { "src/net/mod.rs": [{ exportedName: "Conn", sourceModule: "tokio" }] });
    expect(rustFollowReexports("use crate::net::Conn;", "Conn", "src/lib.rs", externalNamed, defsOf)).toEqual({
      target: null,
      open: false,
    });
    const externalGlob = ctxWith(files, { "src/net/mod.rs": [{ exportedName: "*", sourceModule: "tokio" }] });
    expect(rustFollowReexports("use crate::net::Conn;", "Conn", "src/lib.rs", externalGlob, defsOf).open).toBe(true);

    const unfollowable = ctxWith(files, { "src/net/mod.rs": [{ exportedName: "Conn", sourceModule: "a::::b" }] });
    expect(rustFollowReexports("use crate::net::Conn;", "Conn", "src/lib.rs", unfollowable, defsOf).open).toBe(true);

    const unknownSource = ctxWith([...files, "missing.rs"], {
      "src/net/mod.rs": [{ exportedName: "Conn", sourceModule: "missing" }],
    });
    // `missing` is not external-looking nor known: path cannot be followed.
    expect(rustFollowReexports("use crate::net::Conn;", "Conn", "src/lib.rs", unknownSource, defsOf).open).toBe(true);

    const twins = ctxWith(files, {
      "src/net/mod.rs": [
        { exportedName: "Twin", sourceModule: "crate::a" },
        { exportedName: "Twin", sourceModule: "crate::b" },
      ],
    });
    expect(rustFollowReexports("use crate::net::Twin;", "Twin", "src/lib.rs", twins, defsOf)).toEqual({
      target: null,
      open: true,
    });

    expect(rustFollowReexports("use crate::net::Conn;", "Conn", "src/lib.rs", ctxWith(files), defsOf)).toEqual({
      target: null,
      open: true,
    });
    expect(rustFollowReexports("use std::{io", "io", "src/lib.rs", named, defsOf)).toEqual({
      target: null,
      open: true,
    });
  });

  it("caps a cyclic re-export chain instead of looping", () => {
    const files = ["src/lib.rs", "src/x/mod.rs", "src/y/mod.rs"];
    const cyclic = ctxWith(files, {
      "src/x/mod.rs": [{ exportedName: "T", sourceModule: "crate::y" }],
      "src/y/mod.rs": [{ exportedName: "T", sourceModule: "crate::x" }],
    });
    const outcome = rustFollowReexports("use crate::x::T;", "T", "src/lib.rs", cyclic, () => []);
    expect(outcome.target).toBeNull();
  });
});
