import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

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
    const collector = new ResidualSiteCollector("app/services/billing.rb", table, DEFAULT_RESIDUAL_MENU_LIMIT, "ruby");

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
        language: "ruby",
        receiverKind: "dynamic",
      },
    ]);
  });

  it("cuts a menu over the limit and marks it overflowed", () => {
    const defs = ["A", "B", "C"].map((owner) => def(`${owner}#users`, `app/models/${owner}.rb`));
    const collector = new ResidualSiteCollector("app/services/billing.rb", tableOf(defs), 2, "ruby");

    collector.observe(METHOD, CALL, {
      receiverKind: "chain",
      outcome: "ambiguous",
    });

    const [row] = collector.rows();
    expect(row).toMatchObject({
      kind: "ambiguous",
      receiverKind: "chain",
      candidates: ["A#users", "B#users"],
      menuOverflow: true,
    });
    expect(row?.menuHash).toBe(residualMenuHash(["A#users", "B#users"]));
  });

  it("records nothing for a non-residual verdict or an empty menu", () => {
    const collector = new ResidualSiteCollector(
      "app/services/billing.rb",
      tableOf([]),
      DEFAULT_RESIDUAL_MENU_LIMIT,
      "ruby",
    );

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
      "ruby",
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

describe("ResidualSiteCollector — exclusions", () => {
  const table = tableOf([def("Firm#users", "app/models/firm.rb")]);

  it("drops an excluded site and counts it under its rule", () => {
    const collector = new ResidualSiteCollector("app/services/billing.rb", table, DEFAULT_RESIDUAL_MENU_LIMIT, "ruby");

    collector.observe(METHOD, CALL, DYNAMIC_MISS, () => "frameworkMember");
    collector.observe(METHOD, CALL, DYNAMIC_MISS, () => "schemaColumn");
    collector.observe(METHOD, CALL, DYNAMIC_MISS, () => "frameworkMember");
    collector.observe(METHOD, CALL, DYNAMIC_MISS, () => "timestampColumn");

    expect(collector.rows()).toEqual([]);
    expect(collector.excluded()).toEqual({ schemaColumn: 1, frameworkMember: 2, timestampColumn: 1 });
  });

  it("keeps a site the exclusion answers null for", () => {
    const collector = new ResidualSiteCollector("app/services/billing.rb", table, DEFAULT_RESIDUAL_MENU_LIMIT, "ruby");

    collector.observe(METHOD, CALL, DYNAMIC_MISS, () => null);

    expect(collector.rows()).toHaveLength(1);
    expect(collector.excluded()).toEqual({ schemaColumn: 0, frameworkMember: 0, timestampColumn: 0 });
  });

  it("never asks the exclusion for a site that is not residual or has no menu", () => {
    const collector = new ResidualSiteCollector("app/services/billing.rb", table, DEFAULT_RESIDUAL_MENU_LIMIT, "ruby");
    const exclude = vi.fn(() => "frameworkMember" as const);

    collector.observe(METHOD, CALL, { receiverKind: "dynamic", outcome: "resolved" }, exclude);
    collector.observe(METHOD, { ...CALL, member: "nobody" }, DYNAMIC_MISS, exclude);

    expect(exclude).not.toHaveBeenCalled();
    expect(collector.excluded()).toEqual({ schemaColumn: 0, frameworkMember: 0, timestampColumn: 0 });
  });
});

describe("ResidualSiteCollector — framework override (bd 2m83f.48)", () => {
  const table = tableOf([
    def("Lockable#with_lock", "app/models/concerns/lockable.rb"),
    def("Reports::Form#with_lock", "app/forms/form.rb"),
  ]);
  const LOCK: CallRef = { ...CALL, callText: "record.with_lock", receiver: "record", member: "with_lock" };

  it("narrows the menu to the reachable overrides and marks the row frameworkOverride", () => {
    const collector = new ResidualSiteCollector("app/services/billing.rb", table, DEFAULT_RESIDUAL_MENU_LIMIT, "ruby");

    collector.observe(METHOD, LOCK, DYNAMIC_MISS, undefined, () => ["Lockable#with_lock"]);

    const [row] = collector.rows();
    expect(row).toMatchObject({
      reason: "frameworkOverride",
      candidates: ["Lockable#with_lock"],
      menuHash: sha1("Lockable#with_lock"),
      menuOverflow: false,
    });
  });

  it("keeps the full menu and no reason when the hook answers null", () => {
    const collector = new ResidualSiteCollector("app/services/billing.rb", table, DEFAULT_RESIDUAL_MENU_LIMIT, "ruby");

    collector.observe(METHOD, LOCK, DYNAMIC_MISS, undefined, () => null);

    const [row] = collector.rows();
    expect(row?.candidates).toEqual(["Lockable#with_lock", "Reports::Form#with_lock"]);
    expect(row).not.toHaveProperty("reason");
  });

  it("never asks the override hook for an excluded site", () => {
    const collector = new ResidualSiteCollector("app/services/billing.rb", table, DEFAULT_RESIDUAL_MENU_LIMIT, "ruby");
    const override = vi.fn(() => ["Lockable#with_lock"]);

    collector.observe(METHOD, LOCK, DYNAMIC_MISS, () => "frameworkMember", override);

    expect(override).not.toHaveBeenCalled();
    expect(collector.rows()).toEqual([]);
  });
});
