import { describe, expect, it, vi } from "vitest";

import type { CallContext, CallRef } from "../../../../../../src/core/contracts/types/codegraph.js";
import type { ManifestFile, ManifestFilesReader } from "../../../../../../src/core/contracts/types/language.js";
import { LanguageFactory } from "../../../../../../src/core/domains/language/factory.js";
import { RustLanguage } from "../../../../../../src/core/domains/language/rust/index.js";
import { parseRustCrateManifest } from "../../../../../../src/core/domains/language/rust/manifest.js";
import { RustCallResolver } from "../../../../../../src/core/domains/language/rust/resolver/rust-resolver.js";
import {
  RustWorkspaceCrateMap,
  RustWorkspaceCrateMapCache,
} from "../../../../../../src/core/domains/language/rust/resolver/workspace-crates.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/**
 * bd tea-rags-mcp-sjego — a Cargo workspace member is imported by its CRATE
 * name (`[package] name`, `-` → `_`, or `[lib] name`), which need not match
 * its directory: ripgrep's `grep_matcher` lives in `crates/matcher`. The map
 * is read through the injected manifest reader at pass start, never from the
 * resolver.
 */
const ROOT = "/nonexistent/sjego-root";

function stubReader(files: ManifestFile[]): ManifestFilesReader & ReturnType<typeof vi.fn> {
  return vi.fn((_root: string, _matches: (fileName: string) => boolean) => files) as never;
}

const RIPGREP_MANIFESTS: ManifestFile[] = [
  { relDir: "", fileName: "Cargo.toml", content: '[workspace]\nmembers = ["crates/matcher"]\n' },
  {
    relDir: "crates/matcher",
    fileName: "Cargo.toml",
    content: '[package]\nname = "grep-matcher"\nversion = "0.1.7"\n\n[dev-dependencies]\nregex = "1"\n',
  },
];

function def(t: InMemoryGlobalSymbolTable, relPath: string, defs: [string, string, string[]][]): void {
  t.upsertFile(
    relPath,
    defs.map(([shortName, fq, scope]) => ({ symbolId: fq, fqName: fq, shortName, relPath, scope })),
  );
}

function ripgrepTable(): InMemoryGlobalSymbolTable {
  const t = new InMemoryGlobalSymbolTable();
  def(t, "crates/matcher/src/lib.rs", [
    ["Match", "Match", []],
    ["zero", "Match.zero", ["Match"]],
  ]);
  def(t, "crates/searcher/src/lib.rs", [["searcher_root", "searcher_root", []]]);
  return t;
}

const CALLER = "crates/searcher/src/searcher/core.rs";
const RANGE_IMPORT = "use grep_matcher::{Match as Range, Matcher};";
const RANGE_ZERO: CallRef = { callText: "Range::zero(i)", receiver: "Range", member: "zero", startLine: 495 };

function callerCtx(t: InMemoryGlobalSymbolTable, importText = RANGE_IMPORT): CallContext {
  return {
    callerFile: CALLER,
    callerScope: [],
    imports: [{ importText, startLine: 3 }],
    symbolTable: t,
    projectRoot: ROOT,
  };
}

function preparedResolver(files: ManifestFile[] = RIPGREP_MANIFESTS): RustCallResolver {
  const resolver = new RustCallResolver(undefined, stubReader(files));
  resolver.prepareResolvePass({ expectedFileCount: 2, projectRoot: ROOT });
  return resolver;
}

describe("parseRustCrateManifest", () => {
  it("names the crate after [package] name with '-' normalised to '_', rooted at src/lib.rs", () => {
    expect(parseRustCrateManifest('[package]\nname = "grep-matcher"\nversion = "0.1.7"\n')).toEqual({
      crateName: "grep_matcher",
      rootFile: "src/lib.rs",
    });
  });

  it("prefers [lib] name and [lib] path over the package defaults", () => {
    const manifest = '[package]\nname = "script-bindings"\n\n[lib]\nname = "script_bindings"\npath = "lib.rs"\n';
    expect(parseRustCrateManifest(manifest)).toEqual({ crateName: "script_bindings", rootFile: "lib.rs" });
  });

  it("never reads a name from another table ([[bin]], [dependencies])", () => {
    const manifest =
      '[[bin]]\nname = "rg"\npath = "crates/core/main.rs"\n\n[package]\nname = "ripgrep"\n\n[dependencies]\nname = "x"\n';
    expect(parseRustCrateManifest(manifest)?.crateName).toBe("ripgrep");
  });

  it("answers no crate for a virtual workspace manifest (no [package])", () => {
    expect(parseRustCrateManifest('[workspace]\nmembers = ["crates/matcher"]\n')).toBeUndefined();
  });

  it("tolerates single quotes and trailing comments", () => {
    expect(parseRustCrateManifest("[package]\nname = 'grep-cli' # the cli helpers\n")?.crateName).toBe("grep_cli");
  });
});

describe("RustWorkspaceCrateMap", () => {
  it("maps each member's crate name to the directory of its crate root file", () => {
    const map = RustWorkspaceCrateMap.fromManifests(RIPGREP_MANIFESTS);
    expect(map.rootFilesOf("grep_matcher")).toEqual(["crates/matcher/src/lib.rs"]);
    expect(map.rootDirsOf("grep_matcher")).toEqual(["crates/matcher/src"]);
    expect(map.declares("grep_matcher")).toBe(true);
    expect(map.declares("matcher")).toBe(false);
    expect(map.declares("regex")).toBe(false);
  });

  it("is read through the injected reader, matching only Cargo.toml", () => {
    const reader = stubReader(RIPGREP_MANIFESTS);
    const map = new RustWorkspaceCrateMapCache(reader).forRoot(ROOT);
    expect(map?.declares("grep_matcher")).toBe(true);
    const [root, matches] = reader.mock.calls[0] as [string, (fileName: string) => boolean];
    expect(root).toBe(ROOT);
    expect(matches("Cargo.toml")).toBe(true);
    expect(matches("Cargo.lock")).toBe(false);
  });

  it("answers no map without a reader", () => {
    expect(new RustWorkspaceCrateMapCache().forRoot(ROOT)).toBeUndefined();
  });
});

describe("Rust resolver — workspace crate names map to member directories", () => {
  it("resolves `use grep_matcher::{Match as Range}` + `Range::zero` onto crates/matcher", () => {
    const target = preparedResolver().resolve(RANGE_ZERO, callerCtx(ripgrepTable()));
    expect(target).toEqual({ targetRelPath: "crates/matcher/src/lib.rs", targetSymbolId: "Match.zero" });
  });

  it("never classifies a call through a workspace member's crate name as external", () => {
    expect(preparedResolver().targetsExternalImport(RANGE_ZERO, callerCtx(ripgrepTable()))).toBe(false);
  });

  it("keeps a crate that is neither std nor a workspace member external", () => {
    const call: CallRef = { callText: "Regex::new(p)", receiver: "Regex", member: "new", startLine: 9 };
    const ctx = callerCtx(ripgrepTable(), "use regex::Regex;");
    expect(preparedResolver().targetsExternalImport(call, ctx)).toBe(true);
  });

  it("resolves a plain `use grep_matcher::Match` item import at the member's crate root", () => {
    const call: CallRef = { callText: "Match::zero(i)", receiver: "Match", member: "zero", startLine: 12 };
    const target = preparedResolver().resolve(call, callerCtx(ripgrepTable(), "use grep_matcher::Match;"));
    expect(target).toEqual({ targetRelPath: "crates/matcher/src/lib.rs", targetSymbolId: "Match.zero" });
  });
});

describe("Rust resolver — an imported type alias does not pin its members to the alias's file", () => {
  /**
   * The real ripgrep shape (crates/searcher/src/searcher/core.rs:495 / :509):
   * core.rs imports `Range` from its parent module, which declares
   * `type Range = Match;` over `grep_matcher::Match`. The alias's members
   * live on the aliased type, so the import binding proves nothing about
   * where `zero` is — the later passes must still answer it.
   */
  function aliasTable(): InMemoryGlobalSymbolTable {
    const t = ripgrepTable();
    t.upsertFile("crates/searcher/src/searcher/mod.rs", [
      {
        symbolId: "Range",
        fqName: "Range",
        shortName: "Range",
        relPath: "crates/searcher/src/searcher/mod.rs",
        scope: [],
        symbolKind: "type_alias",
      },
      {
        symbolId: "Searcher",
        fqName: "Searcher",
        shortName: "Searcher",
        relPath: "crates/searcher/src/searcher/mod.rs",
        scope: [],
        symbolKind: "class",
      },
    ]);
    return t;
  }

  const CRATE_IMPORT = "use crate::{\n    lines::{self, LineStep},\n    searcher::{Config, Range, Searcher},\n};";

  it("resolves `Range::zero` through `use crate::{searcher::{Range}}` onto Match.zero", () => {
    const target = preparedResolver().resolve(RANGE_ZERO, callerCtx(aliasTable(), CRATE_IMPORT));
    expect(target).toEqual({ targetRelPath: "crates/matcher/src/lib.rs", targetSymbolId: "Match.zero" });
  });

  it("reads the alias from the run's declaration facts when the table holds no row for it (private `type`)", () => {
    const t = ripgrepTable();
    t.upsertFile("crates/searcher/src/searcher/mod.rs", [
      {
        symbolId: "Searcher",
        fqName: "Searcher",
        shortName: "Searcher",
        relPath: "crates/searcher/src/searcher/mod.rs",
        scope: [],
        symbolKind: "class",
      },
    ]);
    const ctx: CallContext = {
      ...callerCtx(t, CRATE_IMPORT),
      typeDeclarations: {
        "crates/searcher/src/searcher/mod.rs": [
          { typeId: "Range", symbolKind: "type_alias", line: 32, reopens: false },
          { typeId: "Searcher", symbolKind: "class", line: 600, reopens: false },
        ],
      },
    };
    expect(preparedResolver().resolve(RANGE_ZERO, ctx)).toEqual({
      targetRelPath: "crates/matcher/src/lib.rs",
      targetSymbolId: "Match.zero",
    });
  });

  it("still drops a member the imported STRUCT's file does not declare", () => {
    const call: CallRef = { callText: "Searcher::zero(i)", receiver: "Searcher", member: "zero", startLine: 40 };
    expect(preparedResolver().resolve(call, callerCtx(aliasTable(), CRATE_IMPORT))).toBeNull();
  });
});

describe("RustLanguage / LanguageFactory — the reader reaches the resolver", () => {
  it("RustLanguage re-reads the crate map through the injected reader at pass start", () => {
    const reader = stubReader(RIPGREP_MANIFESTS);
    new RustLanguage(undefined, reader).resolver.prepareResolvePass?.({ expectedFileCount: 1, projectRoot: ROOT });
    expect(reader).toHaveBeenCalledTimes(1);
    expect(reader.mock.calls[0]?.[0]).toBe(ROOT);
  });

  it("LanguageFactory threads its manifestFilesReader into the Rust provider", () => {
    const reader = stubReader(RIPGREP_MANIFESTS);
    const rust = new LanguageFactory({ manifestFilesReader: reader, isGrammarPackageInstalled: () => true }).create(
      "rust",
    );
    rust.resolver?.prepareResolvePass?.({ expectedFileCount: 1, projectRoot: ROOT });
    expect(reader).toHaveBeenCalledTimes(1);
  });
});
