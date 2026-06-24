/**
 * inProjectEdgeRecall — honest graph-completeness metric.
 *
 * `resolveSuccessRate` counts every unresolved call against the resolver, even
 * calls whose member has NO in-project definition (gem/core/AR-runtime) — those
 * can never produce an in-project edge, so they understate graph quality. This
 * suite pins the recall metric that excludes them:
 *
 *   inProjectEdgeRecall = callsResolved / (callsResolved + missWithInProjectDef)
 *
 * where `missWithInProjectDef` = genuine-miss calls whose member short-name DOES
 * resolve to ≥1 in-project definition (symbolTable.lookupByShortName non-empty),
 * i.e. the only true recall holes. Calls with no in-project def are counted as
 * `callsNoInProjectDef` and excluded from the recall denominator.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { runMigrations } from "../../../../../../src/core/infra/migration/database/runner.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolvePath(__dirname, "../../../../../../src/core/infra/migration/database/migrations");

describe("CodegraphEnrichmentProvider — inProjectEdgeRecall", () => {
  let tmp: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-recall-"));
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

  it("excludes misses with no in-project def from the recall denominator", async () => {
    const sink = provider.asExtractionSink();
    // Two files each declare a top-level `helper` → a bare `helper()` call is
    // AMBIGUOUS (resolver returns null) yet lookupByShortName("helper") === 2,
    // so it is a genuine miss WITH an in-project def (a true recall hole).
    await sink.write({
      relPath: "src/a.ts",
      language: "typescript",
      imports: [],
      chunks: [{ symbolId: "helper", scope: [], calls: [], startLine: 1, endLine: 3 }],
      fileScope: ["helper"],
    });
    await sink.write({
      relPath: "src/b.ts",
      language: "typescript",
      imports: [],
      chunks: [{ symbolId: "helper", scope: [], calls: [], startLine: 1, endLine: 3 }],
      fileScope: ["helper"],
    });
    await sink.write({
      relPath: "src/foo.ts",
      language: "typescript",
      imports: [],
      chunks: [{ symbolId: "Foo.bar", scope: ["Foo"], calls: [], startLine: 1, endLine: 3 }],
      fileScope: [],
    });
    await sink.write({
      relPath: "src/main.ts",
      language: "typescript",
      imports: [{ importText: "./foo", startLine: 1 }],
      chunks: [
        {
          symbolId: "main",
          scope: [],
          calls: [
            // resolves → contributes to callsResolved
            { callText: "Foo.bar()", receiver: "Foo", member: "bar", startLine: 4 },
            // ambiguous bare call → miss WITH in-project def (recall hole)
            { callText: "helper()", receiver: null, member: "helper", startLine: 5 },
            // no def anywhere → miss with NO in-project def (excluded from recall)
            { callText: "Mystery.nope()", receiver: "Mystery", member: "nope", startLine: 6 },
          ],
        },
      ],
      fileScope: [],
    });
    await sink.finish();

    const m = provider.getRunMetrics() as {
      callsResolved: number;
      callsNoInProjectDef: number;
      inProjectEdgeRecall: number;
    };
    expect(m).toBeDefined();
    expect(m.callsResolved).toBe(1);
    // Mystery.nope() is the only no-in-project-def miss.
    expect(m.callsNoInProjectDef).toBe(1);
    // recall = 1 resolved / (1 resolved + 1 recall-hole) = 0.5 — the
    // no-in-project-def miss is excluded from the denominator.
    expect(m.inProjectEdgeRecall).toBeCloseTo(0.5, 5);
  });

  it("persists noInProjectDef to cg_run_stats and it round-trips through getRunStats", async () => {
    const root = mkdtempSync(join(tmpdir(), "cg-recall-fixture-"));
    try {
      // Two `helper` defs → bare `helper()` is ambiguous (miss WITH in-project
      // def). `Mystery.nope()` has no def anywhere (miss with NO in-project def).
      writeFileSync(join(root, "a.ts"), "export function helper() { return 1; }\n");
      writeFileSync(join(root, "b.ts"), "export function helper() { return 2; }\n");
      writeFileSync(join(root, "main.ts"), "export function main() {\n  helper();\n  Mystery.nope();\n}\n");
      const paths = ["a.ts", "b.ts", "main.ts"]; // relative to root (streamFileBatch contract)

      await provider.streamFileBatch(root, paths);
      await provider.finalizeSignals(root);

      const rows = await client.getRunStats();
      const total = rows.reduce((s, r) => s + (r.noInProjectDef ?? 0), 0);
      // Exactly one no-in-project-def miss: Mystery.nope().
      expect(total).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // mktkk increment A — an index-access receiver call (`cfg[:k].run`) whose
  // member `run` HAS an in-project def (Worker#run) is classified as
  // externalSkipped (not resolved, not a recall hole). Contrast: a bare dynamic
  // receiver `obj.run` fans out normally and is counted as attempted/resolved or
  // attempted/dynamic in the `dynamic` bucket.
  it("an index-access receiver call is externalSkipped, not resolved nor a recall hole (mktkk)", async () => {
    const root = mkdtempSync(join(tmpdir(), "cg-mktkk-idx-"));
    try {
      // worker.rb defines Worker#run — `run` DOES have an in-project def.
      // Without this, cfg[:k].run would fall into noInProjectDef instead of
      // externalSkipped, and the test would prove nothing about the suppression.
      writeFileSync(join(root, "worker.rb"), ["class Worker", "  def run", "    :ok", "  end", "end", ""].join("\n"));
      // caller.rb has two calls:
      //   1. cfg[:k].run  — index-access receiver → receiverKind "index"
      //                     → targetsExternalImport returns true (mktkk Task 3)
      //                     → counted externalSkipped
      //   2. obj.run      — bare lowercase receiver → receiverKind "dynamic"
      //                     → fans out (dynamic dispatch, mktkk Increment B still fans)
      //                     → counted attempted (resolved or dynamic miss)
      writeFileSync(
        join(root, "caller.rb"),
        ["class Caller", "  def invoke(cfg, obj)", "    cfg[:k].run", "    obj.run", "  end", "end", ""].join("\n"),
      );

      await provider.streamFileBatch(root, ["worker.rb", "caller.rb"]);
      await provider.finalizeSignals(root);

      const rows = await client.getRunStats();
      const rubyRows = rows.filter((r) => r.language === "ruby");

      // 1. The index-access receiver call is counted externalSkipped (not resolved,
      //    not noInProjectDef). This is the central assertion of mktkk increment A.
      const indexRow = rubyRows.find((r) => r.receiverKind === "index");
      expect(indexRow, "expected an 'index' receiverKind row for ruby").toBeDefined();
      expect(indexRow!.externalSkipped).toBeGreaterThanOrEqual(1);
      expect(indexRow!.resolved).toBe(0);
      expect(indexRow!.noInProjectDef ?? 0).toBe(0);

      // 2. Control: obj.run (dynamic receiver) is attempted in the `dynamic` bucket.
      //    Worker#run is an in-project def with a single implementation → the
      //    dynamic fan-out resolver may resolve it (resolved >= 1) OR leave it as a
      //    dynamic miss. Either way the call is NOT externalSkipped.
      const dynamicRow = rubyRows.find((r) => r.receiverKind === "dynamic");
      expect(dynamicRow, "expected a 'dynamic' receiverKind row for ruby").toBeDefined();
      expect(dynamicRow!.attempted).toBeGreaterThanOrEqual(1);
      expect(dynamicRow!.externalSkipped).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
