import { describe, expect, it } from "vitest";

import type {
  CallRef,
  GlobalSymbolTable,
  SymbolDefinition,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  ResidualSiteCollector,
  residualSiteKey,
  staticSamplePriority,
} from "../../../../../../src/core/domains/trajectory/codegraph/residual/residual-site-builder.js";

function def(symbolId: string, relPath: string): SymbolDefinition {
  const shortName = symbolId.split(/[#.]/).pop() ?? symbolId;
  return { symbolId, fqName: symbolId, shortName, relPath, scope: [] };
}

const DEFS = [
  def("Account#users", "app/models/account.rb"),
  def("Firm#users", "app/models/firm.rb"),
  def("Team#users", "app/models/team.rb"),
  def("Team#title", "app/models/team.rb"),
];
const TABLE: Pick<GlobalSymbolTable, "lookupByShortName"> = {
  lookupByShortName: (name: string) => DEFS.filter((d) => d.shortName === name),
};
const METHOD = { symbolId: "Billing#run", startLine: 10, endLine: 20 };
const CALL: CallRef = {
  callText: "account.users",
  receiver: "account",
  member: "users",
  startLine: 12,
  startColumn: 6,
};
const RESOLVED = {
  receiverKind: "localVar" as const,
  outcome: "resolved" as const,
  edges: [{ sourceSymbolId: "Billing#run", targetSymbolId: "Account#users" }],
};
const EXTERNAL = { receiverKind: "ivar" as const, outcome: "unresolved" as const, missBucket: "externalSkipped" };

const collector = (menuLimit = 40): ResidualSiteCollector =>
  new ResidualSiteCollector("app/services/billing.rb", TABLE, menuLimit, "ruby");

describe("ResidualSiteCollector — static site sample", () => {
  it("samples a resolved non-constant site with its static target, menu and owner count", () => {
    const c = collector();

    c.sampleStatic(METHOD, CALL, RESOLVED, 1);

    const siteKey = residualSiteKey({
      relPath: "app/services/billing.rb",
      methodSymbolId: "Billing#run",
      line: 12,
      column: 6,
      receiverText: "account",
      member: "users",
    });
    expect(c.staticSample()).toEqual([
      {
        siteKey,
        sourceRelPath: "app/services/billing.rb",
        language: "ruby",
        methodSymbolId: "Billing#run",
        methodStartLine: 10,
        methodEndLine: 20,
        line: 12,
        column: 6,
        receiverText: "account",
        receiverKind: "localVar",
        member: "users",
        outcome: "resolved",
        targetSymbolId: "Account#users",
        reason: null,
        owners: 3,
        candidates: ["Account#users", "Firm#users", "Team#users"],
        menuOverflow: false,
        priority: staticSamplePriority(siteKey),
      },
    ]);
  });

  it("samples an external-skipped site with its miss bucket as the reason", () => {
    const c = collector();

    c.sampleStatic(METHOD, { ...CALL, receiver: "@client", callText: "@client.users" }, EXTERNAL, 1);

    expect(c.staticSample()[0]).toMatchObject({
      outcome: "externalSkipped",
      targetSymbolId: null,
      reason: "externalSkipped",
    });
  });

  it("keeps the name-matched block as the menu when the owners overflow the limit", () => {
    const c = collector(2);

    c.sampleStatic(METHOD, CALL, RESOLVED, 1);

    expect(c.staticSample()[0]).toMatchObject({ owners: 3, menuOverflow: true, candidates: ["Account#users"] });
  });

  it("skips constant receivers, other misses, memberless menus and sites over the admission rate", () => {
    const c = collector();

    c.sampleStatic(METHOD, CALL, { ...RESOLVED, receiverKind: "constant" }, 1);
    c.sampleStatic(METHOD, CALL, { ...EXTERNAL, missBucket: "noInProjectDef" }, 1);
    c.sampleStatic(METHOD, { ...CALL, member: "unknown" }, EXTERNAL, 1);
    c.sampleStatic(METHOD, CALL, RESOLVED, 0);

    expect(c.staticSample()).toEqual([]);
  });

  it("derives the priority from the site key alone, in [0, 1)", () => {
    const p = staticSamplePriority("k1");

    expect(staticSamplePriority("k1")).toBe(p);
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThan(1);
    expect(staticSamplePriority("k2")).not.toBe(p);
  });
});
