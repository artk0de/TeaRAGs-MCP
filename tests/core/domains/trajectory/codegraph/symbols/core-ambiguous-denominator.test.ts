/**
 * bd tea-rags-mcp-83cl7 — core-homonym denominator.
 *
 * `missWithInProjectDef` counts a failed call as a true recall hole whenever ANY
 * project class happens to define the member's short name. On taxdome that made
 * 4391 of 20964 holes phantom: `each` / `to_s` / `first` / `join` / `merge` /
 * `to_h` on an UNTYPED receiver, where the real callee is Ruby core but some
 * model defines the same name. This suite pins the classification that carves
 * those out into their own `coreAmbiguous` bucket — the mirror of the ykj7
 * external skip — WITHOUT hiding a single real miss:
 *
 *  - untyped receiver + core member + project homonym def → `coreAmbiguous`
 *  - TYPED receiver whose class defines the member        → still a real miss
 *  - resolved call                                        → never reclassified
 *  - non-core member                                      → still a real miss
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { SUPER_RECEIVER_SENTINEL } from "../../../../../../src/core/domains/language/ruby/walker/walker.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolvePath(__dirname, "../../../../../../src/core/domains/maintenance/migration/database/migrations");

interface RunMetricsShape {
  callsResolved: number;
  callsNoInProjectDef: number;
  callsCoreAmbiguous: number;
  inProjectEdgeRecall: number;
  resolveSuccessRate: number;
}

describe("CodegraphEnrichmentProvider — coreAmbiguous denominator (83cl7)", () => {
  let tmp: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-core-ambig-"));
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
   * `Report#each` + `Report#recalculate_totals` — the in-project homonym defs.
   * The class-level `Report` chunk matters: `resolveConstant` maps a receiver
   * type to a file through it, so without it every typed receiver would be
   * classified EXTERNAL one branch earlier and the core-member branch would
   * never be reached.
   */
  const writeReport = async (sink: ReturnType<CodegraphEnrichmentProvider["asExtractionSink"]>): Promise<void> => {
    await sink.write({
      relPath: "app/models/report.rb",
      language: "ruby",
      imports: [],
      chunks: [
        { symbolId: "Report", scope: [], calls: [], startLine: 1, endLine: 9 },
        { symbolId: "Report#each", scope: ["Report"], calls: [], startLine: 2, endLine: 4 },
        { symbolId: "Report#recalculate_totals", scope: ["Report"], calls: [], startLine: 6, endLine: 8 },
      ],
      fileScope: ["Report"],
    });
  };

  it("counts an untyped core-member miss as coreAmbiguous, not a recall hole", async () => {
    const sink = provider.asExtractionSink();
    await writeReport(sink);
    await sink.write({
      relPath: "app/services/exporter.rb",
      language: "ruby",
      imports: [],
      chunks: [
        {
          symbolId: "Exporter#run",
          scope: ["Exporter"],
          calls: [
            // A call that DOES resolve — it makes the recall assertion below
            // discriminating (1/(1+0) with the carve-out, 1/(1+1) without it).
            { callText: "recalculate_totals", receiver: null, member: "recalculate_totals", startLine: 3 },
            // Untyped chain receiver + Ruby-core `each`, with `Report#each` in the
            // symbol table → the phantom the metric used to record.
            { callText: "row.cells.each", receiver: "row.cells", member: "each", startLine: 4 },
          ],
          startLine: 2,
          endLine: 5,
        },
      ],
      fileScope: ["Exporter"],
    });
    await sink.finish();

    const m = provider.getRunMetrics() as unknown as RunMetricsShape;
    expect(m.callsResolved).toBe(1);
    expect(m.callsCoreAmbiguous).toBe(1);
    expect(m.callsNoInProjectDef).toBe(0);
    // The phantom left the recall denominator entirely — 1 resolved, 0 holes.
    expect(m.inProjectEdgeRecall).toBe(1);
  });

  it("keeps a TYPED receiver's core-member miss a real recall hole (reverse-precision pin)", async () => {
    const sink = provider.asExtractionSink();
    await writeReport(sink);
    await sink.write({
      relPath: "app/services/exporter.rb",
      language: "ruby",
      imports: [],
      chunks: [
        {
          symbolId: "Exporter#run",
          scope: ["Exporter"],
          calls: [
            // Resolves — keeps the recall denominator non-degenerate.
            { callText: "recalculate_totals", receiver: null, member: "recalculate_totals", startLine: 3 },
            // `super.each` — a self-identifying (TYPED) receiver on a class with
            // no resolvable ancestor: the super pass DROPs it, the external arm
            // declines it (the ancestor chain is empty, not provably external),
            // and `Report#each` keeps the short-name lookup non-empty. The
            // member is core, so ONLY the typedness guard stops the carve-out.
            { callText: "super.each", receiver: SUPER_RECEIVER_SENTINEL, member: "each", startLine: 4 },
          ],
          startLine: 2,
          endLine: 5,
        },
      ],
      fileScope: ["Exporter"],
    });
    await sink.finish();

    const m = provider.getRunMetrics() as unknown as RunMetricsShape;
    expect(m.callsResolved).toBe(1);
    expect(m.callsCoreAmbiguous).toBe(0);
    expect(m.callsNoInProjectDef).toBe(0);
    // 1 resolved / (1 resolved + 1 hole) — the typed-receiver hole survives.
    expect(m.inProjectEdgeRecall).toBe(0.5);
  });

  it("keeps a NON-core member miss with an in-project def as a recall hole", async () => {
    const sink = provider.asExtractionSink();
    await writeReport(sink);
    // `Interactor#call` — the service-object idiom `core-members.ts` deliberately
    // EXCLUDES. `call` is dropped by the duck-vocabulary narrower (so the call
    // genuinely misses) and has an in-project def (so `noInProjectDef` cannot
    // claim it): exactly the residual bucket 83cl7 must leave untouched.
    await sink.write({
      relPath: "app/interactors/interactor.rb",
      language: "ruby",
      imports: [],
      chunks: [{ symbolId: "Interactor#call", scope: ["Interactor"], calls: [], startLine: 2, endLine: 4 }],
      fileScope: ["Interactor"],
    });
    await sink.write({
      relPath: "app/services/exporter.rb",
      language: "ruby",
      imports: [],
      chunks: [
        {
          symbolId: "Exporter#run",
          scope: ["Exporter"],
          calls: [
            // Resolves — keeps the recall denominator non-degenerate.
            { callText: "recalculate_totals", receiver: null, member: "recalculate_totals", startLine: 3 },
            // SAME untyped chain-receiver shape as the coreAmbiguous case — the
            // only difference is that the member is a project idiom, not core.
            { callText: "row.handler.call", receiver: "row.handler", member: "call", startLine: 4 },
          ],
          startLine: 2,
          endLine: 5,
        },
      ],
      fileScope: ["Exporter"],
    });
    await sink.finish();

    const m = provider.getRunMetrics() as unknown as RunMetricsShape;
    expect(m.callsResolved).toBe(1);
    expect(m.callsCoreAmbiguous).toBe(0);
    expect(m.callsNoInProjectDef).toBe(0);
    // 1 resolved / (1 resolved + 1 hole) — the non-core hole is preserved.
    expect(m.inProjectEdgeRecall).toBe(0.5);
  });

  it("never reclassifies a RESOLVED core-member call", async () => {
    const sink = provider.asExtractionSink();
    await writeReport(sink);
    await sink.write({
      relPath: "app/services/exporter.rb",
      language: "ruby",
      imports: [],
      chunks: [
        {
          symbolId: "Exporter#run",
          scope: ["Exporter"],
          // Typed local receiver → the local-type strategy resolves `Report#each`.
          calls: [{ callText: "report.each", receiver: "report", member: "each", startLine: 3 }],
          startLine: 2,
          endLine: 5,
          localBindings: { report: [{ type: "Report", line: 2, valueKind: "instance" }] },
        },
      ],
      fileScope: ["Exporter"],
    });
    await sink.finish();

    const m = provider.getRunMetrics() as unknown as RunMetricsShape;
    // The local-type strategy pins `Report#each`, so the ONLY attempted call is
    // resolved — a resolved core-member call never reaches the classifier.
    expect(m.callsResolved).toBe(1);
    expect(m.callsCoreAmbiguous).toBe(0);
    expect(m.inProjectEdgeRecall).toBe(1);
  });

  it("persists the coreAmbiguous bucket per (language, receiver-kind) row", async () => {
    const spy = vi.spyOn(client, "recordRunStats");
    const root = mkdtempSync(join(tmpdir(), "cg-core-ambig-root-"));
    const sink = provider.asExtractionSink();
    await writeReport(sink);
    await sink.write({
      relPath: "app/services/exporter.rb",
      language: "ruby",
      imports: [],
      chunks: [
        {
          symbolId: "Exporter#run",
          scope: ["Exporter"],
          calls: [{ callText: "row.cells.each", receiver: "row.cells", member: "each", startLine: 3 }],
          startLine: 2,
          endLine: 5,
        },
      ],
      fileScope: ["Exporter"],
    });
    await sink.finish();
    await provider.finalizeSignals(root);
    rmSync(root, { recursive: true, force: true });

    expect(spy).toHaveBeenCalledTimes(1);
    const rows = spy.mock.calls[0][0];
    const chainRow = rows.find((r) => r.language === "ruby" && r.receiverKind === "chain");
    expect(chainRow?.coreAmbiguous).toBe(1);
  });
});
