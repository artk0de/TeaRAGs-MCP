import { describe, expect, it } from "vitest";

import type { CallContext, CallRef } from "../../../../../../src/core/contracts/types/codegraph.js";
import { JavascriptCallResolver } from "../../../../../../src/core/domains/language/javascript/resolver/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/**
 * One project method per colliding member, each declared in a TypeScript file —
 * the symbol table is polyglot, so a JavaScript call site sees them all.
 * `CommitDiffMemo#set` and `JsonProgressRenderer#error` are the two measured
 * victims on this repo: `perFile[f].set(...)` in `scripts/spikes/esgit-thread-safety.js`
 * (a plain `Map`) and `console.error(...)` in `scripts/postinstall.js`.
 */
const collidingTable = (): InMemoryGlobalSymbolTable => {
  const table = new InMemoryGlobalSymbolTable();
  table.upsertFile("src/core/infra/commit-diff-memo.ts", [
    {
      symbolId: "CommitDiffMemo#set",
      fqName: "CommitDiffMemo#set",
      shortName: "set",
      relPath: "src/core/infra/commit-diff-memo.ts",
      scope: ["CommitDiffMemo"],
    },
  ]);
  table.upsertFile("src/cli/index-progress/renderer.ts", [
    {
      symbolId: "JsonProgressRenderer#error",
      fqName: "JsonProgressRenderer#error",
      shortName: "error",
      relPath: "src/cli/index-progress/renderer.ts",
      scope: ["JsonProgressRenderer"],
    },
  ]);
  return table;
};

const ctx = (callerFile: string): CallContext => ({
  callerFile,
  callerScope: [],
  imports: [],
  symbolTable: collidingTable(),
});

/**
 * bd tea-rags-mcp-hwwtw — a JavaScript receiver carries no type, so a member
 * call on it has nothing to be resolved BY except the member's short name, and a
 * short name that happens to be unique in the project is a naming coincidence,
 * not evidence. Measured on this repo before the change: all 34 receiver-bearing
 * JavaScript edges the global fallback produced were fabricated, none real.
 */
describe("JavascriptCallResolver — untyped receivers do not resolve by global short-name uniqueness (bd tea-rags-mcp-hwwtw)", () => {
  it("emits no edge for an indexed Map receiver whose member is uniquely named in the project (perFile[f].set)", () => {
    const call: CallRef = {
      callText: "perFile[f].set(key, (perFile[f].get(key) ?? 0) + n)",
      receiver: "perFile[f]",
      member: "set",
      startLine: 201,
    };
    expect(new JavascriptCallResolver().resolve(call, ctx("scripts/spikes/esgit-thread-safety.js"))).toBeNull();
  });

  it("emits no edge for an ambient-global receiver sharing a unique project method name (console.error)", () => {
    const call: CallRef = {
      callText: "console.error(`[tea-rags] Qdrant binary ready`)",
      receiver: "console",
      member: "error",
      startLine: 13,
    };
    expect(new JavascriptCallResolver().resolve(call, ctx("scripts/postinstall.js"))).toBeNull();
  });
});
