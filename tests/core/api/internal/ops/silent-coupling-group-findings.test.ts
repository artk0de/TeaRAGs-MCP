/**
 * get_architecture_report's silent-coupling listing (bd tea-rags-mcp-89k7k.1.14,
 * presentation): live on taxdome 15 of 22 rows were one locale file against each
 * component — every pair statistically real, the section unreadable. Pairs
 * sharing an endpoint list as ONE grouped finding carrying every partner and a
 * ready-to-run find_co_changed drill; the rest stay pair findings.
 */
import { describe, expect, it } from "vitest";

import { silentCouplingArchitectureViolations } from "../../../../../src/core/api/internal/ops/architecture-report-ops.js";
import type { SilentCouplingViolation } from "../../../../../src/core/domains/trajectory/codegraph/temporal/index.js";

function violation(
  relPathA: string,
  relPathB: string,
  support: number,
  strength: number,
  expectedSupport?: number,
): SilentCouplingViolation {
  return {
    relPathA,
    relPathB,
    support,
    confidenceAB: 0.9,
    confidenceBA: 0.8,
    lift: 3,
    strength,
    ...(expectedSupport === undefined ? {} : { expectedSupport }),
    lastCoChangeAt: 1_700_000_000,
    sampleCommits: ["c1"],
    structuralVisibility: "one-walked",
    directoryRelation: "disjoint",
  };
}

// Strongest first, as the detector hands them over.
const VIOLATIONS = [
  violation("app/SidebarIds.ts", "config/locales/en.yml", 30, 0.71, 4.8),
  violation("app/Menu.tsx", "config/locales/en.yml", 20, 0.66, 4.1234),
  violation("lib/x.ts", "lib/y.ts", 9, 0.64),
  violation("app/Footer.tsx", "config/locales/en.yml", 12, 0.62, 3.25),
];

describe("silentCouplingArchitectureViolations", () => {
  it("lists 3 pairs sharing one endpoint as one group (every partner, top-3 evidence, exact drill) and the unrelated pair as a pair", () => {
    const listed = silentCouplingArchitectureViolations(VIOLATIONS, 50);

    const partners = [
      { relPath: "app/SidebarIds.ts", support: 30, expectedSupport: 4.8, strength: 0.71 },
      { relPath: "app/Menu.tsx", support: 20, expectedSupport: 4.123, strength: 0.66 },
      { relPath: "app/Footer.tsx", support: 12, expectedSupport: 3.25, strength: 0.62 },
    ];
    expect(listed).toEqual([
      {
        detector: "silentCoupling",
        kind: "group",
        relPath: "config/locales/en.yml",
        subject: "config/locales/en.yml co-changes significantly with 3 files without a structural edge",
        partnerCount: 3,
        evidence: {
          topPartners: partners,
          maxStrength: 0.71,
          drillDown: {
            tool: "find_co_changed",
            files: ["config/locales/en.yml"],
            limit: 3,
            hint: 'call find_co_changed(files: ["config/locales/en.yml"], limit: 3) to list this file\'s co-change partners',
          },
        },
        partners,
      },
      expect.objectContaining({ detector: "silentCoupling", sourceRelPath: "lib/x.ts", targetRelPath: "lib/y.ts" }),
    ]);
  });

  it("loses no pair: every violation is a group partner or a pair finding, exactly once", () => {
    const listed = silentCouplingArchitectureViolations(VIOLATIONS, 50);
    const seen = listed.flatMap((finding) => {
      if (finding.detector !== "silentCoupling") return [];
      if ("kind" in finding) return finding.partners.map((p) => [finding.relPath, p.relPath].sort().join("|"));
      return [[finding.sourceRelPath, finding.targetRelPath].sort().join("|")];
    });
    expect(seen.sort()).toEqual(VIOLATIONS.map((v) => [v.relPathA, v.relPathB].sort().join("|")).sort());
  });

  it("is deterministic whatever the input order, and limit caps findings, never a group's partners", () => {
    const forward = silentCouplingArchitectureViolations(VIOLATIONS, 50);
    expect(silentCouplingArchitectureViolations([...VIOLATIONS].reverse(), 50)).toEqual([forward[0], forward[1]]);
    const capped = silentCouplingArchitectureViolations(VIOLATIONS, 1);
    expect(capped).toHaveLength(1);
    expect(capped[0]).toMatchObject({ kind: "group", partnerCount: 3 });
  });
});
