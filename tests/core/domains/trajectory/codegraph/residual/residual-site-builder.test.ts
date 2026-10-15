import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
  CallRef,
  GlobalSymbolTable,
  SymbolDefinition,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  DEFAULT_RESIDUAL_MENU_LIMIT,
  residualKindOf,
  residualMenuHash,
  ResidualSiteCollector,
  residualSiteKey,
} from "../../../../../../src/core/domains/trajectory/codegraph/residual/residual-site-builder.js";

const sha1 = (text: string): string => createHash("sha1").update(text).digest("hex");

function def(symbolId: string, relPath: string): SymbolDefinition {
  const shortName = symbolId.split(/[#.]/).pop() ?? symbolId;
  return { symbolId, fqName: symbolId, shortName, relPath, scope: [] };
}

function tableOf(defs: SymbolDefinition[]): Pick<GlobalSymbolTable, "lookupByShortName"> {
  return {
    lookupByShortName: (name: string) => defs.filter((d) => d.shortName === name),
  };
}

const CALL: CallRef = {
  callText: "account.users",
  receiver: "account",
  member: "users",
  startLine: 12,
  startColumn: 6,
};
const METHOD = { symbolId: "Billing#run", startLine: 10, endLine: 20 };
const DYNAMIC_MISS = {
  receiverKind: "dynamic",
  outcome: "unresolved",
  missBucket: "missWithInProjectDef",
} as const;

describe("residualKindOf", () => {
  it("records an over-cap fan-out as ambiguous", () => {
    expect(residualKindOf({ receiverKind: "localVar", outcome: "ambiguous" })).toBe("ambiguous");
  });

  it("records an in-project miss on an untyped receiver as dynamic", () => {
    expect(residualKindOf(DYNAMIC_MISS)).toBe("dynamic");
    expect(residualKindOf({ ...DYNAMIC_MISS, receiverKind: "ivar" })).toBe("dynamic");
    expect(residualKindOf({ ...DYNAMIC_MISS, receiverKind: "chain" })).toBe("dynamic");
  });

  it("skips resolved sites, other miss buckets and receivers with type evidence", () => {
    expect(residualKindOf({ receiverKind: "dynamic", outcome: "resolved" })).toBeNull();
    expect(residualKindOf({ ...DYNAMIC_MISS, missBucket: "noInProjectDef" })).toBeNull();
    expect(residualKindOf({ ...DYNAMIC_MISS, missBucket: "coreAmbiguous" })).toBeNull();
    expect(residualKindOf({ ...DYNAMIC_MISS, receiverKind: "localVar" })).toBeNull();
    expect(residualKindOf({ ...DYNAMIC_MISS, receiverKind: "constant" })).toBeNull();
  });
});

describe("residual hashes", () => {
  it("keys a site by file, method, position, receiver and member", () => {
    expect(
      residualSiteKey({
        relPath: "app/a.rb",
        methodSymbolId: "Billing#run",
        line: 12,
        column: 6,
        receiverText: "account",
        member: "users",
      }),
    ).toBe(sha1(["app/a.rb", "Billing#run", "12", "6", "account", "users"].join("\u0000")));
  });

  it("hashes the sorted menu joined by newlines", () => {
    expect(residualMenuHash(["Firm#users", "Team#users"])).toBe(sha1("Firm#users\nTeam#users"));
  });
});

describe("ResidualSiteCollector", () => {
  it("builds a dynamic row whose menu is every same-language namesake method, sorted", () => {
    const table = tableOf([
      def("Team#users", "app/models/team.rb"),
      def("Firm#users", "app/models/firm.rb"),
      def("Firm#users", "app/models/firm/reopened.rb"),
      def("users", "app/helpers/users.rb"),
      def("Firm#users", "web/src/firm.ts"),
    ]);
    const collector = new ResidualSiteCollector("app/services/billing.rb", table, DEFAULT_RESIDUAL_MENU_LIMIT);

    collector.observe(METHOD, CALL, DYNAMIC_MISS);

    expect(collector.rows()).toEqual([
      {
        siteKey: residualSiteKey({
          relPath: "app/services/billing.rb",
          methodSymbolId: "Billing#run",
          line: 12,
          column: 6,
          receiverText: "account",
          member: "users",
        }),
        sourceRelPath: "app/services/billing.rb",
        methodSymbolId: "Billing#run",
        methodStartLine: 10,
        methodEndLine: 20,
        line: 12,
        column: 6,
        receiverText: "account",
        member: "users",
        kind: "dynamic",
        candidates: ["Firm#users", "Team#users"],
        menuHash: residualMenuHash(["Firm#users", "Team#users"]),
        menuOverflow: false,
      },
    ]);
  });

  it("cuts a menu over the limit and marks it overflowed", () => {
    const defs = ["A", "B", "C"].map((owner) => def(`${owner}#users`, `app/models/${owner}.rb`));
    const collector = new ResidualSiteCollector("app/services/billing.rb", tableOf(defs), 2);

    collector.observe(METHOD, CALL, {
      receiverKind: "chain",
      outcome: "ambiguous",
    });

    const [row] = collector.rows();
    expect(row).toMatchObject({
      kind: "ambiguous",
      candidates: ["A#users", "B#users"],
      menuOverflow: true,
    });
    expect(row?.menuHash).toBe(residualMenuHash(["A#users", "B#users"]));
  });

  it("records nothing for a non-residual verdict or an empty menu", () => {
    const collector = new ResidualSiteCollector("app/services/billing.rb", tableOf([]), DEFAULT_RESIDUAL_MENU_LIMIT);

    collector.observe(METHOD, CALL, DYNAMIC_MISS);
    collector.observe(METHOD, CALL, {
      receiverKind: "dynamic",
      outcome: "resolved",
    });

    expect(collector.rows()).toEqual([]);
  });

  it("falls back to the call line and column 0 when positions are missing", () => {
    const collector = new ResidualSiteCollector(
      "app/services/billing.rb",
      tableOf([def("Firm#users", "app/models/firm.rb")]),
      DEFAULT_RESIDUAL_MENU_LIMIT,
    );

    collector.observe(
      { symbolId: "Billing#run" },
      { callText: "users", receiver: null, member: "users", startLine: 12 },
      DYNAMIC_MISS,
    );

    expect(collector.rows()[0]).toMatchObject({
      methodStartLine: 12,
      methodEndLine: 12,
      column: 0,
      receiverText: "",
    });
  });
});
