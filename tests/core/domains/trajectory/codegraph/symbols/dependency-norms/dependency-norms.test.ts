/**
 * Dependency norms (bd tea-rags-mcp-rpx0v, epic xb669.2): the repository's
 * empirical P(edge | roleSrc, roleDst, locality), judged per file edge against
 * the project's own precedent — the architecture analogue of the naming
 * lexicon's CONFORMS / MISFIT.
 *
 * Since bd tea-rags-mcp-xb669.8 a verdict is a significance test, not a
 * support cut: per ledger and locality, independence of roles predicts
 * λ = out(roleSrc)·in(roleDst)/N edges for a pair, the p-value is the Poisson
 * lower tail P(X ≤ observed | λ), and Benjamini–Hochberg at the co-change
 * gate's q runs over every pair with expected mass. A pair BH rejects is
 * significantly RARE — a MISFIT when its roles meet through a conforming mid
 * role, else a NEW_PATTERN; every other observed pair CONFORMS.
 *
 * Fixture: controllers (6) call services (6) and render presenters (4),
 * services call repositories (6), presenters call services. Two edges are far
 * rarer than independence predicts: a controller reaching a repository
 * directly (λ ≈ 18.5, observed 1 — the transit controller→service→repository
 * is heavy, a MISFIT with the expected path) and a service calling a
 * presenter (λ ≈ 7.6, observed 1 — no conforming transit, a NEW_PATTERN).
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

const CONTROLLERS = ["ui/list.ts", "ui/form.ts", "ui/nav.ts", "ui/modal.ts", "ui/menu.ts", "ui/tabs.ts"];
const SERVICES = [
  "logic/tasks.ts",
  "logic/billing.ts",
  "logic/reports.ts",
  "logic/users.ts",
  "logic/audit.ts",
  "logic/search.ts",
];
const REPOSITORIES = [
  "data/taskRepo.ts",
  "data/billRepo.ts",
  "data/userRepo.ts",
  "data/auditRepo.ts",
  "data/searchRepo.ts",
  "data/reportRepo.ts",
];
const PRESENTERS = ["present/board.ts", "present/kanban.ts", "present/calendar.ts", "present/timeline.ts"];

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
  for (const c of CONTROLLERS) for (const s of SERVICES) add(c, s); // 36 precedent edges
  for (const s of SERVICES) for (const r of REPOSITORIES) add(s, r); // 36
  for (const p of PRESENTERS) for (const s of SERVICES) add(p, s); // 24
  for (const c of CONTROLLERS) for (const p of PRESENTERS) add(c, p); // 24
  add("ui/list.ts", "data/taskRepo.ts", 2); // λ ≈ 18.5, observed 1; heavy transit via service
  add("logic/tasks.ts", "present/board.ts"); // λ ≈ 7.6, observed 1; no conforming transit
  return { graph: { files, edges }, roles: rolesFixture() };
}

describe("computeDependencyNorms", () => {
  it("flags the edges independence of roles predicts far more of: a MISFIT with the expected transit, and a NEW_PATTERN", () => {
    const { graph, roles } = verdictsFixture();
    const report = computeDependencyNorms({ graph, fileRoles: roles });

    // A TypeScript-only graph is one family, so one ledger carries the test.
    // Family: 3 source roles × 3 target roles with expected mass, all in one
    // locality; BH rejects five — the two flagged edges' pairs plus three
    // pairs nobody wrote (service→service, presenter→repository,
    // presenter→presenter), which are tested members but carry no edge.
    expect(report.ledgers).toEqual([
      {
        family: "ecmascript",
        pairCount: 6,
        significance: {
          method: "poissonIndependenceNull",
          q: 0.05,
          familySize: 9,
          testablePairCount: 9,
          rarePairCount: 5,
        },
      },
    ]);

    expect(report.summary).toMatchObject({
      roleFileCount: 22,
      typedEdgeCount: 122,
      judgedEdgeCount: 122,
      violationCount: 2,
    });
    // The support cut is gone, and with it the count of edges it skipped.
    expect(report.summary.excluded).not.toHaveProperty("lowRoleSupportEdgeCount");
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
      expectedPath: { via: "service", support: 36 },
    });
    // λ = out(controller)·in(repository)/N = 61·37/122; p = e^−λ(1 + λ).
    expect(misfit.expectedSupport).toBeCloseTo(18.5, 10);
    expect(misfit.pValue).toBeCloseTo(Math.exp(-18.5) * 19.5, 15);
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
    expect(newPattern.expectedSupport).toBeCloseTo((37 * 25) / 122, 10);
    expect(newPattern).not.toHaveProperty("expectedPath");
  });

  it("flags a pair with several edges when independence expects far more — rarity is relative, not a support floor", () => {
    const { graph, roles } = verdictsFixture();
    graph.edges.push(
      { sourceRelPath: "ui/form.ts", targetRelPath: "data/billRepo.ts", callWeight: 1 },
      { sourceRelPath: "ui/nav.ts", targetRelPath: "data/userRepo.ts", callWeight: 1 },
    );

    const report = computeDependencyNorms({ graph, fileRoles: roles });

    // controller→repository now holds 3 edges against λ ≈ 19.8: still rare.
    const misfits = report.findings.filter((f) => f.kind === "misfit");
    expect(misfits.map((f) => f.sourceRelPath).sort()).toEqual(["ui/form.ts", "ui/list.ts", "ui/nav.ts"]);
    expect(misfits.every((f) => f.pairSupport === 3)).toBe(true);
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

    // Each locality keeps its own pair counts and its own marginals: the same
    // role pair read once same-directory, once same-domain, never cross-domain.
    const ledger = buildNormLedgers({ graph: localGraph, fileRoles: roles, componentOf }).forLanguage("typescript");
    expect(ledger.pairs.get("service\u0000service\u0000sameDirectory")).toBe(1);
    expect(ledger.pairs.get("service\u0000service\u0000sameDomain")).toBe(1);
    expect(ledger.pairs.has("service\u0000service\u0000crossDomain")).toBe(false);
    // One edge per locality is all its own null expects (λ = 1·1/1): nothing
    // there is rarer than predicted, so nothing is a finding.
    expect(report.findings).toEqual([]);
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
    expect(report.summary.typedEdgeCount).toBe(122);
    expect(report.summary.judgedEdgeCount).toBe(122);
    expect(report.findings.map((f) => f.sourceRelPath)).not.toContain("x/unknown.ts");
    expect(report.findings.map((f) => f.sourceRelPath)).not.toContain("ui/loose.ts");
  });

  it("conforms a singleton pair the null expects no more of: a rarely-active role is no anomaly", () => {
    const { graph, roles } = verdictsFixture();
    const files = [...graph.files, file("legacy/main.ts")];
    roles.set("legacy/main.ts", { role: "bootstrap", strong: true });
    const edges = [
      ...graph.edges,
      { sourceRelPath: "legacy/main.ts", targetRelPath: "present/board.ts", callWeight: 1 },
    ];

    const report = computeDependencyNorms({ graph: { files, edges }, fileRoles: roles });

    // bootstrap carries this one edge: λ = 1·25/123 ≈ 0.2 — one observed edge
    // is MORE than independence predicts, never a finding.
    expect(report.findings.some((f) => f.roleSrc === "bootstrap")).toBe(false);
    expect(report.summary.violationCount).toBe(2);
    // Its pairs enter the family, but no count could make them significantly rare.
    expect(report.ledgers[0].significance).toMatchObject({ familySize: 12, testablePairCount: 9, rarePairCount: 5 });
  });
});

/**
 * bd tea-rags-mcp-23iii (xb669.3): the WRITE-TIME verdict — "I am about to
 * add this edge; does the project do that?" — reads the same ledgers the
 * report findings came from, so one judgment rule serves both.
 */
describe("judgePlannedEdge", () => {
  const { graph, roles } = verdictsFixture();
  const ledgers = buildNormLedgers({ graph, fileRoles: roles }).forLanguage("typescript");

  it("conforms a pair the project does about as often as independence predicts", () => {
    const verdict = judgePlannedEdge(ledgers, { roleSrc: "controller", roleDst: "service", locality: "crossDomain" });
    expect(verdict).toMatchObject({ kind: "conforms", pairSupport: 36 });
    expect(verdict.expectedSupport).toBeCloseTo((61 * 60) / 122, 10);
    expect(verdict).not.toHaveProperty("expectedPath");
  });

  it("names the transit for a significantly rare pair the project routes through a mid role", () => {
    expect(
      judgePlannedEdge(ledgers, { roleSrc: "controller", roleDst: "repository", locality: "crossDomain" }),
    ).toMatchObject({ kind: "misfit", pairSupport: 1, expectedPath: { via: "service", support: 36 } });
  });

  it("names a NEW_PATTERN for a significantly rare pair with no conforming transit", () => {
    const verdict = judgePlannedEdge(ledgers, { roleSrc: "service", roleDst: "presenter", locality: "crossDomain" });
    expect(verdict).toMatchObject({ kind: "newPattern", pairSupport: 1 });
    expect(verdict).not.toHaveProperty("expectedPath");
  });

  it("judges an unwritten pair whose absence is significant: presenter→repository goes through service", () => {
    // λ = 24·37/122 ≈ 7.3 and nobody wrote one: p = e^−λ, rejected by BH.
    expect(
      judgePlannedEdge(ledgers, { roleSrc: "presenter", roleDst: "repository", locality: "crossDomain" }),
    ).toMatchObject({ kind: "misfit", pairSupport: 0, expectedPath: { via: "service", support: 24 } });
  });

  it("answers a pair the null has nothing to say about with insufficient support, not a fabricated verdict", () => {
    // No edge ever targets a controller: λ = 0, no test exists.
    expect(
      judgePlannedEdge(ledgers, { roleSrc: "presenter", roleDst: "controller", locality: "crossDomain" }),
    ).toMatchObject({ kind: "insufficientSupport", pairSupport: 0, expectedSupport: 0, pValue: 1 });
  });
});

it("the report's findings and judgePlannedEdge agree on every finding pair (one judgment rule)", () => {
  const { graph, roles } = verdictsFixture();
  const report = computeDependencyNorms({ graph, fileRoles: roles });
  const book = buildNormLedgers({ graph, fileRoles: roles });

  for (const finding of report.findings) {
    const verdict = judgePlannedEdge(book.forLanguage(finding.family), {
      roleSrc: finding.roleSrc,
      roleDst: finding.roleDst,
      locality: finding.locality,
    });
    expect(verdict.kind).toBe(finding.kind);
    expect(verdict.pairSupport).toBe(finding.pairSupport);
    expect(verdict.expectedSupport).toBe(finding.expectedSupport);
    expect(verdict.pValue).toBe(finding.pValue);
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

/**
 * One ledger per language family (bd tea-rags-mcp-xb669.7). A role name is a
 * word of ONE language's vocabulary: a Ruby `form` persisting straight into a
 * repository says nothing about how a TypeScript `form` should reach one.
 *
 * Fixture: Ruby forms (6) call Ruby repositories (4) directly — 24 precedent
 * edges, Ruby's habit. TypeScript forms (6) go through services (4, one of
 * them JavaScript — the ecmascript family shares one import graph) to
 * repositories (4); one TS form reaches a TS repository directly. A pooled
 * ledger reads `form -> repository` as Ruby's heavy precedent and CONFORMS the
 * TS shortcut (25 observed against λ ≈ 31); per family it is a MISFIT via
 * `service` (1 observed against λ ≈ 10.4). One TS form also reaches a Ruby
 * repository — an edge between two vocabularies.
 */
describe("dependency norms are judged per language family", () => {
  const RB_FORMS = [
    "app/forms/signup.rb",
    "app/forms/invoice.rb",
    "app/forms/job.rb",
    "app/forms/profile.rb",
    "app/forms/settings.rb",
    "app/forms/billing.rb",
  ];
  const RB_REPOS = [
    "app/repos/user_repo.rb",
    "app/repos/job_repo.rb",
    "app/repos/bill_repo.rb",
    "app/repos/profile_repo.rb",
  ];
  const TS_FORMS = [
    "web/forms/Signup.tsx",
    "web/forms/Invoice.tsx",
    "web/forms/CreateJob.tsx",
    "web/forms/Profile.tsx",
    "web/forms/Settings.tsx",
    "web/forms/Billing.tsx",
  ];
  const TS_SERVICES = [
    "web/services/users.ts",
    "web/services/jobs.js",
    "web/services/bills.ts",
    "web/services/profiles.ts",
  ];
  const TS_REPOS = [
    "web/repos/userRepo.ts",
    "web/repos/jobRepo.ts",
    "web/repos/billRepo.ts",
    "web/repos/profileRepo.ts",
  ];

  function polyglotFixture(): { graph: FileDependencyGraph; roles: Map<string, DependencyNormFileRole> } {
    const languageOf = (relPath: string) =>
      relPath.endsWith(".rb") ? "ruby" : relPath.endsWith(".js") ? "javascript" : "typescript";
    const files = [...RB_FORMS, ...RB_REPOS, ...TS_FORMS, ...TS_SERVICES, ...TS_REPOS].map((relPath) => ({
      relPath,
      language: languageOf(relPath),
      symbolCount: 1,
    }));
    const roles = new Map<string, DependencyNormFileRole>();
    for (const f of [...RB_FORMS, ...TS_FORMS]) roles.set(f, { role: "form", strong: true });
    for (const f of [...RB_REPOS, ...TS_REPOS]) roles.set(f, { role: "repository", strong: true });
    for (const f of TS_SERVICES) roles.set(f, { role: "service", strong: true });
    const edges: FileDependencyGraph["edges"] = [];
    const add = (sourceRelPath: string, targetRelPath: string) => {
      edges.push({ sourceRelPath, targetRelPath, callWeight: 1 });
    };
    for (const f of RB_FORMS) for (const r of RB_REPOS) add(f, r); // Ruby: form -> repository x24
    for (const f of TS_FORMS) for (const s of TS_SERVICES) add(f, s); // TS: form -> service x24
    for (const s of TS_SERVICES) for (const r of TS_REPOS) add(s, r); // TS: service -> repository x16
    add("web/forms/CreateJob.tsx", "web/repos/jobRepo.ts"); // TS shortcut: no TS precedent
    add("web/forms/Signup.tsx", "app/repos/user_repo.rb"); // cross-language edge
    return { graph: { files, edges }, roles };
  }

  it("judges a TS form against TS precedent, not a Ruby namesake's habit", () => {
    const { graph, roles } = polyglotFixture();
    const report = computeDependencyNorms({ graph, fileRoles: roles });

    expect(report.findings).toEqual([
      expect.objectContaining({
        kind: "misfit",
        family: "ecmascript",
        sourceRelPath: "web/forms/CreateJob.tsx",
        targetRelPath: "web/repos/jobRepo.ts",
        roleSrc: "form",
        roleDst: "repository",
        pairSupport: 1,
        expectedPath: { via: "service", support: 16 },
      }),
    ]);
  });

  it("leaves a cross-language edge unjudged and out of every ledger, counted with its reason", () => {
    const { graph, roles } = polyglotFixture();
    const report = computeDependencyNorms({ graph, fileRoles: roles });

    expect(report.summary).toMatchObject({
      typedEdgeCount: 66,
      judgedEdgeCount: 65,
      excluded: { crossLanguageEdgeCount: 1 },
    });
    // Each family tests its own pairs: Ruby holds one pair, ecmascript three.
    expect(report.ledgers.map((l) => [l.family, l.pairCount])).toEqual([
      ["ecmascript", 3],
      ["ruby", 1],
    ]);
    const book = buildNormLedgers({ graph, fileRoles: roles });
    expect(book.forEdge("typescript", "ruby")).toBeUndefined();
    expect(book.forEdge("typescript", "javascript")).toBe(book.forLanguage("typescript"));
    expect(book.forLanguage("ruby").pairs.get("form\u0000repository\u0000crossDomain")).toBe(24);
    expect(book.forLanguage("typescript").pairs.get("form\u0000repository\u0000crossDomain")).toBe(1);
  });
});

/**
 * A constant reference is not a role edge (bd tea-rags-mcp-xb669.6): measured
 * on taxdome, `rescue BaseAdapter::RateLimitError` in a retry block counted as
 * a worker -> adapter edge. The edge's recorded reference names a type nested
 * in the target's PRIMARY, not the primary — a dependency on an error class,
 * never on the adapter's role.
 */
describe("computeDependencyNorms - constant references are not role edges", () => {
  it("excludes an edge whose recorded reference names a constant nested in the target's primary type", () => {
    const { graph, roles } = verdictsFixture();
    graph.edges.push({
      sourceRelPath: "logic/billing.ts",
      targetRelPath: "present/kanban.ts",
      callWeight: 0.5,
      importText: "zeitwerk:KanbanPresenter::RateLimitError",
    });
    // A reference to the primary itself stays a role edge.
    graph.edges.push({
      sourceRelPath: "logic/reports.ts",
      targetRelPath: "present/kanban.ts",
      callWeight: 0,
      importText: "zeitwerk:KanbanPresenter",
    });
    const filePrimaryTypes = new Map([["present/kanban.ts", "KanbanPresenter"]]);

    const report = computeDependencyNorms({ graph, fileRoles: roles, filePrimaryTypes });

    expect(report.summary.excluded.constantReferenceEdgeCount).toBe(1);
    expect(report.findings.some((f) => f.sourceRelPath === "logic/billing.ts")).toBe(false);
    expect(report.summary.judgedEdgeCount).toBe(report.summary.typedEdgeCount - 1);
    // The constant reference is never precedent; the reference to the primary
    // is (tasks -> board plus reports -> kanban).
    const ledger = buildNormLedgers({ graph, fileRoles: roles, filePrimaryTypes }).forLanguage("typescript");
    expect(ledger.pairs.get("service\u0000presenter\u0000crossDomain")).toBe(2);
  });

  it("keeps a nested-constant edge that carries a definite resolved call", () => {
    const { graph, roles } = verdictsFixture();
    graph.edges.push({
      sourceRelPath: "logic/billing.ts",
      targetRelPath: "present/kanban.ts",
      callWeight: 1,
      importText: "zeitwerk:KanbanPresenter::RateLimitError",
    });
    const report = computeDependencyNorms({
      graph,
      fileRoles: roles,
      filePrimaryTypes: new Map([["present/kanban.ts", "KanbanPresenter"]]),
    });

    expect(report.summary.excluded.constantReferenceEdgeCount).toBe(0);
  });
});
