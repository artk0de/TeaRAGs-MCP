import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { RubyCallResolver } from "../../../../../../src/core/domains/language/ruby/resolver/ruby-resolver.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { runMigrations } from "../../../../../../src/core/infra/migration/database/runner.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolve(__dirname, "../../../../../../src/core/infra/migration/database/migrations");

// A class file: a class symbol chunk + an instance-method chunk, optional super.
function rubyClass(name: string, method: string, parent?: string): FileExtraction {
  const ext: FileExtraction = {
    relPath: `app/${name.toLowerCase()}.rb`,
    language: "ruby",
    imports: [],
    fileScope: [name],
    chunks: [
      { symbolId: name, scope: [], calls: [] },
      { symbolId: `${name}#${method}`, scope: [name], calls: [] },
    ],
  };
  if (parent) ext.inheritanceEdges = [{ source: name, ancestor: parent, kind: "super", ordinal: 0 }];
  return ext;
}

describe("CodegraphEnrichmentProvider — CHA cone dispatch end-to-end (bd tea-rags-mcp-o17v2)", () => {
  let tmp: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-prov-cone-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, MIG_DIR);
    provider = new CodegraphEnrichmentProvider({
      graphDb: client,
      symbolTable: new InMemoryGlobalSymbolTable(),
      ...buildTestCodegraphDeps(new Map([["ruby", new RubyCallResolver()]])),
      composer: new DefaultSymbolIdComposer(),
      collectSymbols,
    });
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("fans a polymorphic typed-receiver call out to overriding subtypes (cone)", async () => {
    const sink = provider.asExtractionSink();
    await sink.write(rubyClass("Animal", "speak"));
    await sink.write(rubyClass("Dog", "speak", "Animal"));
    await sink.write(rubyClass("Cat", "speak", "Animal"));
    // The dispatch site: `animal = Animal.new; animal.speak` — localBinding pins
    // the receiver to Animal, whose descendants Dog/Cat override #speak.
    await sink.write({
      relPath: "app/zoo_keeper.rb",
      language: "ruby",
      imports: [],
      fileScope: ["ZooKeeper"],
      chunks: [
        {
          symbolId: "ZooKeeper#make_noise",
          scope: ["ZooKeeper"],
          localBindings: { animal: [{ line: 1, type: "Animal" }] },
          calls: [{ callText: "animal.speak", receiver: "animal", member: "speak", startLine: 1 }],
        },
      ],
    });
    await sink.finish();

    const callees = await client.getCallees("ZooKeeper#make_noise");
    expect(callees.map((c) => c.targetSymbolId).sort()).toEqual(["Cat#speak", "Dog#speak"]);
  });

  it("collapses an over-K cone to a poly-base edge (base persisted, subtypes query-expanded)", async () => {
    // Force coneMax=1 so a 2-subtype cone exceeds the threshold and the engine
    // persists ONE poly-base edge to the base declaration (Animal#speak) instead
    // of N cone edges. get_callees then EXPANDS that poly-base edge back to the
    // overriding subtypes via the reverse index — so the distinguishing marker
    // vs the cone case is that the BASE method (Animal#speak) is present too.
    // The resolver reads CODEGRAPH_RB_CONE_MAX at construction.
    const prev = process.env.CODEGRAPH_RB_CONE_MAX;
    process.env.CODEGRAPH_RB_CONE_MAX = "1";
    try {
      const polyProvider = new CodegraphEnrichmentProvider({
        graphDb: client,
        symbolTable: new InMemoryGlobalSymbolTable(),
        ...buildTestCodegraphDeps(new Map([["ruby", new RubyCallResolver()]])),
        composer: new DefaultSymbolIdComposer(),
        collectSymbols,
      });
      const sink = polyProvider.asExtractionSink();
      await sink.write(rubyClass("Animal", "speak"));
      await sink.write(rubyClass("Dog", "speak", "Animal"));
      await sink.write(rubyClass("Cat", "speak", "Animal"));
      await sink.write({
        relPath: "app/zoo_keeper.rb",
        language: "ruby",
        imports: [],
        fileScope: ["ZooKeeper"],
        chunks: [
          {
            symbolId: "ZooKeeper#make_noise",
            scope: ["ZooKeeper"],
            localBindings: { animal: [{ line: 1, type: "Animal" }] },
            calls: [{ callText: "animal.speak", receiver: "animal", member: "speak", startLine: 1 }],
          },
        ],
      });
      await sink.finish();

      const callees = await client.getCallees("ZooKeeper#make_noise");
      // Poly-base: the base Animal#speak is persisted + the subtypes are
      // query-expanded. The base's presence is what distinguishes poly-base
      // from a plain cone (which would emit only Cat#speak + Dog#speak).
      expect(callees.map((c) => c.targetSymbolId).sort()).toEqual(["Animal#speak", "Cat#speak", "Dog#speak"]);
    } finally {
      if (prev === undefined) delete process.env.CODEGRAPH_RB_CONE_MAX;
      else process.env.CODEGRAPH_RB_CONE_MAX = prev;
    }
  });
});
