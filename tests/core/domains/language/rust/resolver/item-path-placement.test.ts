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

  it("keeps the pre-placement read of an instance method on a constructor head `T::new(..).m()`", () => {
    const f = fixture(
      {
        "components/tikv_util/src/lib.rs": "pub mod worker;\npub mod yatp_pool;\n",
        "components/tikv_util/src/worker/mod.rs": "mod pool;\npub use pool::{\n    Builder, LazyWorker,\n};\n",
        "components/tikv_util/src/worker/pool.rs": `
pub struct LazyWorker;
#[derive(Copy, Clone)]
pub struct Builder<S: Into<String>> { name: S, thread_count: usize }
impl<S: Into<String>> Builder<S> {
    pub fn new(name: S) -> Self { Builder { name, thread_count: 1 } }
    pub fn thread_count(mut self, thread_count: usize) -> Self { self }
}
`,
        "components/tikv_util/src/yatp_pool.rs":
          "pub struct Builder;\nimpl Builder {\n    pub fn new() -> Builder { Builder }\n}\npub struct YatpPoolBuilder;\nimpl YatpPoolBuilder {\n    pub fn thread_count(self, n: usize) -> Self { self }\n}\n",
        "cmd/ctl/src/main.rs": `
use tikv_util::{memory::MemoryQuota, worker::Worker};
pub struct Watchdog;
mod tests {
    use std::{sync::Arc, time::Duration};

    use tikv_util::{memory::MemoryQuota, worker::Builder};

    use super::*;

    #[test]
    fn go() { let pool = Arc::new(Builder::new("cdc").thread_count(1).create()); }
}
`,
      },
      [
        { relDir: "components/tikv_util", content: '[package]\nname = "tikv_util"\nversion = "0.1.0"\n' },
        { relDir: "cmd/ctl", content: '[package]\nname = "ctl"\nversion = "0.1.0"\n' },
      ],
      materialize,
    );
    expect(f.resolve('Builder::new("cdc").thread_count(1)', "cmd/ctl/src/main.rs")).toEqual({
      targetRelPath: "components/tikv_util/src/worker/pool.rs",
      targetSymbolId: "Builder#thread_count",
    });
  });

  it("does not drop an enum-variant call on a qualified path the placement types", () => {
    const f = fixture(
      {
        "components/raftstore/src/lib.rs": "pub mod store;\n",
        "components/raftstore/src/store/mod.rs": "mod write;\npub use self::write::{WriteMsg, WriteTask};\n",
        "components/raftstore/src/store/write.rs":
          "pub struct WriteTask;\npub enum WriteMsg {\n    WriteTask(WriteTask),\n    Shutdown,\n}\n",
        "cmd/ctl/src/main.rs":
          "use raftstore::store::WriteTask;\nfn go(task: WriteTask) { let m = raftstore::store::WriteMsg::WriteTask(task); }\n",
      },
      [
        { relDir: "components/raftstore", content: '[package]\nname = "raftstore"\nversion = "0.1.0"\n' },
        { relDir: "cmd/ctl", content: '[package]\nname = "ctl"\nversion = "0.1.0"\n' },
      ],
      materialize,
    );
    expect(f.resolve("raftstore::store::WriteMsg::WriteTask(task)", "cmd/ctl/src/main.rs")).not.toBeNull();
  });

  it("refuses a placement-only answer for an argument-dispatched conversion `T::from(..)`", () => {
    const f = fixture(
      {
        "src/lib.rs": "mod errors;\nmod kv;\nmod other;\nmod run;\n",
        "src/errors.rs":
          "pub struct Error;\nimpl From<u32> for Error {\n    fn from(e: u32) -> Self { Error }\n}\nimpl Error {\n    pub fn report(&self) {}\n}\n",
        "src/kv.rs": "pub struct Error;\nimpl From<u8> for Error {\n    fn from(e: u8) -> Self { Error }\n}\n",
        "src/other.rs": "pub struct Error;\nimpl From<u16> for Error {\n    fn from(e: u16) -> Self { Error }\n}\n",
        "src/run.rs":
          "use crate::errors::Error;\nuse crate::kv;\nfn go() {\n    Error::from(1);\n    kv::Error::from(2);\n}\n",
      },
      [],
      materialize,
    );
    expect(f.resolve("Error::from(1)", "src/run.rs")).toBeNull();
    expect(f.resolve("kv::Error::from(2)", "src/run.rs")).toBeNull();
  });

  it("does not answer a re-exported macro-generated type's assoc fn with another type's namesake", () => {
    const f = fixture(
      {
        "src/lib.rs": "pub mod coprocessor;\nmod other;\n",
        "src/coprocessor/mod.rs":
          "mod dispatcher;\nmod region_info_accessor;\npub use self::dispatcher::{BoxRoleObserver, CoprocessorHost};\n",
        "src/coprocessor/dispatcher.rs":
          "impl_box_observer!(BoxRoleObserver, RoleObserver, WrappedRoleObserver);\npub struct CoprocessorHost;\nimpl CoprocessorHost {\n    pub fn new() -> Self { CoprocessorHost }\n}\n",
        "src/other.rs": "pub struct Other;\nimpl Other {\n    pub fn new() -> Self { Other }\n}\n",
        "src/coprocessor/region_info_accessor.rs":
          "use super::{BoxRoleObserver, CoprocessorHost};\nfn go() { let o = BoxRoleObserver::new(1); }\n",
      },
      [],
      materialize,
    );
    expect(f.resolve("BoxRoleObserver::new(1)", "src/coprocessor/region_info_accessor.rs")).toBeNull();
  });

  it("keeps the drop of a local whose placed type derefs to an external type that hides the member", () => {
    const f = fixture(
      {
        "components/engine_rocks/src/lib.rs": "mod cf_options;\npub use cf_options::RocksCfOptions;\n",
        "components/engine_rocks/src/cf_options.rs": `
use std::ops::Deref;
use rocksdb::ColumnFamilyOptions as RawCfOptions;
pub struct RocksCfOptions(RawCfOptions);
impl RocksCfOptions {
    pub fn new() -> Self { RocksCfOptions(RawCfOptions::new()) }
}
impl Deref for RocksCfOptions {
    type Target = RawCfOptions;
    fn deref(&self) -> &RawCfOptions { &self.0 }
}
`,
        "components/engine_rocks/src/other.rs": "pub struct RocksCfOptions;\n",
        "components/engine_test/src/lib.rs": `
pub mod ctor {
    pub struct CfOptions;
    impl CfOptions {
        pub fn set_trigger(&mut self, t: u32) {}
    }
    mod rocks {
        use engine_rocks::RocksCfOptions;
        fn get() {
            let mut rocks_cf_opts = RocksCfOptions::new();
            rocks_cf_opts.set_trigger(1);
        }
    }
}
`,
      },
      [
        { relDir: "components/engine_rocks", content: '[package]\nname = "engine_rocks"\nversion = "0.1.0"\n' },
        { relDir: "components/engine_test", content: '[package]\nname = "engine_test"\nversion = "0.1.0"\n' },
      ],
      materialize,
    );
    expect(f.resolve("rocks_cf_opts.set_trigger(1)", "components/engine_test/src/lib.rs")).toBeNull();
  });
});
