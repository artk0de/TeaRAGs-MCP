/**
 * The tree-graph IPC contract (bd tea-rags-mcp-xi2r9): the forked
 * `tree-graph-entry` validates the request it receives structurally, and the
 * spawner validates the reply — Node IPC hands both sides untyped JSON, so a
 * malformed message must be refused instead of trusted.
 */
import { describe, expect, it } from "vitest";

import {
  isWorkingTreeGraphEntryReply,
  isWorkingTreeGraphEntryRequest,
} from "../../../../../../src/core/domains/trajectory/codegraph/working-tree/tree-graph-protocol.js";

function validRequest(): Record<string, unknown> {
  return {
    debug: false,
    input: {
      snapshotPath: "/tmp/snap.duckdb",
      outputRoot: "/tmp/out",
      physicalCollectionName: "code_abc_v2",
      treeRoot: "/repo",
      changedRelPaths: ["src/a.ts"],
      deletedRelPaths: [],
      providerConfig: { languageModulePath: "/lang.js", migrationsModulePath: "/migrations.js" },
    },
  };
}

describe("isWorkingTreeGraphEntryRequest", () => {
  it("accepts the request the spawner sends", () => {
    expect(isWorkingTreeGraphEntryRequest(validRequest())).toBe(true);
  });

  it.each<[string, (req: Record<string, unknown>) => unknown]>([
    ["a non-object", () => "request"],
    ["null", () => null],
    ["an array", () => [validRequest()]],
    ["a missing debug flag", ({ input }) => ({ input })],
    ["a non-object input", () => ({ debug: true, input: [] })],
    [
      "an empty physical collection name",
      (req) => ({ ...req, input: { ...(req.input as object), physicalCollectionName: "" } }),
    ],
    ["a missing tree root", (req) => ({ ...req, input: { ...(req.input as object), treeRoot: undefined } })],
    [
      "a changed path that is not a string",
      (req) => ({ ...req, input: { ...(req.input as object), changedRelPaths: ["src/a.ts", 7] } }),
    ],
    [
      "deleted paths that are not an array",
      (req) => ({ ...req, input: { ...(req.input as object), deletedRelPaths: "src/b.ts" } }),
    ],
    ["a missing provider config", (req) => ({ ...req, input: { ...(req.input as object), providerConfig: null } })],
    [
      "a provider config without the migrations module",
      (req) => ({
        ...req,
        input: { ...(req.input as object), providerConfig: { languageModulePath: "/lang.js" } },
      }),
    ],
  ])("refuses %s", (_label, mutate) => {
    expect(isWorkingTreeGraphEntryRequest(mutate(validRequest()))).toBe(false);
  });
});

describe("isWorkingTreeGraphEntryReply", () => {
  it("accepts a built reply carrying the graph's db path and a failed reply carrying its reason", () => {
    expect(isWorkingTreeGraphEntryReply({ kind: "built", outcome: { dbPath: "/tmp/tree.duckdb" } })).toBe(true);
    expect(isWorkingTreeGraphEntryReply({ kind: "failed", reason: "parse error" })).toBe(true);
  });

  it.each<[string, unknown]>([
    ["a non-object", "built"],
    ["a failed reply without a reason", { kind: "failed" }],
    ["a built reply without an outcome", { kind: "built" }],
    ["a built reply whose db path is not a string", { kind: "built", outcome: { dbPath: 1 } }],
    ["an unknown kind", { kind: "timedOut", outcome: { dbPath: "/tmp/tree.duckdb" } }],
  ])("refuses %s", (_label, reply) => {
    expect(isWorkingTreeGraphEntryReply(reply)).toBe(false);
  });
});
