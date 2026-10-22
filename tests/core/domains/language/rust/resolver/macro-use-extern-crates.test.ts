/**
 * bd tea-rags-mcp-s3i8m.4 (B2) — a bare `m!` with no in-crate `macro_rules! m`
 * and no `use` binding reaches a `#[macro_export]` macro through the caller
 * crate root's `#[macro_use] extern crate` list. The LAST macro_use crate known
 * to export `m` wins: a workspace member declaring an exported `m`, or an
 * external crate whose exports the resolver knows (log, slog, tracing, …),
 * which classifies the call external. An unknown external crate met first
 * declines — its shadowing cannot be proven.
 */
import Parser from "tree-sitter";
import RustLang from "tree-sitter-rust";
import { describe, expect, it, vi } from "vitest";

import { materializeTree } from "../../../../../../src/core/adapters/tree-sitter/materialize.js";
import type {
  CallContext,
  CallRef,
  FileExtraction,
  RustMacroUseCrate,
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

const ROOT = "/nonexistent/s3i8m4-b2-root";

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

interface MacroSpec {
  relPath: string;
  name: string;
  visibility?: SymbolDefinition["visibility"];
}

const CRATE_ROOTS = [
  "components/tikv_util/src/lib.rs",
  "components/api_version/src/lib.rs",
  "components/other_util/src/lib.rs",
];

function table(macros: MacroSpec[]): InMemoryGlobalSymbolTable {
  const t = new InMemoryGlobalSymbolTable();
  const byFile = new Map<string, MacroSpec[]>(CRATE_ROOTS.map((relPath) => [relPath, []]));
  for (const m of macros) byFile.set(m.relPath, [...(byFile.get(m.relPath) ?? []), m]);
  for (const [relPath, specs] of byFile) {
    t.upsertFile(
      relPath,
      specs.map((m) => ({
        symbolId: m.name,
        fqName: m.name,
        shortName: m.name,
        relPath,
        scope: [],
        symbolKind: "macro" as const,
        startLine: 10,
        endLine: 12,
        ...(m.visibility !== undefined ? { visibility: m.visibility } : {}),
      })),
    );
  }
  return t;
}

const CALLER = "components/api_version/src/api_v1ttl.rs";
const CALLER_ROOT = "components/api_version/src/lib.rs";

const TIKV_BOX_ERR: MacroSpec = {
  relPath: "components/tikv_util/src/macros.rs",
  name: "box_err",
  visibility: "public",
};
const TIKV_WARN: MacroSpec = { relPath: "components/tikv_util/src/log.rs", name: "warn", visibility: "public" };
const OTHER_BOX_ERR: MacroSpec = { relPath: "components/other_util/src/lib.rs", name: "box_err", visibility: "public" };

function ctx(t: InMemoryGlobalSymbolTable, macroUse: RustMacroUseCrate[]): CallContext {
  return {
    callerFile: CALLER,
    callerScope: [],
    imports: [],
    symbolTable: t,
    projectRoot: ROOT,
    rustMacroUseCratesByFile: { [CALLER_ROOT]: macroUse },
  };
}

function crate(crateName: string, line: number, extra: Partial<RustMacroUseCrate> = {}): RustMacroUseCrate {
  return { crateName, line, ...extra };
}

function bare(member: string): CallRef {
  return { callText: `${member}!(e)`, receiver: null, member, startLine: 73 };
}

const TIKV_BOX_ERR_TARGET = { targetRelPath: "components/tikv_util/src/macros.rs", targetSymbolId: "box_err" };

describe("#[macro_use] extern crate — bare macro scoping (s3i8m.4 B2)", () => {
  it("a macro_use workspace crate's exported macro is reachable bare", () => {
    expect(resolver().resolve(bare("box_err"), ctx(table([TIKV_BOX_ERR]), [crate("tikv_util", 1)]))).toEqual(
      TIKV_BOX_ERR_TARGET,
    );
  });

  it("a later `#[macro_use] extern crate log` shadows the workspace crate's warn! — external, no edge", () => {
    const macroUse = [crate("tikv_util", 1), crate("log", 3)];
    expect(resolver().resolve(bare("warn"), ctx(table([TIKV_WARN]), macroUse))).toBeNull();
  });

  it("an earlier log does not shadow a later workspace crate exporting warn!", () => {
    const macroUse = [crate("log", 1), crate("tikv_util", 3)];
    expect(resolver().resolve(bare("warn"), ctx(table([TIKV_WARN]), macroUse))).toEqual({
      targetRelPath: "components/tikv_util/src/log.rs",
      targetSymbolId: "warn",
    });
  });

  it("a later unknown external crate declines — its shadowing cannot be proven", () => {
    const macroUse = [crate("tikv_util", 1), crate("mystery_macros", 3)];
    expect(resolver().resolve(bare("box_err"), ctx(table([TIKV_BOX_ERR]), macroUse))).toBeNull();
  });

  it("an earlier unknown external crate never shadows a later exporter", () => {
    const macroUse = [crate("mystery_macros", 1), crate("tikv_util", 3)];
    expect(resolver().resolve(bare("box_err"), ctx(table([TIKV_BOX_ERR]), macroUse))).toEqual(TIKV_BOX_ERR_TARGET);
  });

  it("a renamed `extern crate tikv_util as tu` still brings its macros in", () => {
    expect(
      resolver().resolve(bare("box_err"), ctx(table([TIKV_BOX_ERR]), [crate("tikv_util", 1, { alias: "tu" })])),
    ).toEqual(TIKV_BOX_ERR_TARGET);
  });

  it("an in-crate macro_rules! wins over a macro_use crate", () => {
    const local: MacroSpec = { relPath: "components/api_version/src/macros.rs", name: "box_err" };
    expect(resolver().resolve(bare("box_err"), ctx(table([TIKV_BOX_ERR, local]), [crate("tikv_util", 1)]))).toEqual({
      targetRelPath: "components/api_version/src/macros.rs",
      targetSymbolId: "box_err",
    });
  });

  it("a non-exported macro of the macro_use crate stays invisible", () => {
    const hidden: MacroSpec = { ...TIKV_BOX_ERR, visibility: "private" };
    expect(resolver().resolve(bare("box_err"), ctx(table([hidden]), [crate("tikv_util", 1)]))).toBeNull();
  });

  it("two workspace crates exporting the macro — the last macro_use wins", () => {
    const macroUse = [crate("tikv_util", 1), crate("other_util", 3)];
    expect(resolver().resolve(bare("box_err"), ctx(table([TIKV_BOX_ERR, OTHER_BOX_ERR]), macroUse))).toEqual({
      targetRelPath: "components/other_util/src/lib.rs",
      targetSymbolId: "box_err",
    });
  });

  it("a `#[macro_use(other)]` list that omits the macro does not provide it", () => {
    const macroUse = [crate("tikv_util", 1), crate("other_util", 3, { macros: ["other"] })];
    expect(resolver().resolve(bare("box_err"), ctx(table([TIKV_BOX_ERR, OTHER_BOX_ERR]), macroUse))).toEqual(
      TIKV_BOX_ERR_TARGET,
    );
  });

  it("a workspace crate that exports nothing of the name is skipped, not unknown", () => {
    const macroUse = [crate("tikv_util", 1), crate("other_util", 3)];
    expect(resolver().resolve(bare("box_err"), ctx(table([TIKV_BOX_ERR]), macroUse))).toEqual(TIKV_BOX_ERR_TARGET);
  });

  it("an external `use slog_global::info` shadows the macro_use prelude — no edge", () => {
    const tikvInfo: MacroSpec = { relPath: "components/tikv_util/src/log.rs", name: "info", visibility: "public" };
    const context = {
      ...ctx(table([tikvInfo]), [crate("tikv_util", 1)]),
      imports: [{ importText: "use slog_global::info;", startLine: 1 }],
    };
    expect(resolver().resolve(bare("info"), context)).toBeNull();
  });

  it("a std module of the same name (`use std::error`) binds no macro and does not shadow", () => {
    const tikvError: MacroSpec = { relPath: "components/tikv_util/src/log.rs", name: "error", visibility: "public" };
    const context = {
      ...ctx(table([tikvError]), [crate("tikv_util", 1)]),
      imports: [{ importText: "use std::{error, result};", startLine: 1 }],
    };
    expect(resolver().resolve(bare("error"), context)).toEqual({
      targetRelPath: "components/tikv_util/src/log.rs",
      targetSymbolId: "error",
    });
  });

  it("without a macro_use list the call stays unresolved, as before", () => {
    expect(resolver().resolve(bare("box_err"), ctx(table([TIKV_BOX_ERR]), []))).toBeNull();
  });
});

describe("#[macro_use] extern crate — walked end to end (s3i8m.4 B2)", () => {
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
    // The workspace crate map is read from the project root the run binds.
    runState.bindProjectRoot(ROOT);
    const runner = new CallEdgeResolutionRunner(factory, runState);
    runner.prepareResolvePass();
    const extraction = extractions.find((entry) => entry.relPath === callerFile)!;
    return runner
      .resolve(extraction, symbolTable)
      .methodEdges.map((edge) => `${edge.sourceSymbolId}->${edge.targetRelPath}:${edge.targetSymbolId}`);
  }

  it("a submodule's bare box_err! reaches tikv_util through the crate root's #[macro_use] extern crate", () => {
    const found = edges(
      {
        "components/tikv_util/src/lib.rs": "#[macro_use]\npub mod macros;\n",
        "components/tikv_util/src/macros.rs":
          "#[macro_export]\nmacro_rules! box_err {\n    ($e:expr) => {{ $e }};\n}\n",
        "components/api_version/src/lib.rs": "#[macro_use]\nextern crate tikv_util;\n\nmod api_v1ttl;\n",
        "components/api_version/src/api_v1ttl.rs":
          'pub fn convert() -> u32 {\n    box_err!("unsupported");\n    1\n}\n',
      },
      "components/api_version/src/api_v1ttl.rs",
    );
    expect(found.filter((edge) => edge.includes("box_err"))).toEqual([
      "convert->components/tikv_util/src/macros.rs:box_err",
    ]);
  });
});
