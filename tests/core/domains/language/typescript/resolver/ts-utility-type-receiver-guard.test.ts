import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type NamedSymbol,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  TSGlobalShortNameSymbolResolutionStrategy,
  type ResolverConfig,
} from "../../../../../../src/core/domains/language/typescript/resolver/strategies/index.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const cfg: ResolverConfig = { tsOptions: { baseUrl: ".", paths: {} }, mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE };

const sym = (symbolId: string, shortName: string, relPath: string, scope: string[]): NamedSymbol => ({
  symbolId,
  fqName: symbolId,
  shortName,
  relPath,
  scope,
});

const tableWith = (...files: [string, NamedSymbol[]][]): InMemoryGlobalSymbolTable => {
  const t = new InMemoryGlobalSymbolTable();
  for (const [relPath, defs] of files) t.upsertFile(relPath, defs);
  return t;
};

const ctx = (over: Partial<CallContext> & Pick<CallContext, "symbolTable">): CallContext => ({
  callerFile: "src/caller.ts",
  callerScope: [],
  imports: [],
  ...over,
});

/** The project defines exactly one symbol per builtin-colliding short name. */
const collidingTable = (): InMemoryGlobalSymbolTable =>
  tableWith(
    ["src/decoder.ts", [sym("DaemonFrameDecoder#push", "push", "src/decoder.ts", ["DaemonFrameDecoder"])]],
    ["src/registry.ts", [sym("TrajectoryRegistry#has", "has", "src/registry.ts", ["TrajectoryRegistry"])]],
  );

/**
 * bd tea-rags-mcp-yjqi5 — a TS utility-type wrapper is not a type the guard may
 * decide on.
 *
 * `receiverIsExternalInstance` treats a KNOWN receiver type as decisive: builtin
 * means external, anything else means internal, and the member vocabulary never
 * gets a vote. That invariant assumes the recorded name says something about
 * the runtime object. `Awaited<ReturnType<EmbeddingProvider["embedBatch"]>>`
 * says nothing — the walker records the outermost wrapper (`Awaited`), which is
 * a type-level operator with no runtime object behind it, so the guard was
 * concluding "known, not a builtin" from a name carrying no nominal information
 * and letting `survivorEmbeddings.push(e)` match the project's single `push`.
 *
 * The fix is scoped by the same evidence the sibling guards use: a wrapper name
 * counts as unknown only when NO project symbol declares it, so a project that
 * genuinely owns a class called `Record` or `Parameters` keeps deciding
 * outright.
 */
describe("TSGlobalShortNameSymbolResolutionStrategy — TS utility-type receiver (bd tea-rags-mcp-yjqi5)", () => {
  const strat = new TSGlobalShortNameSymbolResolutionStrategy(cfg);

  it("continues for an `Awaited`-annotated receiver whose member is builtin vocabulary (survivorEmbeddings.push(e))", () => {
    const call: CallRef = {
      callText: "survivorEmbeddings.push(embedding)",
      receiver: "survivorEmbeddings",
      member: "push",
      startLine: 9,
    };
    const outcome = strat.attempt(
      call,
      ctx({ symbolTable: collidingTable(), localBindings: { survivorEmbeddings: [{ line: 2, type: "Awaited" }] } }),
    );
    expect(outcome.kind).toBe("continue");
  });

  it("continues for a `ReturnType`-annotated receiver whose member is builtin vocabulary (out.push(x))", () => {
    const call: CallRef = { callText: "out.push(x)", receiver: "out", member: "push", startLine: 9 };
    const outcome = strat.attempt(
      call,
      ctx({ symbolTable: collidingTable(), localBindings: { out: [{ line: 2, type: "ReturnType" }] } }),
    );
    expect(outcome.kind).toBe("continue");
  });

  it("continues for a `NonNullable`-annotated receiver whose member is builtin vocabulary (fanouts.push(f))", () => {
    const call: CallRef = { callText: "fanouts.push(f)", receiver: "fanouts", member: "push", startLine: 9 };
    const outcome = strat.attempt(
      call,
      ctx({ symbolTable: collidingTable(), localBindings: { fanouts: [{ line: 2, type: "NonNullable" }] } }),
    );
    expect(outcome.kind).toBe("continue");
  });

  it("STILL resolves an `Awaited`-annotated receiver whose member is ordinary project vocabulary (job.handle(req))", () => {
    const call: CallRef = { callText: "job.handle(req)", receiver: "job", member: "handle", startLine: 9 };
    const symbolTable = tableWith(["src/svc.ts", [sym("Service#handle", "handle", "src/svc.ts", ["Service"])]]);
    const outcome = strat.attempt(call, ctx({ symbolTable, localBindings: { job: [{ line: 2, type: "Awaited" }] } }));
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/svc.ts", targetSymbolId: "Service#handle" },
    });
  });

  it("STILL decides outright when the PROJECT declares the wrapper name as its own symbol (r: Record; r.has(k))", () => {
    const call: CallRef = { callText: "r.has(k)", receiver: "r", member: "has", startLine: 9 };
    const symbolTable = tableWith([
      "src/record.ts",
      [sym("Record#has", "has", "src/record.ts", ["Record"]), sym("Record", "Record", "src/record.ts", [])],
    ]);
    const outcome = strat.attempt(call, ctx({ symbolTable, localBindings: { r: [{ line: 2, type: "Record" }] } }));
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/record.ts", targetSymbolId: "Record#has" },
    });
  });
});

/**
 * bd tea-rags-mcp-yjqi5 — the same decision through the whole chain, on the
 * shape the oracle actually measured: `chunk-pipeline.ts:429`, where
 * `survivorEmbeddings` is annotated
 * `Awaited<ReturnType<EmbeddingProvider["embedBatch"]>>` and `.push()` was
 * fabricating an edge onto an unrelated project `push`.
 */
describe("TSCallResolver.resolve — no phantom edge for a utility-type receiver (bd tea-rags-mcp-yjqi5)", () => {
  const resolver = new TSCallResolver({ baseUrl: ".", paths: {} }, DEFAULT_AMBIGUOUS_RESOLVE_MODE);

  it("declines survivorEmbeddings.push(embedding) rather than emitting an edge to the project's own `push`", () => {
    const call: CallRef = {
      callText: "survivorEmbeddings.push(embedding)",
      receiver: "survivorEmbeddings",
      member: "push",
      startLine: 9,
    };
    const context = ctx({
      symbolTable: collidingTable(),
      localBindings: { survivorEmbeddings: [{ line: 2, type: "Awaited" }] },
    });
    expect(resolver.resolve(call, context)).toBeNull();
  });

  it("still emits the real edge for a project-typed receiver sharing the name (const s: Stack; s.push(x))", () => {
    const call: CallRef = { callText: "s.push(x)", receiver: "s", member: "push", startLine: 9 };
    const symbolTable = tableWith(["src/stack.ts", [sym("Stack#push", "push", "src/stack.ts", ["Stack"])]]);
    const context = ctx({ symbolTable, localBindings: { s: [{ line: 2, type: "Stack" }] } });
    expect(resolver.resolve(call, context)).toEqual({
      targetRelPath: "src/stack.ts",
      targetSymbolId: "Stack#push",
    });
  });
});

/**
 * bd tea-rags-mcp-yjqi5 — the classifier half. A call declined because it
 * targets `Array.prototype.push` must also leave the internal
 * `resolveSuccessRate` denominator, or the resolver is penalised for being
 * right.
 */
describe("TSCallResolver.targetsExternalImport — utility-type receiver (bd tea-rags-mcp-yjqi5)", () => {
  const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });

  it("flags an `Awaited`-typed receiver whose member is builtin-only vocabulary (survivorEmbeddings.push(e))", () => {
    const call: CallRef = {
      callText: "survivorEmbeddings.push(embedding)",
      receiver: "survivorEmbeddings",
      member: "push",
      startLine: 9,
    };
    const context = ctx({
      symbolTable: new InMemoryGlobalSymbolTable(),
      localBindings: { survivorEmbeddings: [{ line: 2, type: "Awaited" }] },
    });
    expect(resolver.targetsExternalImport(call, context)).toBe(true);
  });

  it("does NOT flag an `Awaited`-typed receiver whose member is ordinary project vocabulary (job.handle(req))", () => {
    const call: CallRef = { callText: "job.handle(req)", receiver: "job", member: "handle", startLine: 9 };
    const context = ctx({
      symbolTable: new InMemoryGlobalSymbolTable(),
      localBindings: { job: [{ line: 2, type: "Awaited" }] },
    });
    expect(resolver.targetsExternalImport(call, context)).toBe(false);
  });
});
