import Parser from "tree-sitter";
import RustLang from "tree-sitter-rust";
import { describe, expect, it } from "vitest";

import { materializeTree } from "../../../../../../src/core/adapters/tree-sitter/materialize.js";
import type { CallContext, FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { RustLanguage } from "../../../../../../src/core/domains/language/rust/index.js";
import { rustPlaceItemPath } from "../../../../../../src/core/domains/language/rust/resolver/declaring-file-type.js";
import { RustWorkspaceCrateMap } from "../../../../../../src/core/domains/language/rust/resolver/workspace-crates.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/**
 * A path as written — `X` bound by a `use`, `a::b::X`, `crate::a::X`,
 * `super::X`, `<crate>::a::X` — placed through the crate module system and
 * the `pub use` chains of intermediate modules (tikv: two `pub struct
 * RpcClient`, the `pd_client` root re-exports `client::RpcClient`).
 */
function fixture(
  files: Record<string, string>,
  manifests: { relDir: string; content: string }[],
  materialize: boolean,
) {
  const language = new RustLanguage();
  const symbolTable = new InMemoryGlobalSymbolTable();
  const extractions: FileExtraction[] = [];
  for (const [relPath, code] of Object.entries(files)) {
    const parser = new Parser();
    parser.setLanguage(RustLang);
    const native = parser.parse(code);
    const tree = materialize ? { rootNode: materializeTree(native.rootNode, code) } : native;
    const chunks = collectSymbols(tree, language.walker.nameOf, "::", false, new DefaultSymbolIdComposer());
    symbolTable.upsertFile(
      relPath,
      chunks.map((chunk) => ({
        ...chunk,
        fqName: chunk.symbolId,
        shortName: chunk.symbolId.split(/#|\.|::/).at(-1)!,
        relPath,
        // The chunker's kind, as production writes it: a CapWords item is the struct.
        symbolKind: /[#.]/.test(chunk.symbolId)
          ? ("method" as const)
          : /^[A-Z]/.test(chunk.symbolId.split("::").at(-1)!)
            ? ("class" as const)
            : ("function" as const),
      })),
    );
    extractions.push(language.walker.walk({ tree, code, relPath, language: "rust", chunks }));
  }
  const structuredReturnTypes = Object.assign({}, ...extractions.map((file) => file.structuredReturnTypes));
  const typeDeclarations = Object.fromEntries(extractions.map((file) => [file.relPath, file.typeDeclarations ?? []]));
  const moduleReexports = Object.fromEntries(extractions.map((file) => [file.relPath, file.moduleReexports ?? []]));
  const rustUseImportsByFile = Object.fromEntries(extractions.map((file) => [file.relPath, file.rustUseImports ?? []]));
  const languageConfig = { crates: RustWorkspaceCrateMap.fromManifests(manifests) };
  const baseCtx = (file: string): CallContext => ({
    callerFile: file,
    callerScope: [],
    imports: extractions.find((entry) => entry.relPath === file)?.imports ?? [],
    symbolTable,
    structuredReturnTypes,
    typeDeclarations,
    moduleReexports,
    rustUseImportsByFile,
    languageConfig,
  });
  return {
    place(path: string, file: string) {
      return rustPlaceItemPath(path, file, baseCtx(file), (def) => def.symbolKind === "class");
    },
    resolve(text: string, file: string) {
      const extraction = extractions.find((entry) => entry.relPath === file)!;
      const chunk = extraction.chunks.find((entry) => entry.calls.some((call) => call.callText === text))!;
      const call = chunk.calls.find((entry) => entry.callText === text)!;
      const ctx: CallContext = {
        ...baseCtx(file),
        callerScope: chunk.scope,
        callerSymbolId: chunk.symbolId,
        localBindings: chunk.localBindings,
        classFieldTypes: extraction.classFieldTypes,
        classFieldTypesByClassKey: extraction.classFieldTypesByClassKey,
        callResultBindings: chunk.callResultBindings,
      };
      return language.resolver.resolve(call, ctx);
    },
  };
}

const MANIFESTS = [
  { relDir: "", content: '[workspace]\nmembers = ["components/pd_client", "cmd/ctl"]\n' },
  { relDir: "components/pd_client", content: '[package]\nname = "pd_client"\nversion = "0.1.0"\n' },
  { relDir: "cmd/ctl", content: '[package]\nname = "ctl"\nversion = "0.1.0"\n' },
];

const PD_CLIENT = {
  "components/pd_client/src/lib.rs": `
mod client;
mod client_v2;
pub use self::{
    client::RpcClient,
    client_v2::{RpcClient as RpcClientV2},
};
`,
  "components/pd_client/src/client.rs": `
pub struct RpcClient;
impl RpcClient {
    pub fn new(cfg: u32) -> RpcClient { RpcClient }
    pub fn get_region(&self) {}
}
`,
  "components/pd_client/src/client_v2.rs": `
pub struct RpcClient;
impl RpcClient {
    pub fn new(cfg: u32) -> RpcClient { RpcClient }
    pub fn get_region(&self) {}
}
`,
};

describe.each([true, false])("Rust item-path placement (materialized=%s)", (materialize) => {
  it("places a `use`-bound name through the crate root's `pub use` that picks one of two namesakes", () => {
    const f = fixture(
      {
        ...PD_CLIENT,
        "cmd/ctl/src/main.rs": "use pd_client::{RpcClient};\nfn main() { let c = RpcClient::new(1); }\n",
      },
      MANIFESTS,
      materialize,
    );
    expect(f.place("RpcClient", "cmd/ctl/src/main.rs")).toEqual({
      targetRelPath: "components/pd_client/src/client.rs",
      targetSymbolId: "RpcClient",
    });
    expect(f.resolve("RpcClient::new(1)", "cmd/ctl/src/main.rs")).toEqual({
      targetRelPath: "components/pd_client/src/client.rs",
      targetSymbolId: "RpcClient.new",
    });
  });

  it("types a binding by `Type::new` placed through the chain, then resolves its method", () => {
    const f = fixture(
      {
        ...PD_CLIENT,
        "cmd/ctl/src/main.rs":
          "use pd_client::RpcClient;\nfn main() {\n    let c = RpcClient::new(1);\n    c.get_region();\n}\n",
      },
      MANIFESTS,
      materialize,
    );
    expect(f.resolve("c.get_region()", "cmd/ctl/src/main.rs")).toEqual({
      targetRelPath: "components/pd_client/src/client.rs",
      targetSymbolId: "RpcClient#get_region",
    });
  });

  it("places a crate-name-qualified path with no `use`", () => {
    const f = fixture(
      { ...PD_CLIENT, "cmd/ctl/src/main.rs": "fn main() { pd_client::RpcClient::new(1); }\n" },
      MANIFESTS,
      materialize,
    );
    expect(f.place("pd_client::RpcClient", "cmd/ctl/src/main.rs")).toEqual({
      targetRelPath: "components/pd_client/src/client.rs",
      targetSymbolId: "RpcClient",
    });
    expect(f.resolve("pd_client::RpcClient::new(1)", "cmd/ctl/src/main.rs")).toEqual({
      targetRelPath: "components/pd_client/src/client.rs",
      targetSymbolId: "RpcClient.new",
    });
  });

  it("follows a multi-hop `pub use` chain", () => {
    const f = fixture(
      {
        "src/lib.rs": "mod api;\npub use self::api::Client;\n",
        "src/api/mod.rs": "mod inner;\npub use self::inner::Client;\n",
        "src/api/inner.rs": "pub struct Client;\nimpl Client { pub fn open() {} }\n",
        "src/other.rs": "pub struct Client;\nimpl Client { pub fn open() {} }\n",
        "src/bin/tool.rs": "use crate::Client;\nfn run() { Client::open(); }\n",
      },
      [],
      materialize,
    );
    expect(f.place("crate::Client", "src/other.rs")).toEqual({
      targetRelPath: "src/api/inner.rs",
      targetSymbolId: "Client",
    });
  });

  it("places `crate::` and `super::` paths onto the module that declares the item", () => {
    const f = fixture(
      {
        "src/lib.rs": "mod store;\nmod other;\n",
        "src/store.rs": "mod sub;\npub struct Engine;\nimpl Engine { pub fn open() {} }\n",
        "src/store/sub.rs": "fn run() { super::Engine::open(); }\n",
        "src/other.rs":
          "pub struct Engine;\nimpl Engine { pub fn open() {} }\nfn go() { crate::store::Engine::open(); }\n",
      },
      [],
      materialize,
    );
    expect(f.place("crate::store::Engine", "src/other.rs")).toEqual({
      targetRelPath: "src/store.rs",
      targetSymbolId: "Engine",
    });
    expect(f.place("super::Engine", "src/store/sub.rs")).toEqual({
      targetRelPath: "src/store.rs",
      targetSymbolId: "Engine",
    });
    expect(f.resolve("crate::store::Engine::open()", "src/other.rs")).toEqual({
      targetRelPath: "src/store.rs",
      targetSymbolId: "Engine.open",
    });
  });

  it("places a `use .. as` rename onto the source item", () => {
    const f = fixture(
      {
        "src/lib.rs": "mod store;\nmod other;\nmod run;\n",
        "src/store.rs": "pub struct Engine;\nimpl Engine { pub fn open() {} }\n",
        "src/other.rs": "pub struct Engine;\nimpl Engine { pub fn open() {} }\n",
        "src/run.rs": "use crate::store::Engine as StoreEngine;\nfn go() { StoreEngine::open(); }\n",
      },
      [],
      materialize,
    );
    expect(f.place("StoreEngine", "src/run.rs")).toEqual({ targetRelPath: "src/store.rs", targetSymbolId: "Engine" });
  });

  it("answers nothing for a name only a glob may bind", () => {
    const f = fixture(
      {
        "src/lib.rs": "mod store;\nmod other;\nmod run;\n",
        "src/store.rs": "pub struct Engine;\nimpl Engine { pub fn open() {} }\n",
        "src/other.rs": "pub struct Engine;\nimpl Engine { pub fn open() {} }\n",
        "src/run.rs": "use crate::store::*;\nuse crate::other::*;\nfn go() { Engine::open(); }\n",
      },
      [],
      materialize,
    );
    expect(f.place("Engine", "src/run.rs")).toBeUndefined();
    expect(f.resolve("Engine::open()", "src/run.rs")).toBeNull();
  });

  it("stops on a `pub use` cycle and answers nothing", () => {
    const f = fixture(
      {
        "src/lib.rs": "mod a;\nmod b;\npub use self::a::Ghost;\n",
        "src/a.rs": "pub use crate::b::Ghost;\n",
        "src/b.rs": "pub use crate::a::Ghost;\n",
        "src/c.rs": "pub struct Ghost;\n",
        "src/d.rs": "pub struct Ghost;\n",
      },
      [],
      materialize,
    );
    expect(f.place("crate::Ghost", "src/c.rs")).toBeUndefined();
  });

  it("resolves a module-path call `<crate>::a::f(..)` onto the free fn among namesakes", () => {
    const f = fixture(
      {
        "components/tikv_util/src/lib.rs": "pub mod mpsc;\n",
        "components/tikv_util/src/mpsc/mod.rs": "pub fn unbounded() {}\n",
        "components/tikv_util/src/other.rs": "pub fn unbounded() {}\n",
        "cmd/ctl/src/main.rs": "fn main() { tikv_util::mpsc::unbounded(); }\n",
      },
      [
        { relDir: "components/tikv_util", content: '[package]\nname = "tikv_util"\nversion = "0.1.0"\n' },
        { relDir: "cmd/ctl", content: '[package]\nname = "ctl"\nversion = "0.1.0"\n' },
      ],
      materialize,
    );
    expect(f.resolve("tikv_util::mpsc::unbounded()", "cmd/ctl/src/main.rs")).toEqual({
      targetRelPath: "components/tikv_util/src/mpsc/mod.rs",
      targetSymbolId: "unbounded",
    });
  });

  it("places a child-module-qualified path from the parent module", () => {
    const f = fixture(
      {
        "src/lib.rs": "mod store;\nmod other;\nfn go() { store::Engine::open(); }\n",
        "src/store.rs": "pub struct Engine;\nimpl Engine { pub fn open() {} }\n",
        "src/other.rs": "pub struct Engine;\nimpl Engine { pub fn open() {} }\n",
      },
      [],
      materialize,
    );
    expect(f.place("store::Engine", "src/lib.rs")).toEqual({ targetRelPath: "src/store.rs", targetSymbolId: "Engine" });
  });
});
