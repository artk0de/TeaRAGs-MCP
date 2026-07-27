/**
 * `super` through a hierarchy the include SITE spells with a bare constant
 * (bd tea-rags-mcp-lawlq.5).
 *
 * The super-miss oracle (`CODEGRAPH_SUPER_ORACLE=1` on the recall harness)
 * showed the whole addressable part of the `super` recall hole is one shape:
 * the enclosing module has no `classAncestors` entry, so the MRO walk has
 * nothing to iterate, AND the includer-consensus fallback cannot find it either
 * because `includedBy` is keyed by the RAW ancestor text the include site wrote
 * (`prepend PerformWrapper`) while the module's own key is its FQ
 * (`Tech::BatchOperationWorker::PerformWrapper`).
 *
 * Three Ruby facts are pinned here:
 *
 *   1. A bare constant inside `class C` resolves through `Module.nesting`, whose
 *      HEAD is `C` itself — `C::Wrapper` wins over any outer or top-level
 *      `Wrapper`. This holds for COMPACT declarations too (`class A::B::C` opens
 *      `A::B::C`, just not `A` / `A::B`).
 *   2. A bare constant also resolves through the cref's ANCESTORS, so
 *      `class Sub < Base; include Helpers` finds `Base::Helpers`.
 *   3. `super` never dispatches to the method that is executing. A wrapper
 *      module shares a FILE with the class it is nested in, and the MRO walk
 *      pins members by short name WITHIN a file — without excluding the caller's
 *      own definition the walk binds `super` to itself.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type NamedSymbol,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  RubySuperSymbolResolutionStrategy,
  type ResolverConfig,
} from "../../../../../../../src/core/domains/language/ruby/resolver/strategies/index.js";
import { SUPER_RECEIVER_SENTINEL } from "../../../../../../../src/core/domains/language/ruby/walker/walker.js";
import { buildIncludedBy } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const cfg: ResolverConfig = { mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE };
const strat = new RubySuperSymbolResolutionStrategy(cfg);

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

const superCall = (member: string): CallRef => ({
  callText: "super",
  receiver: SUPER_RECEIVER_SENTINEL,
  member,
  startLine: 10,
});

describe("RubySuperSymbolResolutionStrategy — bare-constant mixin hierarchies (bd lawlq.5)", () => {
  // ── Fixture 1: nested wrapper module prepended into its own host ──────────
  //
  //   app/workers/tech/batch_operation_worker.rb
  //     class Tech::BatchOperationWorker < ApplicationWorker   # COMPACT
  //       module PerformWrapper
  //         def perform; super; end
  //       end
  //       prepend PerformWrapper
  //     end
  //   lib/application_worker.rb
  //     class ApplicationWorker
  //       def perform; end
  //     end
  const WORKER = "app/workers/tech/batch_operation_worker.rb";
  const APP_WORKER = "lib/application_worker.rb";

  const nestedWrapperCtx = (): CallContext => {
    const classAncestors: Record<string, string[]> = { "Tech::BatchOperationWorker": ["ApplicationWorker"] };
    const classPrependedAncestors: Record<string, string[]> = { "Tech::BatchOperationWorker": ["PerformWrapper"] };
    return {
      callerFile: WORKER,
      callerScope: ["Tech::BatchOperationWorker", "PerformWrapper"],
      callerSymbolId: "Tech::BatchOperationWorker::PerformWrapper#perform",
      imports: [],
      symbolTable: tableWith(
        [
          WORKER,
          [
            sym("Tech::BatchOperationWorker", "BatchOperationWorker", WORKER, ["Tech"]),
            sym("Tech::BatchOperationWorker::PerformWrapper", "PerformWrapper", WORKER, [
              "Tech",
              "BatchOperationWorker",
            ]),
            sym("Tech::BatchOperationWorker::PerformWrapper#perform", "perform", WORKER, [
              "Tech",
              "BatchOperationWorker",
              "PerformWrapper",
            ]),
          ],
        ],
        [
          APP_WORKER,
          [
            sym("ApplicationWorker", "ApplicationWorker", APP_WORKER, []),
            sym("ApplicationWorker#perform", "perform", APP_WORKER, ["ApplicationWorker"]),
          ],
        ],
      ),
      classAncestors,
      classPrependedAncestors,
      compactDeclaredClasses: new Set(["Tech::BatchOperationWorker"]),
      includedBy: buildIncludedBy(classAncestors, classPrependedAncestors),
    };
  };

  it("resolves `super` from a nested wrapper module to the host's superclass definition", () => {
    const outcome = strat.attempt(superCall("perform"), nestedWrapperCtx());
    expect(outcome.kind).toBe("resolved");
    expect(outcome.kind === "resolved" ? outcome.target.targetSymbolId : null).toBe("ApplicationWorker#perform");
  });

  it("never binds `super` to the calling method itself when host and wrapper share a file", () => {
    // Same fixture minus the superclass definition: the only `perform` short-name
    // in the worker file is the CALLER's own def, so a file-scoped pin would
    // fabricate a self-edge. The walk must fall through to the file-only edge
    // instead of pointing the call at itself.
    const ctx = nestedWrapperCtx();
    const trimmed: CallContext = {
      ...ctx,
      symbolTable: tableWith(
        [
          WORKER,
          [
            sym("Tech::BatchOperationWorker", "BatchOperationWorker", WORKER, ["Tech"]),
            sym("Tech::BatchOperationWorker::PerformWrapper", "PerformWrapper", WORKER, [
              "Tech",
              "BatchOperationWorker",
            ]),
            sym("Tech::BatchOperationWorker::PerformWrapper#perform", "perform", WORKER, [
              "Tech",
              "BatchOperationWorker",
              "PerformWrapper",
            ]),
          ],
        ],
        [APP_WORKER, [sym("ApplicationWorker", "ApplicationWorker", APP_WORKER, [])]],
      ),
    };
    const outcome = strat.attempt(superCall("perform"), trimmed);
    const target = outcome.kind === "resolved" ? outcome.target : null;
    expect(target?.targetSymbolId ?? null).not.toBe("Tech::BatchOperationWorker::PerformWrapper#perform");
  });

  // ── Fixture 2: module reached through the includer's SUPERCLASS namespace ──
  //
  //   lib/base_visitor.rb
  //     module Gql
  //       class BaseVisitor
  //         module ContextMethods
  //           def on_field; super; end
  //         end
  //         def on_field; end
  //       end
  //     end
  //   lib/interpreter_visitor.rb
  //     module Gql
  //       class InterpreterVisitor < BaseVisitor
  //         include ContextMethods      # resolves via the cref's ANCESTORS
  //       end
  //     end
  const BASE = "lib/base_visitor.rb";
  const INTERP = "lib/interpreter_visitor.rb";

  const ancestorScopeCtx = (): CallContext => {
    const classAncestors: Record<string, string[]> = {
      "Gql::InterpreterVisitor": ["BaseVisitor", "ContextMethods"],
    };
    return {
      callerFile: BASE,
      callerScope: ["Gql", "BaseVisitor", "ContextMethods"],
      callerSymbolId: "Gql::BaseVisitor::ContextMethods#on_field",
      imports: [],
      symbolTable: tableWith(
        [
          BASE,
          [
            sym("Gql::BaseVisitor", "BaseVisitor", BASE, ["Gql"]),
            sym("Gql::BaseVisitor#on_field", "on_field", BASE, ["Gql", "BaseVisitor"]),
            sym("Gql::BaseVisitor::ContextMethods", "ContextMethods", BASE, ["Gql", "BaseVisitor"]),
            sym("Gql::BaseVisitor::ContextMethods#on_field", "on_field", BASE, [
              "Gql",
              "BaseVisitor",
              "ContextMethods",
            ]),
          ],
        ],
        [INTERP, [sym("Gql::InterpreterVisitor", "InterpreterVisitor", INTERP, ["Gql"])]],
      ),
      classAncestors,
      classExtends: { "Gql::InterpreterVisitor": "BaseVisitor" },
      includedBy: buildIncludedBy(classAncestors, {}),
    };
  };

  it("resolves `super` from a module the includer mixes in under its superclass's namespace", () => {
    const outcome = strat.attempt(superCall("on_field"), ancestorScopeCtx());
    expect(outcome.kind).toBe("resolved");
    expect(outcome.kind === "resolved" ? outcome.target.targetSymbolId : null).toBe("Gql::BaseVisitor#on_field");
  });

  it("drops rather than guessing when the bare constant is ambiguous across namespaces", () => {
    // Two in-project modules share the segment `Shared`; nothing canonicalizes
    // the includer's raw `Shared` back to the CALLING module, so the consensus
    // retry must not fire.
    const A = "lib/a.rb";
    const B = "lib/b.rb";
    const classAncestors: Record<string, string[]> = { "Ns::Consumer": ["Shared"] };
    const ctx: CallContext = {
      callerFile: B,
      callerScope: ["Other", "Shared"],
      callerSymbolId: "Other::Shared#run",
      imports: [],
      symbolTable: tableWith(
        [A, [sym("Ns::Shared", "Shared", A, ["Ns"]), sym("Ns::Consumer", "Consumer", A, ["Ns"])]],
        [B, [sym("Other::Shared", "Shared", B, ["Other"]), sym("Other::Shared#run", "run", B, ["Other", "Shared"])]],
      ),
      classAncestors,
      includedBy: buildIncludedBy(classAncestors, {}),
    };
    expect(strat.attempt(superCall("run"), ctx).kind).toBe("drop");
  });
});
