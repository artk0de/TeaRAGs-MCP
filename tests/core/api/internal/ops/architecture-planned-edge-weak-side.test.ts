/**
 * bd tea-rags-mcp-8up12: a planned-edges `weakRole` verdict names the weak
 * endpoint — `weakSide` — so the caller knows which end's role is suffix-only.
 * Roles are stubbed: a weak role needs naming-lexicon evidence this fixture
 * does not build, and the invariant under test is the DTO mapping.
 */
import { describe, expect, it, vi } from "vitest";

import { ArchitecturePlannedEdgeOps } from "../../../../../src/core/api/internal/ops/architecture-planned-edge-ops.js";
import type { DependencyNormFileRole } from "../../../../../src/core/contracts/types/codegraph.js";

const ROLES = new Map<string, DependencyNormFileRole>([
  ["ui/controller.ts", { role: "controller", strong: true }],
  ["logic/weak-service.ts", { role: "service", strong: false }],
  ["logic/other-weak.ts", { role: "service", strong: false }],
]);

vi.mock("../../../../../src/core/domains/explore/naming-lexicon/index.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  buildDependencyNormFileRoles: () => ROLES,
}));

function graphDb() {
  const files = [...ROLES.keys()].map((relPath) => ({ relPath, language: "typescript", symbolCount: 1 }));
  return {
    readFileDependencyGraph: vi.fn().mockResolvedValue({ files, edges: [] }),
    readTypeNameRows: vi.fn().mockResolvedValue([]),
    readTemporalCochangeGraph: vi.fn(),
    readNonPublicMemberEdges: vi.fn(),
  };
}

describe("ArchitecturePlannedEdgeOps#judge weakSide (8up12)", () => {
  it("names the weak endpoint of a weakRole verdict: source, target or both", async () => {
    const response = await new ArchitecturePlannedEdgeOps().judge(graphDb(), {
      plannedEdges: [
        { source: "logic/weak-service.ts", target: "ui/controller.ts" },
        { source: "ui/controller.ts", target: "logic/weak-service.ts" },
        { source: "logic/weak-service.ts", target: "logic/other-weak.ts" },
      ],
    });

    expect(response.plannedEdgeVerdicts.map((v) => [v.reason, v.weakSide])).toEqual([
      ["weakRole", "source"],
      ["weakRole", "target"],
      ["weakRole", "both"],
    ]);
  });
});
