/**
 * bd tea-rags-mcp-1v12o.3 — the RUNNER half: a Python miss whose definition is
 * outside the project lands in `externalSkipped`, which is what takes it out of
 * the `resolveSuccessRate` denominator.
 *
 * `classifyResolveMiss` is the decision `CallEdgeResolutionRunner#classifyMiss`
 * tallies, exported so this suite (and the offline tally) score misses through
 * production's own ordering rather than a copy of it.
 */
import { describe, expect, it } from "vitest";

import type { CallContext, CallRef } from "../../../../../../src/core/contracts/types/codegraph.js";
import { PythonCallResolver } from "../../../../../../src/core/domains/language/python/resolver/python-resolver.js";
import { classifyResolveMiss } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/resolution-runner.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/**
 * `Ticket` extends an external Django base and declares `describe`; `Plain`
 * extends nothing. `TicketView#save` is the in-project HOMONYM that keeps
 * `noInProjectDef` from firing first — without it every case below would be
 * excluded for a reason that has nothing to do with this change.
 */
function symbolTable(): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  const files: Record<string, readonly string[]> = {
    "app/models.py": ["Ticket", "Ticket#describe"],
    "app/plain.py": ["Plain"],
    "app/views.py": ["TicketView", "TicketView#save"],
  };
  for (const [relPath, ids] of Object.entries(files)) {
    table.upsertFile(
      relPath,
      ids.map((symbolId) => ({
        symbolId,
        fqName: symbolId,
        shortName: symbolId.split(/[#.]/).pop() ?? symbolId,
        relPath,
        scope: symbolId.includes("#") ? [symbolId.split("#")[0]] : [],
      })),
    );
  }
  return table;
}

function ctxWith(extra: Partial<CallContext> = {}): CallContext {
  return {
    callerFile: "app/views.py",
    callerScope: [],
    imports: [],
    symbolTable: symbolTable(),
    classAncestors: { "app/models.py::Ticket": ["django.db.models::Model"], "app/plain.py::Plain": [] },
    ...extra,
  };
}

const resolver = new PythonCallResolver();
const table = symbolTable();

describe("classifyResolveMiss — python external-typed receivers (1v12o.3)", () => {
  it("books a receiver typed to a class outside the project as externalSkipped", () => {
    const ctx = ctxWith({ localBindings: { payload: [{ line: 10, type: "dict" }] } });
    const call: CallRef = { callText: "payload.save()", receiver: "payload", member: "save", startLine: 20 };
    expect(classifyResolveMiss(call, ctx, resolver, table)).toBe("externalSkipped");
  });

  it("books `super()` whose ancestor closure is external as externalSkipped", () => {
    const ctx = ctxWith({ callerFile: "app/models.py", callerScope: ["Ticket"] });
    const call: CallRef = { callText: "super().save()", receiver: "super", member: "save", startLine: 20 };
    expect(classifyResolveMiss(call, ctx, resolver, table)).toBe("externalSkipped");
  });

  it("leaves an untyped receiver in the denominator as missWithInProjectDef", () => {
    const call: CallRef = { callText: "thing.save()", receiver: "thing", member: "save", startLine: 20 };
    expect(classifyResolveMiss(call, ctxWith(), resolver, table)).toBe("missWithInProjectDef");
  });

  it("leaves a closed-hierarchy miss in the denominator", () => {
    const ctx = ctxWith({ localBindings: { plain: [{ line: 10, type: "Plain" }] } });
    const call: CallRef = { callText: "plain.save()", receiver: "plain", member: "save", startLine: 20 };
    expect(classifyResolveMiss(call, ctx, resolver, table)).toBe("missWithInProjectDef");
  });

  it("still books a dynamic send as unresolvable, ahead of every external arm", () => {
    const ctx = ctxWith({ localBindings: { payload: [{ line: 10, type: "dict" }] } });
    const call: CallRef = {
      callText: "payload.send(name)",
      receiver: "payload",
      member: "send",
      startLine: 20,
      dynamicSend: true,
    };
    expect(classifyResolveMiss(call, ctx, resolver, table)).toBe("unresolvable");
  });

  it("still books a member with no in-project definition as noInProjectDef", () => {
    const call: CallRef = { callText: "thing.vanish()", receiver: "thing", member: "vanish", startLine: 20 };
    expect(classifyResolveMiss(call, ctxWith(), resolver, table)).toBe("noInProjectDef");
  });
});
