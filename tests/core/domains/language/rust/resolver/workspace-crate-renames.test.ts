import { describe, expect, it, vi } from "vitest";

import type { CallContext, CallRef } from "../../../../../../src/core/contracts/types/codegraph.js";
import type { ManifestFile, ManifestFilesReader } from "../../../../../../src/core/contracts/types/language.js";
import { RustCallResolver } from "../../../../../../src/core/domains/language/rust/resolver/rust-resolver.js";
import { RustWorkspaceCrateMap } from "../../../../../../src/core/domains/language/rust/resolver/workspace-crates.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/**
 * bd tea-rags-mcp-sjego (remainder) — a crate is also imported under the name
 * a DEPENDENCY declaration gives it. Servo's member package `servo-webxr-api`
 * is depended on as `webxr-api = { package = "servo-webxr-api", … }` in the
 * root `[workspace.dependencies]`, inherited by `webxr-api = { workspace = true }`
 * in the members, so `use webxr_api::InputId` names that member. The map stays
 * global and additive: an alias joins only when it names exactly one member,
 * no member already answers it, and no other declaration maps it elsewhere.
 */
const ROOT = "/nonexistent/sjego-renames-root";

function stubReader(files: ManifestFile[]): ManifestFilesReader {
  return vi.fn((_root: string, _matches: (fileName: string) => boolean) => files);
}

const WEBXR_API_MEMBER: ManifestFile = {
  relDir: "components/shared/webxr",
  fileName: "Cargo.toml",
  content: '[package]\nname = "servo-webxr-api"\nversion.workspace = true\n\n[lib]\npath = "lib.rs"\n',
};

function dependent(content: string): ManifestFile {
  return { relDir: "components/paint", fileName: "Cargo.toml", content };
}

const DIRECT_RENAME: ManifestFile[] = [
  WEBXR_API_MEMBER,
  dependent(
    '[package]\nname = "servo-paint"\n\n[dependencies]\nwebxr-api = { package = "servo-webxr-api", path = "../shared/webxr" }\n',
  ),
];

const WORKSPACE_INHERITED_RENAME: ManifestFile[] = [
  {
    relDir: "",
    fileName: "Cargo.toml",
    content:
      '[workspace]\nmembers = ["components/*"]\n\n[workspace.dependencies]\nwebxr-api = { package = "servo-webxr-api", version = "=0.7.0", path = "components/shared/webxr" }\nfontconfig_sys = { package = "yeslogic-fontconfig-sys", version = "6" }\n',
  },
  WEBXR_API_MEMBER,
  dependent('[package]\nname = "servo-paint"\n\n[dependencies]\nwebxr-api = { workspace = true, optional = true }\n'),
];

function webxrTable(): InMemoryGlobalSymbolTable {
  const t = new InMemoryGlobalSymbolTable();
  const relPath = "components/shared/webxr/lib.rs";
  t.upsertFile(relPath, [
    { symbolId: "InputId", fqName: "InputId", shortName: "InputId", relPath, scope: [] },
    { symbolId: "InputId.new", fqName: "InputId.new", shortName: "new", relPath, scope: ["InputId"] },
  ]);
  return t;
}

const INPUT_ID_NEW: CallRef = { callText: "InputId::new(0)", receiver: "InputId", member: "new", startLine: 20 };

function ctx(t: InMemoryGlobalSymbolTable, importText: string): CallContext {
  return {
    callerFile: "components/paint/lib.rs",
    callerScope: [],
    imports: [{ importText, startLine: 3 }],
    symbolTable: t,
    projectRoot: ROOT,
  };
}

function preparedResolver(files: ManifestFile[]): RustCallResolver {
  const resolver = new RustCallResolver(undefined, stubReader(files));
  resolver.prepareResolvePass({ expectedFileCount: 2, projectRoot: ROOT });
  return resolver;
}

describe("RustWorkspaceCrateMap — dependency renames", () => {
  it('adds `webxr_api` for `webxr-api = { package = "servo-webxr-api", path = … }` onto that member', () => {
    const map = RustWorkspaceCrateMap.fromManifests(DIRECT_RENAME);
    expect(map.rootFilesOf("webxr_api")).toEqual(["components/shared/webxr/lib.rs"]);
    expect(map.declares("servo_webxr_api")).toBe(true);
  });

  it("adds the alias declared in [workspace.dependencies] and inherited with `workspace = true`", () => {
    const map = RustWorkspaceCrateMap.fromManifests(WORKSPACE_INHERITED_RENAME);
    expect(map.rootDirsOf("webxr_api")).toEqual(["components/shared/webxr"]);
  });

  it("reads renames from dev-, build- and target-specific dependency tables", () => {
    for (const table of ["dev-dependencies", "build-dependencies", "target.'cfg(unix)'.dependencies"]) {
      const map = RustWorkspaceCrateMap.fromManifests([
        WEBXR_API_MEMBER,
        dependent(`[package]\nname = "servo-paint"\n\n[${table}]\nwebxr-api = { package = "servo-webxr-api" }\n`),
      ]);
      expect(map.declares("webxr_api")).toBe(true);
    }
  });

  it("ignores a rename onto a package that is not a workspace member", () => {
    const map = RustWorkspaceCrateMap.fromManifests(WORKSPACE_INHERITED_RENAME);
    expect(map.declares("fontconfig_sys")).toBe(false);
  });

  it("ignores an alias two declarations map onto different members", () => {
    const map = RustWorkspaceCrateMap.fromManifests([
      WEBXR_API_MEMBER,
      { relDir: "components/webxr", fileName: "Cargo.toml", content: '[package]\nname = "servo-webxr"\n' },
      dependent('[package]\nname = "servo-paint"\n\n[dependencies]\nx = { package = "servo-webxr-api" }\n'),
      {
        relDir: "components/script",
        fileName: "Cargo.toml",
        content: '[package]\nname = "servo-script"\n\n[dependencies]\nx = { package = "servo-webxr" }\n',
      },
    ]);
    expect(map.declares("x")).toBe(false);
  });

  it("ignores an alias that collides with an existing member's crate name", () => {
    const map = RustWorkspaceCrateMap.fromManifests([
      WEBXR_API_MEMBER,
      { relDir: "components/paint_api", fileName: "Cargo.toml", content: '[package]\nname = "paint-api"\n' },
      dependent('[package]\nname = "servo-paint"\n\n[dependencies]\npaint_api = { package = "servo-webxr-api" }\n'),
    ]);
    expect(map.rootFilesOf("paint_api")).toEqual(["components/paint_api/src/lib.rs"]);
  });
});

describe("RustWorkspaceCrateMap — [lib] name", () => {
  const FOO_CORE: ManifestFile[] = [
    {
      relDir: "foo-core",
      fileName: "Cargo.toml",
      content: '[package]\nname = "foo-core-rs"\n\n[lib]\nname = "foo_core"\n',
    },
  ];

  it("answers the [lib] name and keeps the package-derived name when no other member uses it", () => {
    const map = RustWorkspaceCrateMap.fromManifests(FOO_CORE);
    expect(map.rootFilesOf("foo_core")).toEqual(["foo-core/src/lib.rs"]);
    expect(map.rootFilesOf("foo_core_rs")).toEqual(["foo-core/src/lib.rs"]);
  });

  it("does not add the package-derived name another member already answers", () => {
    const map = RustWorkspaceCrateMap.fromManifests([
      ...FOO_CORE,
      {
        relDir: "other",
        fileName: "Cargo.toml",
        content: '[package]\nname = "foo-core-rs"\n\n[lib]\nname = "foo_core_rs"\n',
      },
    ]);
    expect(map.rootFilesOf("foo_core_rs")).toEqual(["other/src/lib.rs"]);
  });
});

describe("Rust resolver — a renamed dependency resolves into its member", () => {
  it("resolves `use webxr_api::InputId` + `InputId::new` through a direct rename", () => {
    const resolver = preparedResolver(DIRECT_RENAME);
    const target = resolver.resolve(INPUT_ID_NEW, ctx(webxrTable(), "use webxr_api::InputId;"));
    expect(target).toEqual({ targetRelPath: "components/shared/webxr/lib.rs", targetSymbolId: "InputId.new" });
    expect(resolver.targetsExternalImport(INPUT_ID_NEW, ctx(webxrTable(), "use webxr_api::InputId;"))).toBe(false);
  });

  it("resolves the same through a [workspace.dependencies] rename inherited with `workspace = true`", () => {
    const resolver = preparedResolver(WORKSPACE_INHERITED_RENAME);
    const target = resolver.resolve(INPUT_ID_NEW, ctx(webxrTable(), "use webxr_api::{InputId};"));
    expect(target).toEqual({ targetRelPath: "components/shared/webxr/lib.rs", targetSymbolId: "InputId.new" });
    expect(resolver.targetsExternalImport(INPUT_ID_NEW, ctx(webxrTable(), "use webxr_api::InputId;"))).toBe(false);
  });
});
