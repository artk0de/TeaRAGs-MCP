/**
 * bd tea-rags-mcp-m99j1.1.24 (Task 22, K11) — the undecidable denominator.
 *
 * A miss the resolver proves statically undecidable (`targetsUndecidable`) is
 * counted `unresolvable` and leaves the `resolveSuccessRate` /
 * `inProjectEdgeRecall` denominator, exactly like a dynamic send. The
 * classification only MOVES a residual `missWithInProjectDef` row:
 *
 *  - a RESOLVED call never reaches the classifier;
 *  - a member with no in-project definition stays `noInProjectDef`, so the
 *    buckets the earlier gates own stay byte-identical;
 *  - nothing it does emits an edge.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import type { CallRef } from "../../../../../../src/core/contracts/types/codegraph.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolvePath(__dirname, "../../../../../../src/core/domains/maintenance/migration/database/migrations");

interface RunMetricsShape {
  callsResolved: number;
  callsUnresolvable: number;
  callsNoInProjectDef: number;
  inProjectEdgeRecall: number;
}

describe("CodegraphEnrichmentProvider — undecidable denominator (K11)", () => {
  let tmp: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-undecidable-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, MIG_DIR);
    provider = new CodegraphEnrichmentProvider({
      graphDb: client,
      symbolTable: new InMemoryGlobalSymbolTable(),
      ...buildTestCodegraphDeps(),
      composer: new DefaultSymbolIdComposer(),
      collectSymbols,
    });
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * `Proxy` answers attribute lookup through `__getattr__`; `Child(Proxy)`
   * inherits it and is where the calls are made. `Other#missing` keeps
   * `missing` declared in-project, so without the carve-out the site is a
   * residual `missWithInProjectDef` hole.
   */
  const runWith = async (hookClass: "Proxy" | "Plain", calls: CallRef[]): Promise<RunMetricsShape> => {
    const sink = provider.asExtractionSink();
    await sink.write({
      relPath: "app/other.py",
      language: "python",
      imports: [],
      chunks: [{ symbolId: "Other#missing", scope: ["Other"], calls: [], startLine: 2, endLine: 3 }],
      fileScope: ["Other"],
    });
    await sink.write({
      relPath: "app/proxy.py",
      language: "python",
      imports: [],
      classAncestors: { "app/proxy.py::Child": [hookClass] },
      chunks: [
        { symbolId: hookClass, scope: [], calls: [], startLine: 1, endLine: 6 },
        ...(hookClass === "Proxy"
          ? [{ symbolId: "Proxy#__getattr__", scope: ["Proxy"], calls: [], startLine: 2, endLine: 3 }]
          : []),
        { symbolId: `${hookClass}#present`, scope: [hookClass], calls: [], startLine: 4, endLine: 5 },
        { symbolId: "Child", scope: [], calls: [], startLine: 8, endLine: 14 },
        { symbolId: "Child#run", scope: ["Child"], calls, startLine: 9, endLine: 14 },
      ],
      fileScope: [hookClass, "Child"],
    });
    await sink.finish();
    return provider.getRunMetrics() as unknown as RunMetricsShape;
  };

  const present: CallRef = { callText: "self.present()", receiver: "self", member: "present", startLine: 10 };
  const missing: CallRef = { callText: "self.missing()", receiver: "self", member: "missing", startLine: 11 };
  const nowhere: CallRef = { callText: "self.nowhere()", receiver: "self", member: "nowhere", startLine: 12 };

  it("counts an undecidable miss as unresolvable and drops it from the recall denominator", async () => {
    const m = await runWith("Proxy", [present, missing]);
    expect(m.callsResolved).toBe(1);
    expect(m.callsUnresolvable).toBe(1);
    expect(m.inProjectEdgeRecall).toBe(1);
  });

  it("keeps the same miss a recall hole when no class on the MRO defines a lookup hook", async () => {
    const m = await runWith("Plain", [present, missing]);
    expect(m.callsResolved).toBe(1);
    expect(m.callsUnresolvable).toBe(0);
    expect(m.inProjectEdgeRecall).toBe(0.5);
  });

  it("leaves a member with no in-project definition in noInProjectDef", async () => {
    const m = await runWith("Proxy", [present, nowhere]);
    expect(m.callsNoInProjectDef).toBe(1);
    expect(m.callsUnresolvable).toBe(0);
  });
});
