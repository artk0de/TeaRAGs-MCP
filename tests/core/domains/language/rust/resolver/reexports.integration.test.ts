import Parser from "tree-sitter";
import RustLang from "tree-sitter-rust";
import { describe, expect, it } from "vitest";

import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph-extraction.js";
import { LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import {
  extractFromRustFile,
  type RustExtractInput,
} from "../../../../../../src/core/domains/language/rust/walker/walker.js";
import { CallEdgeResolutionRunner } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/resolution-runner.js";
import { CodegraphRunState } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function extract(relPath: string, code: string, chunks: RustExtractInput["chunks"] = []): FileExtraction {
  const parser = new Parser();
  parser.setLanguage(RustLang);
  return extractFromRustFile({
    tree: parser.parse(code),
    code,
    relPath,
    language: "rust",
    chunks,
  });
}

describe("Rust pub-use extraction through resolver context", () => {
  it("forwards real pub-use facts while excluding private use statements", () => {
    const facade = extract(
      "src/facade.rs",
      [
        "pub use crate::api::run as public;",
        "pub use crate::foo::{bar as grouped, baz};",
        "pub use crate::foo::*;",
        "use crate::private::run as hidden;",
      ].join("\n"),
    );

    expect(facade.moduleReexports).toEqual([
      { exportedName: "public", sourceModule: "crate::api", sourceName: "run" },
      { exportedName: "grouped", sourceModule: "crate::foo", sourceName: "bar" },
      { exportedName: "baz", sourceModule: "crate::foo", sourceName: "baz" },
      { exportedName: "*", sourceModule: "crate::foo" },
    ]);
    expect(facade.imports.map(({ importText }) => importText)).toEqual([
      "crate::api::run as public",
      "crate::foo::{bar as grouped, baz}",
      "crate::foo::*",
      "crate::private::run as hidden",
    ]);

    const caller = extract("src/main.rs", "use crate::facade::public;\nfn main() { public(); }\n", [
      { symbolId: "main", scope: [], startLine: 2, endLine: 2 },
    ]);
    const state = new CodegraphRunState();
    state.absorb(facade, []);

    const symbols = new InMemoryGlobalSymbolTable();
    symbols.upsertFile("src/api.rs", [
      { symbolId: "run", fqName: "run", shortName: "run", relPath: "src/api.rs", scope: [] },
    ]);

    const edges = new CallEdgeResolutionRunner(new LanguageFactory(), state).resolve(caller, symbols);

    expect(edges.methodEdges).toEqual([
      {
        sourceSymbolId: "main",
        targetRelPath: "src/api.rs",
        targetSymbolId: "run",
        callExpression: "public()",
      },
    ]);
  });
});

/**
 * importMatch pins `use crate::{store::find_peer}` to `src/store/mod.rs`; the
 * name lives one `pub use` away (bd tea-rags-mcp-s3i8m.8 — tikv
 * `components/tikv_util/src/store/mod.rs`, servo `dom/element/mod.rs`).
 */
describe("Rust importMatch follows pub use re-exports of the pinned module", () => {
  interface Def {
    relPath: string;
    name: string;
  }

  function resolveBareCall(input: {
    callerImport: string;
    call: string;
    modules: Record<string, string>;
    defs: Def[];
  }): { targetRelPath: string; targetSymbolId: string | null }[] {
    const state = new CodegraphRunState();
    const symbols = new InMemoryGlobalSymbolTable();
    const declared = new Set(input.defs.map((def) => def.relPath));
    for (const [relPath, code] of Object.entries(input.modules)) {
      state.absorb(extract(relPath, code), []);
      if (!declared.has(relPath)) symbols.upsertFile(relPath, []);
    }
    const byFile = new Map<string, Def[]>();
    for (const def of input.defs) byFile.set(def.relPath, [...(byFile.get(def.relPath) ?? []), def]);
    for (const [relPath, defs] of byFile) {
      symbols.upsertFile(
        relPath,
        defs.map((def) => ({ symbolId: def.name, fqName: def.name, shortName: def.name, relPath, scope: [] })),
      );
    }
    const caller = extract("src/main.rs", `use ${input.callerImport};\nfn main() { ${input.call}; }\n`, [
      { symbolId: "main", scope: [], startLine: 2, endLine: 2 },
    ]);
    const edges = new CallEdgeResolutionRunner(new LanguageFactory(), state).resolve(caller, symbols);
    return edges.methodEdges.map(({ targetRelPath, targetSymbolId }) => ({ targetRelPath, targetSymbolId }));
  }

  const peer: Def = { relPath: "src/store/peer.rs", name: "find_peer" };
  const util: Def = { relPath: "src/util.rs", name: "noop" };

  it("records every leaf of a nested pub use tree with its full source module", () => {
    const facade = extract(
      "src/store/mod.rs",
      "pub use self::{\n    peer::{find_peer, new_peer as np},\n    region::*,\n};\n",
    );
    expect(facade.moduleReexports).toEqual([
      { exportedName: "find_peer", sourceModule: "self::peer", sourceName: "find_peer" },
      { exportedName: "np", sourceModule: "self::peer", sourceName: "new_peer" },
      { exportedName: "*", sourceModule: "self::region" },
    ]);
  });

  it("follows a glob re-export (`pub use self::peer::*`)", () => {
    expect(
      resolveBareCall({
        callerImport: "crate::{util, store::find_peer}",
        call: "find_peer()",
        modules: { "src/store/mod.rs": "pub mod peer;\npub use self::peer::*;\n" },
        defs: [peer, util],
      }),
    ).toEqual([{ targetRelPath: "src/store/peer.rs", targetSymbolId: "find_peer" }]);
  });

  it("follows a named re-export written relative to the module (`pub use peer::find_peer`)", () => {
    expect(
      resolveBareCall({
        callerImport: "crate::{util, store::find_peer}",
        call: "find_peer()",
        modules: { "src/store/mod.rs": "pub mod peer;\npub use peer::find_peer;\n" },
        defs: [peer, util],
      }),
    ).toEqual([{ targetRelPath: "src/store/peer.rs", targetSymbolId: "find_peer" }]);
  });

  it("follows a nested named re-export (`pub use self::{peer::{find_peer}}`)", () => {
    expect(
      resolveBareCall({
        callerImport: "crate::{util, store::find_peer}",
        call: "find_peer()",
        modules: { "src/store/mod.rs": "pub mod peer;\npub use self::{peer::{find_peer, new_peer}};\n" },
        defs: [peer, util],
      }),
    ).toEqual([{ targetRelPath: "src/store/peer.rs", targetSymbolId: "find_peer" }]);
  });

  it("follows a renamed re-export (`pub use peer::{find_peer as fp}`)", () => {
    expect(
      resolveBareCall({
        callerImport: "crate::{util, store::fp}",
        call: "fp()",
        modules: { "src/store/mod.rs": "pub mod peer;\npub use peer::{find_peer as fp};\n" },
        defs: [peer, util],
      }),
    ).toEqual([{ targetRelPath: "src/store/peer.rs", targetSymbolId: "find_peer" }]);
  });

  it("follows a two-hop chain (`store` → `store::inner` → `super::peer`)", () => {
    expect(
      resolveBareCall({
        callerImport: "crate::{util, store::find_peer}",
        call: "find_peer()",
        modules: {
          "src/store/mod.rs": "mod inner;\npub use self::inner::find_peer;\n",
          "src/store/inner.rs": "pub use super::peer::find_peer;\n",
        },
        defs: [peer, util],
      }),
    ).toEqual([{ targetRelPath: "src/store/peer.rs", targetSymbolId: "find_peer" }]);
  });

  it("continues to the later passes when the module re-exports a glob it cannot expand", () => {
    expect(
      resolveBareCall({
        callerImport: "crate::{util, store::find_peer}",
        call: "find_peer()",
        modules: { "src/store/mod.rs": "pub use some_external_crate::*;\n" },
        defs: [{ relPath: "src/vendored/peer.rs", name: "find_peer" }, util],
      }),
    ).toEqual([{ targetRelPath: "src/vendored/peer.rs", targetSymbolId: "find_peer" }]);
  });

  it("drops when the module neither declares nor re-exports the name", () => {
    expect(
      resolveBareCall({
        callerImport: "crate::{util, store::find_peer}",
        call: "find_peer()",
        modules: { "src/store/mod.rs": "pub mod region;\npub use self::region::check;\n" },
        defs: [
          { relPath: "src/store/region.rs", name: "check" },
          { relPath: "src/elsewhere.rs", name: "find_peer" },
          util,
        ],
      }),
    ).toEqual([]);
  });

  it("keeps a std import external even when the project defines the name", () => {
    expect(
      resolveBareCall({
        callerImport: "std::{cmp::{max, min}}",
        call: "max(1, 2)",
        modules: {},
        defs: [{ relPath: "src/elsewhere.rs", name: "max" }],
      }),
    ).toEqual([]);
  });
});
