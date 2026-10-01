/**
 * Dependency norms (bd tea-rags-mcp-rpx0v, epic xb669.2): the repository's
 * empirical P(edge | roleSrc, roleDst, locality), judged per file edge against
 * the project's own precedent — the architecture analogue of the naming
 * lexicon's CONFORMS / MISFIT.
 *
 * Fixture: controllers (4) call services (3), services call repositories (2),
 * presenters (2) call services — every one a precedent. Two edges have no
 * precedent: a controller reaching a repository directly (the transit
 * controller→service→repository is heavy — a MISFIT with the expected path)
 * and a service calling a presenter (no frequent transit exists — a
 * NEW_PATTERN, both roles frequent on their own).
 */
import { describe, expect, it } from "vitest";

import type {
  DependencyNormFileRole,
  FileDependencyGraph,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  buildNormLedgers,
  computeDependencyNorms,
  judgePlannedEdge,
} from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/index.js";

function file(relPath: string) {
  return { relPath, language: "typescript", symbolCount: 1 };
}

const CONTROLLERS = ["ui/list.ts", "ui/form.ts", "ui/nav.ts", "ui/modal.ts"];
const SERVICES = ["logic/tasks.ts", "logic/billing.ts", "logic/reports.ts"];
const REPOSITORIES = ["data/taskRepo.ts", "data/billRepo.ts"];
const PRESENTERS = ["present/board.ts", "present/kanban.ts"];

function rolesFixture(): Map<string, DependencyNormFileRole> {
  const roles = new Map<string, DependencyNormFileRole>();
  for (const f of CONTROLLERS) roles.set(f, { role: "controller", strong: true });
  for (const f of SERVICES) roles.set(f, { role: "service", strong: true });
  for (const f of REPOSITORIES) roles.set(f, { role: "repository", strong: true });
  for (const f of PRESENTERS) roles.set(f, { role: "presenter", strong: true });
  return roles;
}

function verdictsFixture(): { graph: FileDependencyGraph; roles: Map<string, DependencyNormFileRole> } {
  const files = [...CONTROLLERS, ...SERVICES, ...REPOSITORIES, ...PRESENTERS].map(file);
  const edges: FileDependencyGraph["edges"] = [];
  const add = (sourceRelPath: string, targetRelPath: string, callWeight = 1) => {
    edges.push({ sourceRelPath, targetRelPath, callWeight });
  };
  for (const c of CONTROLLERS) for (const s of SERVICES) add(c, s); // 12 precedent edges
  for (const s of SERVICES) for (const r of REPOSITORIES) add(s, r); // 6
  for (const p of PRESENTERS) for (const s of SERVICES) add(p, s); // 6
  add("ui/list.ts", "data/taskRepo.ts", 2); // no precedent, heavy transit via service
  add("logic/tasks.ts", "present/board.ts"); // no precedent, no transit
  return { graph: { files, edges }, roles: rolesFixture() };
}

describe("computeDependencyNorms", () => {
  it("finds the precedent-less edges: a MISFIT with the expected transit path, and a NEW_PATTERN", () => {
    const { graph, roles } = verdictsFixture();
    const report = computeDependencyNorms({ graph, fileRoles: roles });

    expect(report.threshold.method).toBe("otsu");
    // The cut splits the precedent pairs (12, 6, 6) from the singletons.
    expect(report.threshold.threshold).toBeGreaterThan(1);
    expect(report.threshold.threshold).toBeLessThanOrEqual(6);

    expect(report.summary).toMatchObject({
      roleFileCount: 11,
      typedEdgeCount: 26,
      judgedEdgeCount: 26,
      violationCount: 2,
    });
    expect(report.findings).toHaveLength(2);
    const [misfit, newPattern] = report.findings;
    expect(misfit).toMatchObject({
      kind: "misfit",
      sourceRelPath: "ui/list.ts",
      targetRelPath: "data/taskRepo.ts",
      roleSrc: "controller",
      roleDst: "repository",
      locality: "crossDomain",
      callWeight: 2,
      pairSupport: 1,
      expectedPath: { via: "service", support: 6 },
    });
    expect(newPattern).toMatchObject({
      kind: "newPattern",
      sourceRelPath: "logic/tasks.ts",
      targetRelPath: "present/board.ts",
      roleSrc: "service",
      roleDst: "presenter",
      locality: "crossDomain",
      callWeight: 1,
      pairSupport: 1,
    });
    expect(newPattern).not.toHaveProperty("expectedPath");
  });

  it("judges locality: same-directory, then same-domain, else cross-domain", () => {
    const { graph, roles: baseRoles } = verdictsFixture();
    // Two files of one directory and two of one domain component, different
    // directories: the same service→service precedent pair read three ways.
    const edges = [
      { sourceRelPath: "logic/tasks.ts", targetRelPath: "logic/reports.ts", callWeight: 3 },
      { sourceRelPath: "logic/billing.ts", targetRelPath: "logic/inner/notes.ts", callWeight: 3 },
    ];
    const localGraph = { files: [...graph.files, file("logic/inner/notes.ts")], edges };
    const roles = new Map(baseRoles);
    roles.set("logic/inner/notes.ts", { role: "service", strong: true });
    const componentOf = new Map([
      ["logic/tasks.ts", "logic"],
      ["logic/reports.ts", "logic"],
      ["logic/billing.ts", "logic"],
      ["logic/inner/notes.ts", "logic"],
    ]);

    const report = computeDependencyNorms({ graph: localGraph, fileRoles: roles, componentOf });

    // Findings sort by source within equal weight: billing before tasks.
    expect(report.findings.map((f) => [f.locality, f.pairSupport])).toEqual([
      ["sameDomain", 1],
      ["sameDirectory", 1],
    ]);
    // Each locality has its own precedent ledger: one edge is no precedent
    // anywhere here, whatever the cross-domain pairs of the other fixture say.
    expect(report.summary.judgedEdgeCount).toBe(2);
  });

  it("never judges an edge touching an untyped or weak-role file, and counts both", () => {
    const { graph, roles } = verdictsFixture();
    const files = [...graph.files, file("x/unknown.ts"), file("ui/loose.ts")];
    roles.set("ui/loose.ts", { role: "helper", strong: false });
    const edges = [
      ...graph.edges,
      { sourceRelPath: "x/unknown.ts", targetRelPath: "data/taskRepo.ts", callWeight: 5 },
      { sourceRelPath: "ui/loose.ts", targetRelPath: "logic/tasks.ts", callWeight: 5 },
    ];

    const report = computeDependencyNorms({ graph: { files, edges }, fileRoles: roles });

    expect(report.summary.untypedFileCount).toBe(1);
    expect(report.summary.weakRoleFileCount).toBe(1);
    expect(report.summary.typedEdgeCount).toBe(26);
    expect(report.summary.judgedEdgeCount).toBe(26);
    expect(report.findings.map((f) => f.sourceRelPath)).not.toContain("x/unknown.ts");
    expect(report.findings.map((f) => f.sourceRelPath)).not.toContain("ui/loose.ts");
  });

  it("skips a rare pair whose roles are themselves rare: too little support to name a pattern", () => {
    const { graph, roles } = verdictsFixture();
    const files = [...graph.files, file("legacy/main.ts")];
    roles.set("legacy/main.ts", { role: "bootstrap", strong: true });
    const edges = [
      ...graph.edges,
      { sourceRelPath: "legacy/main.ts", targetRelPath: "present/board.ts", callWeight: 1 },
    ];

    const report = computeDependencyNorms({ graph: { files, edges }, fileRoles: roles });

    // presenter carries 6 edges — frequent; bootstrap carries this one edge —
    // not, so the pair is excluded from judgement, not a NEW_PATTERN.
    expect(report.findings.some((f) => f.roleSrc === "bootstrap")).toBe(false);
    expect(report.summary.violationCount).toBe(2);
  });
});

/**
 * bd tea-rags-mcp-23iii (xb669.3): the WRITE-TIME verdict — "I am about to
 * add this edge; does the project do that?" — reads the same ledgers the
 * report findings came from, so one judgment rule serves both.
 */
describe("judgePlannedEdge", () => {
  const { graph, roles } = verdictsFixture();
  const ledgers = buildNormLedgers({ graph, fileRoles: roles });

  it("conforms a precedented pair", () => {
    expect(judgePlannedEdge(ledgers, { roleSrc: "controller", roleDst: "service", locality: "crossDomain" })).toEqual({
      kind: "conforms",
      pairSupport: 12,
    });
  });

  it("names the transit for a pair the project routes through a mid role", () => {
    expect(
      judgePlannedEdge(ledgers, { roleSrc: "controller", roleDst: "repository", locality: "crossDomain" }),
    ).toEqual({ kind: "misfit", pairSupport: 1, expectedPath: { via: "service", support: 6 } });
  });

  it("names a NEW_PATTERN between two frequent roles the corpus never showed meeting", () => {
    expect(judgePlannedEdge(ledgers, { roleSrc: "service", roleDst: "presenter", locality: "crossDomain" })).toEqual({
      kind: "newPattern",
      pairSupport: 1,
    });
  });

  it("refuses to name a pattern between two roles the corpus barely observed", () => {
    const files = [...graph.files, file("legacy/main.ts")];
    const bootstrapRoles = new Map(roles);
    bootstrapRoles.set("legacy/main.ts", { role: "bootstrap", strong: true });
    const bootstrapLedgers = buildNormLedgers({
      graph: {
        files,
        edges: [...graph.edges, { sourceRelPath: "legacy/main.ts", targetRelPath: "present/board.ts", callWeight: 1 }],
      },
      fileRoles: bootstrapRoles,
    });

    expect(
      judgePlannedEdge(bootstrapLedgers, { roleSrc: "bootstrap", roleDst: "presenter", locality: "crossDomain" }),
    ).toEqual({ kind: "insufficientSupport", pairSupport: 1 });
  });

  it("answers an unseen pair with zero support, not a fabricated verdict", () => {
    // presenter→repository HAS a transit (via service — a misfit); this pair
    // has no frequent transit either way, so zero support reads NEW_PATTERN.
    expect(judgePlannedEdge(ledgers, { roleSrc: "presenter", roleDst: "controller", locality: "crossDomain" })).toEqual(
      {
        kind: "newPattern",
        pairSupport: 0,
      },
    );
  });
});

it("the report's findings and judgePlannedEdge agree on every finding pair (one judgment rule)", () => {
  const { graph, roles } = verdictsFixture();
  const report = computeDependencyNorms({ graph, fileRoles: roles });
  const ledgers = buildNormLedgers({ graph, fileRoles: roles });

  for (const finding of report.findings) {
    const verdict = judgePlannedEdge(ledgers, {
      roleSrc: finding.roleSrc,
      roleDst: finding.roleDst,
      locality: finding.locality,
    });
    expect(verdict.kind).toBe(finding.kind);
    expect(verdict.pairSupport).toBe(finding.pairSupport);
    expect(verdict.expectedPath).toEqual(finding.expectedPath);
  }
  expect(report.findings.length).toBeGreaterThan(0);
});

/**
 * bd tea-rags-mcp-mv8yv: `sourcePathPattern` scopes the FINDINGS by source
 * file, the way every other detector scopes - ledgers, supports and the cut
 * stay whole-graph (instability, adoption and strength cut do too), and the
 * findings the scope drops are counted, not silently lost.
 */
describe("computeDependencyNorms - sourcePathPattern", () => {
  it("keeps findings whose source matches and counts the rest as out of scope", () => {
    const { graph, roles } = verdictsFixture();
    const report = computeDependencyNorms({ graph, fileRoles: roles, sourcePathPattern: "ui/**" });

    // Both precedent-less edges are ui-list-sourced? No: the misfit is
    // ui/list.ts -> data/taskRepo.ts (ui source, kept); the newPattern is
    // logic/tasks.ts -> present/board.ts (logic source, dropped).
    expect(report.findings.map((f) => [f.kind, f.sourceRelPath])).toEqual([["misfit", "ui/list.ts"]]);
    expect(report.summary.outOfScopeFindingCount).toBe(1);
    expect(report.summary.violationCount).toBe(1);
  });

  it("leaves the summary untouched when the pattern names no scope", () => {
    const { graph, roles } = verdictsFixture();
    const report = computeDependencyNorms({ graph, fileRoles: roles });

    expect(report.summary).not.toHaveProperty("outOfScopeFindingCount");
    expect(report.summary.violationCount).toBe(2);
  });

  it("admits all findings under a pattern every source matches", () => {
    const { graph, roles } = verdictsFixture();
    const report = computeDependencyNorms({ graph, fileRoles: roles, sourcePathPattern: "{ui,logic,present,data}/**" });

    expect(report.findings).toHaveLength(2);
    expect(report.summary.outOfScopeFindingCount).toBe(0);
  });
});
