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
  isWorkingTreeGraphEntryShutdown,
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

  const seed = {
    dbPath: "/tmp/trees/k1/codegraph/code_abc_v2.duckdb",
    changedRelPaths: ["src/a.ts"],
    deletedRelPaths: [],
    heldRelPaths: ["src/b.ts"],
    restoredRelPaths: [],
    seedChangedRelPaths: ["src/a.ts", "src/b.ts"],
    seedDeletedRelPaths: [],
  };
  const withSeed = (value: unknown): Record<string, unknown> => {
    const req = validRequest();
    return { ...req, input: { ...(req.input as object), seed: value } };
  };

  it("accepts a request seeded from the tree's previous graph", () => {
    expect(isWorkingTreeGraphEntryRequest(withSeed(seed))).toBe(true);
  });

  it("accepts a request carrying its build id, and refuses an id that is not a number", () => {
    expect(isWorkingTreeGraphEntryRequest({ ...validRequest(), id: 7 })).toBe(true);
    expect(isWorkingTreeGraphEntryRequest({ ...validRequest(), id: "7" })).toBe(false);
  });

  it.each<[string, unknown]>([
    ["a non-object seed", "seed"],
    ["a seed without its db path", { ...seed, dbPath: undefined }],
    ["a seed whose held paths are not strings", { ...seed, heldRelPaths: [1] }],
    ["a seed without its own delta", { ...seed, seedDeletedRelPaths: undefined }],
  ])("refuses %s", (_label, value) => {
    expect(isWorkingTreeGraphEntryRequest(withSeed(value))).toBe(false);
  });
});

describe("isWorkingTreeGraphEntryReply", () => {
  it("accepts a built reply carrying the graph's db path and a failed reply carrying its reason", () => {
    expect(isWorkingTreeGraphEntryReply({ kind: "built", outcome: { dbPath: "/tmp/tree.duckdb" } })).toBe(true);
    expect(isWorkingTreeGraphEntryReply({ kind: "failed", reason: "parse error" })).toBe(true);
  });

  it("accepts a reply carrying its build id and the child's heap, and refuses either when not a number", () => {
    expect(isWorkingTreeGraphEntryReply({ kind: "failed", reason: "x", id: 3, heapUsedBytes: 1024 })).toBe(true);
    expect(isWorkingTreeGraphEntryReply({ kind: "failed", reason: "x", id: "3" })).toBe(false);
    expect(isWorkingTreeGraphEntryReply({ kind: "failed", reason: "x", heapUsedBytes: "1 KB" })).toBe(false);
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

describe("isWorkingTreeGraphEntryShutdown", () => {
  it("accepts the spawner's shutdown and refuses a build request or a reply", () => {
    expect(isWorkingTreeGraphEntryShutdown({ kind: "shutdown" })).toBe(true);
    expect(isWorkingTreeGraphEntryShutdown(validRequest())).toBe(false);
    expect(isWorkingTreeGraphEntryShutdown({ kind: "failed", reason: "x" })).toBe(false);
    expect(isWorkingTreeGraphEntryShutdown(null)).toBe(false);
  });
});
