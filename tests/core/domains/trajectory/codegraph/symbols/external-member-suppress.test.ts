/**
 * Provider-level integration test: Increment D external-member suppression
 * (bd tea-rags-mcp-i9id8).
 *
 * Proves the full chain end-to-end through the real codegraph provider:
 *
 *   1. `agent.update`  — member in ACTIVE_RECORD_INSTANCE_BUILTINS
 *      → dynamic-dispatch guard returns [] (no fan-out)
 *      → external classifier arm: isQualifiedMemberExternal("update") → true
 *      → counted externalSkipped (not noInProjectDef, not resolved)
 *      → NO dynamic edge emitted
 *
 *   2. `agent.handle_details_post` — NOT in ACTIVE_RECORD_INSTANCE_BUILTINS
 *      → dynamic-dispatch fan-out proceeds normally
 *      → resolves to in-project Agent#handle_details_post
 *      → dynamic edge emitted (fan-out unchanged)
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

describe("CodegraphEnrichmentProvider — external-member suppression e2e (increment D / i9id8)", () => {
  let tmp: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-ext-member-"));
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

  // The fixture mirrors the inproject-edge-recall / mktkk increment A pattern:
  // real Ruby source files → streamFileBatch → finalizeSignals → assert via
  // getRunStats rows + getCallees edges.
  it("agent.update is externalSkipped with no dynamic edge; agent.handle_details_post fans out normally", async () => {
    const root = mkdtempSync(join(tmpdir(), "cg-ext-member-fixture-"));
    try {
      // target.rb defines BOTH `update` and `handle_details_post` as instance
      // methods on Agent. Without these in-project defs:
      //   - `agent.update` would fall into noInProjectDef (not externalSkipped)
      //     — the test would not prove the member-axis suppression.
      //   - `agent.handle_details_post` would produce no fan-out edge.
      // With both present, externalSkipped on `update` is the proof that the
      // guard fired (member in V_core → suppressed before fan-out lookup),
      // not simply that no target existed.
      writeFileSync(
        join(root, "target.rb"),
        [
          "class Agent",
          "  def update",
          "    # in-project def — present so noInProjectDef stays 0",
          "    true",
          "  end",
          "",
          "  def handle_details_post",
          "    # control: NOT in ACTIVE_RECORD_INSTANCE_BUILTINS → fan-out allowed",
          "    true",
          "  end",
          "end",
          "",
        ].join("\n"),
      );

      // caller.rb calls both methods on an untyped lowercase receiver `agent`:
      //   agent.update              → member guard fires → externalSkipped
      //   agent.handle_details_post → no guard → short-name fan-out → dynamic edge
      writeFileSync(
        join(root, "caller.rb"),
        [
          "class AgentCaller",
          "  def process(agent)",
          "    agent.update",
          "    agent.handle_details_post",
          "  end",
          "end",
          "",
        ].join("\n"),
      );

      await provider.streamFileBatch(root, ["target.rb", "caller.rb"]);
      await provider.finalizeSignals(root);

      const rows = await client.getRunStats();
      const rubyRows = rows.filter((r) => r.language === "ruby");

      // ── Assertion 1: `agent.update` → externalSkipped (dynamic bucket) ──
      //
      // The call lands in the `dynamic` receiverKind bucket because `agent` is
      // a lowercase untyped receiver (not constant, not self, not local-typed).
      // The guard `isExternalQualifiedMember("update")` fires, the call is
      // counted as externalSkipped — NOT as noInProjectDef (there IS an
      // in-project Agent#update def) and NOT as resolved (no edge emitted).
      const dynamicRow = rubyRows.find((r) => r.receiverKind === "dynamic");
      expect(dynamicRow, "expected a 'dynamic' receiverKind row for ruby").toBeDefined();
      expect(dynamicRow!.externalSkipped, "agent.update must be counted externalSkipped").toBeGreaterThanOrEqual(1);
      expect(
        dynamicRow!.noInProjectDef ?? 0,
        "agent.update must NOT be noInProjectDef — an in-project Agent#update def exists",
      ).toBe(0);

      // ── Assertion 2: no dynamic edge emitted for `update` ──
      //
      // AgentCaller#process is the source symbol. If the fan-out guard fires,
      // the callees must NOT include Agent#update.
      const calleesOfProcess = await client.getCallees("AgentCaller#process");
      const updateEdge = calleesOfProcess.find((e) => e.callExpression.includes("update"));
      expect(
        updateEdge,
        "no dynamic edge must be emitted for agent.update (suppressed by external-member guard)",
      ).toBeUndefined();

      // ── Assertion 3: control — `agent.handle_details_post` fans out normally ──
      //
      // handle_details_post is NOT in ACTIVE_RECORD_INSTANCE_BUILTINS, so the
      // guard does not fire. The short-name lookup finds Agent#handle_details_post
      // (single in-project def) and emits a dynamic edge.
      const controlEdge = calleesOfProcess.find((e) => e.callExpression.includes("handle_details_post"));
      expect(
        controlEdge,
        "a dynamic edge must be emitted for agent.handle_details_post (fan-out unchanged)",
      ).toBeDefined();
      expect(controlEdge!.targetSymbolId).toBe("Agent#handle_details_post");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
