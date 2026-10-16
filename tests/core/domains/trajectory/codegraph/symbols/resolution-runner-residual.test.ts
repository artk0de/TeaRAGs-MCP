import { describe, expect, it, vi } from "vitest";

import type {
  FileExtraction,
  GlobalSymbolTable,
  SymbolDefinition,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import type { LanguageFactoryDescriptor } from "../../../../../../src/core/contracts/types/language.js";
import { residualMenuHash } from "../../../../../../src/core/domains/trajectory/codegraph/residual/residual-site-builder.js";
import { CallEdgeResolutionRunner } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/resolution-runner.js";
import { CodegraphRunState } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";

const DEFS: SymbolDefinition[] = [
  {
    symbolId: "Firm#users",
    fqName: "Firm#users",
    shortName: "users",
    relPath: "app/models/firm.rb",
    scope: ["Firm"],
  },
  {
    symbolId: "Team#users",
    fqName: "Team#users",
    shortName: "users",
    relPath: "app/models/team.rb",
    scope: ["Team"],
  },
];
const TABLE = {
  lookup: () => [],
  lookupByShortName: (name: string) => DEFS.filter((d) => d.shortName === name),
} as unknown as GlobalSymbolTable;

function factoryWith(resolver: object): LanguageFactoryDescriptor {
  return {
    supported: () => ["ruby"],
    create: () => ({ resolver }),
  } as unknown as LanguageFactoryDescriptor;
}

const EXTRACTION: FileExtraction = {
  relPath: "app/services/billing.rb",
  language: "ruby",
  imports: [],
  fileScope: [],
  chunks: [
    {
      symbolId: "Billing#run",
      scope: ["Billing"],
      startLine: 10,
      endLine: 20,
      calls: [
        {
          callText: "account.users",
          receiver: "account",
          member: "users",
          startLine: 12,
          startColumn: 6,
        },
      ],
    },
  ],
};

describe("CallEdgeResolutionRunner.resolve — residual call sites", () => {
  it("attaches a dynamic residual row for an untyped receiver whose member the project declares", () => {
    const resolver = {
      resolve: () => null,
      hasInProjectDefinition: () => true,
    };
    const runner = new CallEdgeResolutionRunner(factoryWith(resolver), new CodegraphRunState());

    const edges = runner.resolve(EXTRACTION, TABLE);

    expect(edges.methodEdges).toEqual([]);
    expect(edges.residualCallSites).toEqual([
      expect.objectContaining({
        sourceRelPath: "app/services/billing.rb",
        methodSymbolId: "Billing#run",
        methodStartLine: 10,
        methodEndLine: 20,
        line: 12,
        column: 6,
        kind: "dynamic",
        candidates: ["Firm#users", "Team#users"],
        menuHash: residualMenuHash(["Firm#users", "Team#users"]),
        menuOverflow: false,
      }),
    ]);
  });

  it("attaches an ambiguous residual row next to the over-cap aggregate", () => {
    const resolver = {
      resolve: () => null,
      resolveDispatch: () => ({
        kind: "ambiguous",
        member: "users",
        candidateCount: 17,
      }),
    };
    const runner = new CallEdgeResolutionRunner(factoryWith(resolver), new CodegraphRunState());

    const edges = runner.resolve(EXTRACTION, TABLE);

    expect(edges.ambiguousFanouts).toHaveLength(1);
    expect(edges.residualCallSites?.map((r) => r.kind)).toEqual(["ambiguous"]);
  });

  it("cuts menus at the limit the runner was built with", () => {
    const resolver = {
      resolve: () => null,
      hasInProjectDefinition: () => true,
    };
    const runner = new CallEdgeResolutionRunner(factoryWith(resolver), new CodegraphRunState(), 1);

    const edges = runner.resolve(EXTRACTION, TABLE);

    expect(edges.residualCallSites?.[0]).toMatchObject({
      candidates: ["Firm#users"],
      menuOverflow: true,
    });
  });

  it("attaches no residual field when every call resolved", () => {
    const resolver = {
      resolve: () => ({
        targetSymbolId: "Firm#users",
        targetRelPath: "app/models/firm.rb",
      }),
    };
    const runner = new CallEdgeResolutionRunner(factoryWith(resolver), new CodegraphRunState());

    const edges = runner.resolve(EXTRACTION, TABLE);

    expect(edges).not.toHaveProperty("residualCallSites");
  });
});

describe("CallEdgeResolutionRunner.resolve — residual exclusions", () => {
  it("drops a site the language excludes and folds the count into the run stats", () => {
    const residualExclusion = vi.fn(() => "frameworkMember" as const);
    const resolver = {
      resolve: () => null,
      hasInProjectDefinition: () => true,
      residualExclusion,
    };
    const runState = new CodegraphRunState();
    const runner = new CallEdgeResolutionRunner(factoryWith(resolver), runState);

    const edges = runner.resolve(EXTRACTION, TABLE);

    expect(edges).not.toHaveProperty("residualCallSites");
    expect(residualExclusion).toHaveBeenCalledWith(expect.objectContaining({ member: "users" }), expect.anything());
    expect(runState.stats.residualSitesExcluded).toEqual({ schemaColumn: 0, frameworkMember: 1, timestampColumn: 0 });
  });

  it("keeps the site when the language answers no exclusion", () => {
    const resolver = {
      resolve: () => null,
      hasInProjectDefinition: () => true,
      residualExclusion: () => null,
    };
    const runState = new CodegraphRunState();
    const runner = new CallEdgeResolutionRunner(factoryWith(resolver), runState);

    const edges = runner.resolve(EXTRACTION, TABLE);

    expect(edges.residualCallSites).toHaveLength(1);
    expect(runState.stats.residualSitesExcluded).toEqual({ schemaColumn: 0, frameworkMember: 0, timestampColumn: 0 });
  });
});
