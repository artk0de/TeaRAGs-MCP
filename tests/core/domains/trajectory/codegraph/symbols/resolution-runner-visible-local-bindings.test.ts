/**
 * The runner hands every call-site reader the chunk's bindings as the
 * LANGUAGE's resolver exposes them (bd tea-rags-mcp-m99j1.1.30 regression): a
 * binding the resolver reports as unreadable is absent from the call-site
 * `CallContext`, so presence readers — the receiver-kind classifier, binding
 * gates, the naming-convention guess — behave as if it was never emitted.
 */
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  FileExtraction,
  GlobalSymbolTable,
  LocalBinding,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import type { LanguageFactoryDescriptor } from "../../../../../../src/core/contracts/types/language.js";
import { CallEdgeResolutionRunner } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/resolution-runner.js";
import { CodegraphRunState } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";

const HIDDEN: LocalBinding = { line: 11, type: "", typeRef: { form: "union", members: [] } };
const KEPT: LocalBinding = { line: 11, type: "Client" };

const EXTRACTION: FileExtraction = {
  relPath: "src/pkg/caller.py",
  language: "python",
  fileScope: [],
  imports: [],
  chunks: [
    {
      symbolId: "Caller#run",
      scope: ["Caller"],
      startLine: 10,
      localBindings: { hidden: [HIDDEN], kept: [KEPT] },
      calls: [{ callText: "hidden.send()", receiver: "hidden", member: "send", startLine: 12 }],
    },
  ],
};

function callSiteContexts(
  visibleLocalBindings?: (bindings: CallContext["localBindings"]) => CallContext["localBindings"],
): CallContext[] {
  const seen: CallContext[] = [];
  const languageFactory = {
    supported: () => ["python"],
    create: () => ({
      resolver: {
        resolve: (_call: unknown, ctx: CallContext) => {
          if (ctx.callerSymbolId !== undefined) seen.push(ctx);
          return null;
        },
        ...(visibleLocalBindings === undefined ? {} : { visibleLocalBindings }),
      },
    }),
  } as unknown as LanguageFactoryDescriptor;
  new CallEdgeResolutionRunner(languageFactory, new CodegraphRunState()).resolve(EXTRACTION, {
    lookup: () => [],
    lookupByShortName: () => [],
  } as unknown as GlobalSymbolTable);
  return seen;
}

describe("CallEdgeResolutionRunner — the resolver's visible local bindings", () => {
  it("hands the call site the bindings the resolver keeps, without the ones it hides", () => {
    const [ctx] = callSiteContexts((bindings) => {
      const { hidden: _hidden, ...rest } = bindings ?? {};
      return rest;
    });
    expect(ctx.localBindings).toEqual({ kept: [KEPT] });
  });

  it("hands the chunk's bindings through untouched when the resolver has no opinion", () => {
    const [ctx] = callSiteContexts();
    expect(ctx.localBindings).toBe(EXTRACTION.chunks[0].localBindings);
  });
});
