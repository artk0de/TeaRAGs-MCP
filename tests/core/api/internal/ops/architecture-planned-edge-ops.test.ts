/**
 * bd tea-rags-mcp-xb669.2: `get_architecture_report` planned-edges mode — the
 * write-time dependency-norm verdict for edges a writer is about to add,
 * judged against the INDEXED graph's ledgers. File paths only; the detector
 * families are not run, and the answer says so.
 *
 * Fixture (one TypeScript family, roles by inheritance): controllers call
 * services (36) and presenters (24), services call repositories (36),
 * presenters call services (24); one service calls a controller back.
 */
import { describe, expect, it, vi } from "vitest";

import { ArchitecturePlannedEdgeOps } from "../../../../../src/core/api/internal/ops/architecture-planned-edge-ops.js";
import { InvalidParameterError } from "../../../../../src/core/api/public/errors.js";
import type { FileDependencyGraph } from "../../../../../src/core/contracts/types/codegraph.js";

const FAMILIES: readonly [string, string, string, readonly string[]][] = [
  ["ui/list.ts", "UiListController", "controller", ["IViewController"]],
  ["ui/form.ts", "UiFormController", "controller", ["IViewController"]],
  ["ui/nav.ts", "UiNavController", "controller", ["IViewController"]],
  ["ui/modal.ts", "UiModalController", "controller", ["IViewController"]],
  ["ui/menu.ts", "UiMenuController", "controller", ["IViewController"]],
  ["ui/tabs.ts", "UiTabsController", "controller", ["IViewController"]],
  ["logic/tasks.ts", "TasksService", "service", ["IService"]],
  ["logic/billing.ts", "BillingService", "service", ["IService"]],
  ["logic/reports.ts", "ReportsService", "service", ["IService"]],
  ["logic/users.ts", "UsersService", "service", ["IService"]],
  ["logic/audit.ts", "AuditService", "service", ["IService"]],
  ["logic/search.ts", "SearchService", "service", ["IService"]],
  ["data/taskRepo.ts", "TaskRepository", "repository", ["IRepository"]],
  ["data/billRepo.ts", "BillRepository", "repository", ["IRepository"]],
  ["data/userRepo.ts", "UserRepository", "repository", ["IRepository"]],
  ["data/auditRepo.ts", "AuditRepository", "repository", ["IRepository"]],
  ["data/searchRepo.ts", "SearchRepository", "repository", ["IRepository"]],
  ["data/reportRepo.ts", "ReportRepository", "repository", ["IRepository"]],
];

function typeRows() {
  return FAMILIES.map(([relPath, shortName, , ancestors]) => ({
    symbolId: `${relPath}#${shortName}`,
    relPath,
    shortName,
    symbolKind: "class" as const,
    ancestors,
  }));
}

function normsGraph(): FileDependencyGraph {
  const files = [
    ...FAMILIES.map(([relPath]) => ({ relPath, language: "typescript", symbolCount: 1 })),
    { relPath: "ui/untyped.ts", language: "typescript", symbolCount: 1 },
  ];
  const edges: FileDependencyGraph["edges"] = [];
  const ofRole = (role: string) => FAMILIES.filter(([, , r]) => r === role).map(([f]) => f);
  for (const c of ofRole("controller")) {
    for (const s of ofRole("service")) edges.push({ sourceRelPath: c, targetRelPath: s, callWeight: 1 });
  }
  for (const s of ofRole("service")) {
    for (const r of ofRole("repository")) edges.push({ sourceRelPath: s, targetRelPath: r, callWeight: 1 });
  }
  edges.push({ sourceRelPath: "logic/tasks.ts", targetRelPath: "ui/list.ts", callWeight: 1 });
  return { files, edges };
}

function graphDb() {
  return {
    readFileDependencyGraph: vi.fn().mockResolvedValue(normsGraph()),
    readTypeNameRows: vi.fn().mockResolvedValue(typeRows()),
    readTemporalCochangeGraph: vi.fn(),
    readNonPublicMemberEdges: vi.fn(),
  };
}

describe("ArchitecturePlannedEdgeOps#judge (bd tea-rags-mcp-xb669.2)", () => {
  it("answers CONFORMS, MISFIT with the established direction, and NEW_PATTERN with the established transit", async () => {
    const response = await new ArchitecturePlannedEdgeOps().judge(graphDb(), {
      plannedEdges: [
        { source: "ui/nav.ts", target: "logic/audit.ts" },
        { source: "logic/billing.ts", target: "ui/form.ts" },
        { source: "ui/list.ts", target: "data/taskRepo.ts" },
      ],
    });

    expect(response.mode).toBe("plannedEdges");
    expect(response.detectorFamilies).toBe("notRun");
    const [conforms, misfit, newPattern] = response.plannedEdgeVerdicts;
    expect(conforms).toMatchObject({
      source: "ui/nav.ts",
      target: "logic/audit.ts",
      verdict: "CONFORMS",
      roleSrc: "controller",
      roleDst: "service",
      pairSupport: 36,
      reverseSupport: 1,
      exclusionsUnchecked: ["constantReference", "uncalled", "frameworkRouted"],
    });
    expect(conforms.expectedPath).toBeUndefined();
    expect(misfit).toMatchObject({
      verdict: "MISFIT",
      roleSrc: "service",
      roleDst: "controller",
      pairSupport: 1,
      reverseSupport: 36,
      expectedPath: { established: { roleSrc: "controller", roleDst: "service", support: 36 } },
    });
    expect(newPattern).toMatchObject({
      verdict: "NEW_PATTERN",
      roleSrc: "controller",
      roleDst: "repository",
      pairSupport: 0,
      expectedPath: { transit: { roles: ["controller", "service", "repository"], supportIn: 36, supportOut: 36 } },
    });
  });

  it("answers UNJUDGED with the reason: new file, non-production file, untyped file", async () => {
    const response = await new ArchitecturePlannedEdgeOps().judge(graphDb(), {
      plannedEdges: [
        { source: "ui/brand-new.ts", target: "logic/audit.ts" },
        { source: "tests/ui/list.test.ts", target: "ui/list.ts" },
        { source: "./ui/untyped.ts", target: "logic/audit.ts" },
      ],
    });

    expect(response.plannedEdgeVerdicts.map((v) => [v.source, v.verdict, v.reason])).toEqual([
      ["ui/brand-new.ts", "UNJUDGED", "newFile"],
      ["tests/ui/list.test.ts", "UNJUDGED", "nonProduction"],
      ["ui/untyped.ts", "UNJUDGED", "untypedFile"],
    ]);
    expect(response.plannedEdgeVerdicts[2].exclusionsUnchecked).toBeUndefined();
  });

  it("reads only the file graph and the type rows — the detector families' reads never run", async () => {
    const db = graphDb();

    await new ArchitecturePlannedEdgeOps().judge(db, {
      plannedEdges: [{ source: "ui/nav.ts", target: "logic/audit.ts" }],
    });

    expect(db.readFileDependencyGraph).toHaveBeenCalledOnce();
    expect(db.readTypeNameRows).toHaveBeenCalledOnce();
    expect(db.readTemporalCochangeGraph).not.toHaveBeenCalled();
    expect(db.readNonPublicMemberEdges).not.toHaveBeenCalled();
  });

  it("rejects more planned edges than the cap, an empty list, and any report option riding along", async () => {
    const ops = new ArchitecturePlannedEdgeOps();
    const edge = { source: "ui/nav.ts", target: "logic/audit.ts" };

    await expect(ops.judge(graphDb(), { plannedEdges: Array.from({ length: 51 }, () => edge) })).rejects.toThrow(
      InvalidParameterError,
    );
    await expect(ops.judge(graphDb(), { plannedEdges: [] })).rejects.toThrow(InvalidParameterError);
    await expect(ops.judge(graphDb(), { plannedEdges: [edge], domain: "ui" })).rejects.toThrow(/domain/);
    await expect(ops.judge(graphDb(), { plannedEdges: [edge], pathPattern: "ui/**" })).rejects.toThrow(/pathPattern/);
  });

  it("answers every planned edge UNJUDGED noCodegraph when no graph can be read", () => {
    expect(
      ArchitecturePlannedEdgeOps.unavailable({ plannedEdges: [{ source: "a.ts", target: "b.ts" }] })
        .plannedEdgeVerdicts,
    ).toEqual([{ source: "a.ts", target: "b.ts", verdict: "UNJUDGED", reason: "noCodegraph" }]);
  });
});
