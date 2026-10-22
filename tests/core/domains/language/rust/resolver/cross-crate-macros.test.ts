/**
 * bd tea-rags-mcp-s3i8m.4 (B1) — a `#[macro_export]` macro of a SIBLING
 * workspace crate is reachable through a `use <crate>::m` binding (plain,
 * nested, renamed) or a `<crate>::m!` path whose head is a workspace member.
 * Only exported (`visibility: "public"`) macros living under that crate's
 * member directories are candidates; a non-exported macro never crosses a
 * crate boundary, an external head stays external, std declines.
 */
import Parser from "tree-sitter";
import RustLang from "tree-sitter-rust";
import { describe, expect, it, vi } from "vitest";

import { materializeTree } from "../../../../../../src/core/adapters/tree-sitter/materialize.js";
import type {
  CallContext,
  CallRef,
  FileExtraction,
  SymbolDefinition,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import type { ManifestFile, ManifestFilesReader } from "../../../../../../src/core/contracts/types/language.js";
import { LanguageFactory } from "../../../../../../src/core/domains/language/factory.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { RustLanguage } from "../../../../../../src/core/domains/language/rust/index.js";
import { RustCallResolver } from "../../../../../../src/core/domains/language/rust/resolver/rust-resolver.js";
import { CallEdgeResolutionRunner } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/resolution-runner.js";
import { CodegraphRunState } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { collectTypeDeclarationReaders } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/type-declaration-readers.js";

const ROOT = "/nonexistent/s3i8m4-root";

const MANIFESTS: ManifestFile[] = [
  { relDir: "", fileName: "Cargo.toml", content: '[workspace]\nmembers = ["components/*"]\n' },
  { relDir: "components/tikv_util", fileName: "Cargo.toml", content: '[package]\nname = "tikv_util"\n' },
  { relDir: "components/api_version", fileName: "Cargo.toml", content: '[package]\nname = "api_version"\n' },
  { relDir: "components/other_util", fileName: "Cargo.toml", content: '[package]\nname = "other-util"\n' },
];

function stubReader(files: ManifestFile[]): ManifestFilesReader {
  return vi.fn(() => files);
}

function resolver(): RustCallResolver {
  const r = new RustCallResolver(undefined, stubReader(MANIFESTS));
  r.prepareResolvePass({ expectedFileCount: 4, projectRoot: ROOT });
  return r;
}

type Visibility = SymbolDefinition["visibility"];

interface MacroSpec {
  relPath: string;
  name: string;
  visibility?: Visibility;
  kind?: SymbolDefinition["symbolKind"];
}

function table(macros: MacroSpec[]): InMemoryGlobalSymbolTable {
  const t = new InMemoryGlobalSymbolTable();
  const byFile = new Map<string, MacroSpec[]>();
  for (const m of macros) byFile.set(m.relPath, [...(byFile.get(m.relPath) ?? []), m]);
  for (const relPath of [
    "components/tikv_util/src/lib.rs",
    "components/api_version/src/lib.rs",
    "components/other_util/src/lib.rs",
  ]) {
    if (!byFile.has(relPath)) byFile.set(relPath, []);
  }
  for (const [relPath, specs] of byFile) {
    t.upsertFile(
      relPath,
      specs.map((m) => ({
        symbolId: m.name,
        fqName: m.name,
        shortName: m.name,
        relPath,
        scope: [],
        symbolKind: m.kind ?? "macro",
        startLine: 10,
        endLine: 12,
        ...(m.visibility !== undefined ? { visibility: m.visibility } : {}),
      })),
    );
  }
  return t;
}

const CALLER = "components/api_version/src/api_v1ttl.rs";
const TIKV_BOX_ERR: MacroSpec = {
  relPath: "components/tikv_util/src/macros.rs",
  name: "box_err",
  visibility: "public",
};

function ctx(t: InMemoryGlobalSymbolTable, imports: string[]): CallContext {
  return {
    callerFile: CALLER,
    callerScope: [],
    imports: imports.map((importText, index) => ({ importText, startLine: index + 1 })),
    symbolTable: t,
    projectRoot: ROOT,
  };
}

function macroCall(member: string, receiver: string | null = null): CallRef {
  const path = receiver === null ? member : `${receiver}::${member}`;
  return { callText: `${path}!(e)`, receiver, member, startLine: 73 };
}

const BOX_ERR_TARGET = { targetRelPath: "components/tikv_util/src/macros.rs", targetSymbolId: "box_err" };

describe("cross-crate exported macros (s3i8m.4 B1)", () => {
  it("finding 4: `use tikv_util::{box_err, codec::{…}}` binds the sibling crate's exported box_err", () => {
    const imports = [
      "use tikv_util::{\n    box_err,\n    codec::{\n        number::{self, NumberEncoder},\n    },\n};",
    ];
    expect(resolver().resolve(macroCall("box_err"), ctx(table([TIKV_BOX_ERR]), imports))).toEqual(BOX_ERR_TARGET);
  });

  it("a plain `use tikv_util::box_err;` binds it", () => {
    expect(resolver().resolve(macroCall("box_err"), ctx(table([TIKV_BOX_ERR]), ["use tikv_util::box_err;"]))).toEqual(
      BOX_ERR_TARGET,
    );
  });

  it("a renamed `use tikv_util::{box_err as be};` binds it under the local name", () => {
    expect(
      resolver().resolve(macroCall("be"), ctx(table([TIKV_BOX_ERR]), ["use tikv_util::{box_err as be};"])),
    ).toEqual(BOX_ERR_TARGET);
  });

  it("the use-bound crate picks its own export even when another crate exports a namesake", () => {
    const twin: MacroSpec = { relPath: "components/other_util/src/lib.rs", name: "box_err", visibility: "public" };
    expect(
      resolver().resolve(macroCall("box_err"), ctx(table([TIKV_BOX_ERR, twin]), ["use tikv_util::box_err;"])),
    ).toEqual(BOX_ERR_TARGET);
  });

  it("a `tikv_util::box_err!` path whose head is a workspace member resolves onto that crate's export", () => {
    const twin: MacroSpec = { relPath: "components/other_util/src/lib.rs", name: "box_err", visibility: "public" };
    expect(resolver().resolve(macroCall("box_err", "tikv_util"), ctx(table([TIKV_BOX_ERR, twin]), []))).toEqual(
      BOX_ERR_TARGET,
    );
  });

  it("a non-exported macro of another crate is never visible through `use`", () => {
    const hidden: MacroSpec = { ...TIKV_BOX_ERR, visibility: "private" };
    expect(resolver().resolve(macroCall("box_err"), ctx(table([hidden]), ["use tikv_util::box_err;"]))).toBeNull();
  });

  it("a non-exported macro of another crate is never visible through a path", () => {
    const hidden: MacroSpec = { ...TIKV_BOX_ERR, visibility: "private" };
    expect(resolver().resolve(macroCall("box_err", "tikv_util"), ctx(table([hidden]), []))).toBeNull();
  });

  it("an external `slog::warn!` stays external although the project declares a fn `warn`", () => {
    const fnWarn: MacroSpec = { relPath: "components/tikv_util/src/lib.rs", name: "warn", kind: "function" };
    expect(resolver().resolve(macroCall("warn", "slog"), ctx(table([fnWarn]), ["use slog::warn;"]))).toBeNull();
  });

  it("a member that re-exports another crate's macro (`use api_version::box_err`) reaches the sole export", () => {
    // servo: `use servo::{pref}` where servo `pub use servo_config::pref`.
    expect(
      resolver().resolve(macroCall("box_err"), ctx(table([TIKV_BOX_ERR]), ["use api_version::{box_err};"])),
    ).toEqual(BOX_ERR_TARGET);
  });

  it("a re-export path through a member (`api_version::tikv_util::box_err!`) keeps the project pick", () => {
    expect(resolver().resolve(macroCall("box_err", "api_version::tikv_util"), ctx(table([TIKV_BOX_ERR]), []))).toEqual(
      BOX_ERR_TARGET,
    );
  });

  it("a re-exporting member never exposes a non-exported macro", () => {
    const hidden: MacroSpec = { ...TIKV_BOX_ERR, visibility: "private" };
    expect(resolver().resolve(macroCall("box_err"), ctx(table([hidden]), ["use api_version::box_err;"]))).toBeNull();
  });

  it("two crates exporting the same macro, with neither imported, give no edge", () => {
    const twin: MacroSpec = { relPath: "components/other_util/src/lib.rs", name: "box_err", visibility: "public" };
    expect(resolver().resolve(macroCall("box_err"), ctx(table([TIKV_BOX_ERR, twin]), []))).toBeNull();
  });
});

describe("cross-crate exported macros — walked end to end (finding 4)", () => {
  function edges(files: Record<string, string>, callerFile: string): string[] {
    const factory = new LanguageFactory({ repoRoot: ROOT, manifestFilesReader: stubReader(MANIFESTS) });
    const language = new RustLanguage();
    const runState = new CodegraphRunState([], new Map(), new Map(), collectTypeDeclarationReaders(factory));
    const symbolTable = new InMemoryGlobalSymbolTable();
    const extractions: FileExtraction[] = [];
    for (const [relPath, code] of Object.entries(files)) {
      const parser = new Parser();
      parser.setLanguage(RustLang);
      const tree = { rootNode: materializeTree(parser.parse(code).rootNode, code) };
      const chunks = collectSymbols(tree, language.walker.nameOf, "::", false, new DefaultSymbolIdComposer());
      const extraction = language.walker.walk({ tree, code, relPath, language: "rust", chunks });
      symbolTable.upsertFile(
        relPath,
        extraction.chunks.map((chunk) => ({
          ...chunk,
          fqName: chunk.symbolId,
          shortName: chunk.symbolId.split(/#|\.|::/).at(-1)!,
          relPath,
        })),
      );
      extractions.push(extraction);
      runState.absorb(extraction, []);
    }
    const runner = new CallEdgeResolutionRunner(factory, runState);
    runner.prepareResolvePass();
    const extraction = extractions.find((entry) => entry.relPath === callerFile)!;
    return runner
      .resolve(extraction, symbolTable)
      .methodEdges.map((edge) => `${edge.sourceSymbolId}->${edge.targetRelPath}:${edge.targetSymbolId}`);
  }

  it("api_v1ttl.rs: `box_err!` inside an impl method reaches tikv_util's exported macro", () => {
    const found = edges(
      {
        "components/tikv_util/src/lib.rs": "#[macro_use]\npub mod macros;\npub mod codec;\n",
        "components/tikv_util/src/macros.rs":
          "/// A shortcut to box an error.\n#[macro_export]\nmacro_rules! box_err {\n    ($e:expr) => {{ $e }};\n}\n",
        "components/api_version/src/lib.rs": "mod api_v1ttl;\npub trait KvFormat {}\npub struct ApiV1Ttl;\n",
        "components/api_version/src/api_v1ttl.rs": [
          "use engine_traits::Result;",
          "use tikv_util::{",
          "    box_err,",
          "    codec::{",
          "        Error,",
          "        number::{self, NumberEncoder},",
          "    },",
          "};",
          "",
          "use super::*;",
          "",
          "impl KvFormat for ApiV1Ttl {",
          "    fn convert(src_api: ApiVersion, key: &[u8]) -> Result<Key> {",
          "        match src_api {",
          '            ApiVersion::V2 => Err(box_err!("unsupported conversion from v2 to v1ttl")),',
          "            _ => Ok(Key::from_encoded_slice(key)),",
          "        }",
          "    }",
          "}",
        ].join("\n"),
      },
      "components/api_version/src/api_v1ttl.rs",
    );
    expect(found.filter((edge) => edge.includes("box_err"))).toEqual([
      "ApiV1Ttl.convert->components/tikv_util/src/macros.rs:box_err",
    ]);
  });
});
