/**
 * The call-site CLASSIFIERS — the receiver kind and the miss bucket — read the
 * bindings the language's resolver keeps for classification, while resolution
 * keeps reading every visible binding (bd tea-rags-mcp-m99j1.1.65). A binding
 * that is evidence but no type (Python's all-external `value: str | bytes`) must
 * not turn a `dynamic` core homonym into a `localVar` in-project miss.
 */
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  FileExtraction,
  GlobalSymbolTable,
  LocalBinding,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import type { LanguageFactoryDescriptor } from "../../../../../../src/core/contracts/types/language.js";
import { CallEdgeResolutionRunner } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/resolution-runner.js";
import { CodegraphRunState } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";

const EVIDENCE: LocalBinding = { line: 11, type: "", typeRef: { form: "union", members: [] } };

const EXTRACTION: FileExtraction = {
  relPath: "src/pkg/caller.py",
  language: "python",
  fileScope: [],
  imports: [],
  chunks: [
    {
      symbolId: "normalize",
      scope: [],
      startLine: 10,
      localBindings: { value: [EVIDENCE] },
      calls: [{ callText: "value.encode()", receiver: "value", member: "encode", startLine: 12 }],
    },
  ],
};

const TABLE = { lookup: () => [], lookupByShortName: () => [] } as unknown as GlobalSymbolTable;

function verdicts(classifierLocalBindings?: (bindings: CallContext["localBindings"]) => CallContext["localBindings"]): {
  resolvedWith: CallContext[];
  verdict: { receiverKind: string; missBucket?: string };
} {
  const resolvedWith: CallContext[] = [];
  const bound = (call: CallRef, ctx: CallContext): boolean =>
    call.receiver !== null && ctx.localBindings?.[call.receiver] !== undefined;
  const languageFactory = {
    supported: () => ["python"],
    create: () => ({
      resolver: {
        resolve: (_call: unknown, ctx: CallContext) => {
          resolvedWith.push(ctx);
          return null;
        },
        hasInProjectDefinition: () => true,
        // A core homonym is one on an UNTYPED receiver — a bound one is a typed miss.
        targetsCoreAmbiguousMember: (call: CallRef, ctx: CallContext) => !bound(call, ctx),
        ...(classifierLocalBindings === undefined ? {} : { classifierLocalBindings }),
      },
    }),
  } as unknown as LanguageFactoryDescriptor;
  const runner = new CallEdgeResolutionRunner(languageFactory, new CodegraphRunState());
  const [site] = runner.callSiteVerdicts(EXTRACTION, TABLE);
  return { resolvedWith, verdict: site.verdict };
}

describe("CallEdgeResolutionRunner — the resolver's classifier local bindings", () => {
  it("classifies the site without the binding the resolver keeps out of classification", () => {
    const { resolvedWith, verdict } = verdicts((bindings) => {
      const { value: _value, ...rest } = bindings ?? {};
      return rest;
    });
    expect(verdict.receiverKind).toBe("dynamic");
    expect(verdict.missBucket).toBe("coreAmbiguous");
    // Resolution still read the evidence.
    expect(resolvedWith[0].localBindings?.value).toEqual([EVIDENCE]);
  });

  it("classifies against the visible bindings when the resolver has no opinion", () => {
    const { verdict } = verdicts();
    expect(verdict.receiverKind).toBe("localVar");
    expect(verdict.missBucket).toBe("missWithInProjectDef");
  });
});
