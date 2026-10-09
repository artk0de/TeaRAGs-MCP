import { describe, expect, expectTypeOf, it } from "vitest";

import {
  DAEMON_OP_COMMANDS,
  type DaemonOpCommandsByOp,
} from "../../../../../src/core/adapters/duckdb/daemon/op-commands.js";
import {
  DAEMON_LIFECYCLE_OPS,
  DAEMON_OPS,
  DAEMON_UNPROXIED_GRAPH_DB_CLIENT_MEMBERS,
  type DaemonOp,
  type DaemonOpParamsMap,
  type DaemonOpsWithoutGraphDbClientMember,
  type GraphDbClientMembersWithoutDaemonOp,
} from "../../../../../src/core/adapters/duckdb/daemon/protocol.js";
import type { GraphDbClient } from "../../../../../src/core/contracts/types/codegraph-storage.js";

/**
 * bd tea-rags-mcp-89k7k.35.6 — the daemon op surface is typed from
 * `GraphDbClient`, so adding a storage method without its daemon op, wire
 * params or command is a compile error instead of a hand-sync miss. The
 * `@ts-expect-error` lines are the proof: `tsc -p tsconfig.tests.json` fails
 * if any of them stops being an error.
 */
describe("daemon op surface typing (89k7k.35.6)", () => {
  it("every GraphDbClient member rides a daemon op or is a named exclusion", () => {
    expectTypeOf<GraphDbClientMembersWithoutDaemonOp<GraphDbClient>>().toEqualTypeOf<never>();
    expectTypeOf<DaemonOpsWithoutGraphDbClientMember<GraphDbClient>>().toEqualTypeOf<never>();
  });

  it("a new GraphDbClient member without an op is reported by name", () => {
    type ClientWithNewRead = GraphDbClient & { readFieldAccessEdges: (relPath: string) => Promise<string[]> };
    expectTypeOf<GraphDbClientMembersWithoutDaemonOp<ClientWithNewRead>>().toEqualTypeOf<"readFieldAccessEdges">();
  });

  it("every op has a wire params shape", () => {
    expectTypeOf<keyof DaemonOpParamsMap>().toEqualTypeOf<DaemonOp>();
    expectTypeOf<DaemonOpParamsMap["removeFiles"]>().toHaveProperty("relPaths");
  });

  it("a command table without one op does not compile", () => {
    const { getCallers: _dropped, ...withoutGetCallers } = DAEMON_OP_COMMANDS;
    // @ts-expect-error — `getCallers` is missing: the command table is exhaustive over DaemonOp.
    const table: DaemonOpCommandsByOp = withoutGetCallers;
    expect(Object.keys(table)).not.toContain("getCallers");
  });

  it("the exclusions and lifecycle ops are real names, and the runtime op list matches the command table", () => {
    const ops: readonly string[] = DAEMON_OPS;
    for (const op of DAEMON_LIFECYCLE_OPS) expect(ops).toContain(op);
    for (const member of Object.keys(DAEMON_UNPROXIED_GRAPH_DB_CLIENT_MEMBERS)) expect(ops).not.toContain(member);
    expect(Object.keys(DAEMON_OP_COMMANDS).sort()).toEqual([...DAEMON_OPS].sort());
  });
});
