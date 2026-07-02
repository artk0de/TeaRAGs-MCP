import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type NamedSymbol,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  RubyEnqueueDispatchSymbolResolutionStrategy,
  type ResolverConfig,
} from "../../../../../../../src/core/domains/language/ruby/resolver/strategies/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const cfg: ResolverConfig = { mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE };
const strat = new RubyEnqueueDispatchSymbolResolutionStrategy(cfg);

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
  callerFile: "app/services/post_service.rb",
  callerScope: ["PostService"],
  imports: [],
  ...over,
});

const WORKER_FILE = "app/workers/distribution_worker.rb";
const workerTable = (): InMemoryGlobalSymbolTable =>
  tableWith([
    WORKER_FILE,
    [
      sym("DistributionWorker", "DistributionWorker", WORKER_FILE, []),
      sym("DistributionWorker#perform", "perform", WORKER_FILE, ["DistributionWorker"]),
    ],
  ]);

describe("RubyEnqueueDispatchSymbolResolutionStrategy", () => {
  it("Sidekiq `.perform_async` on a constant resolves to <Worker>#perform", () => {
    const call: CallRef = {
      callText: "DistributionWorker.perform_async(id)",
      receiver: "DistributionWorker",
      member: "perform_async",
      startLine: 5,
    };
    const outcome = strat.attempt(call, ctx({ symbolTable: workerTable() }));
    expect(outcome.kind).toBe("resolved");
    expect(outcome.kind === "resolved" && outcome.target).toEqual({
      targetRelPath: WORKER_FILE,
      targetSymbolId: "DistributionWorker#perform",
    });
  });

  it.each(["perform_in", "perform_at", "perform_bulk", "push_bulk", "perform_later", "perform_now"])(
    "enqueue member `%s` rewrites to #perform",
    (member) => {
      const call: CallRef = {
        callText: `DistributionWorker.${member}(id)`,
        receiver: "DistributionWorker",
        member,
        startLine: 5,
      };
      const outcome = strat.attempt(call, ctx({ symbolTable: workerTable() }));
      expect(outcome.kind === "resolved" && outcome.target.targetSymbolId).toBe("DistributionWorker#perform");
    },
  );

  it("inherited #perform resolves via the ancestor walk", () => {
    const PARENT = "app/workers/base_worker.rb";
    const CHILD = "app/workers/child_worker.rb";
    const table = tableWith(
      [CHILD, [sym("ChildWorker", "ChildWorker", CHILD, [])]],
      [
        PARENT,
        [sym("BaseWorker", "BaseWorker", PARENT, []), sym("BaseWorker#perform", "perform", PARENT, ["BaseWorker"])],
      ],
    );
    const call: CallRef = {
      callText: "ChildWorker.perform_async(id)",
      receiver: "ChildWorker",
      member: "perform_async",
      startLine: 5,
    };
    const outcome = strat.attempt(call, ctx({ symbolTable: table, classAncestors: { ChildWorker: ["BaseWorker"] } }));
    expect(outcome.kind === "resolved" && outcome.target.targetSymbolId).toBe("BaseWorker#perform");
  });

  it("CONTINUES on a non-enqueue member (normal class-method call)", () => {
    const call: CallRef = {
      callText: "DistributionWorker.configure",
      receiver: "DistributionWorker",
      member: "configure",
      startLine: 5,
    };
    expect(strat.attempt(call, ctx({ symbolTable: workerTable() })).kind).toBe("continue");
  });

  it("CONTINUES on a receiverless bare `perform_async` (no worker class)", () => {
    const call: CallRef = { callText: "perform_async", receiver: null, member: "perform_async", startLine: 5 };
    expect(strat.attempt(call, ctx({ symbolTable: workerTable() })).kind).toBe("continue");
  });

  it("CONTINUES when the constant receiver does not resolve to an in-project class", () => {
    const call: CallRef = {
      callText: "ExternalGem::Worker.perform_async(id)",
      receiver: "ExternalGem::Worker",
      member: "perform_async",
      startLine: 5,
    };
    expect(strat.attempt(call, ctx({ symbolTable: workerTable() })).kind).toBe("continue");
  });
});
