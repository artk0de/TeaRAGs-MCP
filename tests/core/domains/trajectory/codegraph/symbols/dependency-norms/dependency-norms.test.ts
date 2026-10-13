/**
 * Dependency norms (bd tea-rags-mcp-rpx0v, epic xb669.2): the repository's
 * empirical role-pair ledgers, judged per file edge against the project's own
 * precedent — the architecture analogue of the naming lexicon's CONFORMS /
 * MISFIT.
 *
 * Since bd tea-rags-mcp-xb669.8 (owner decision after the Poisson and NB2
 * independence nulls both failed on taxdome) a MISFIT is a DIRECTION
 * INVERSION: per ledger, localities pooled, each unordered role pair {A, B}
 * (A ≠ B) is a sign test of n(A→B) against n(B→A) at p = ½, Benjamini–Hochberg
 * at the co-change gate's q over every pair holding an edge. A significant
 * pair has an established direction, and every edge against it is a MISFIT.
 * Every other edge CONFORMS. NEW_PATTERN is no whole-repo verdict any more —
 * it belongs to diff time (xb669.3 / xb669.2).
 *
 * Fixture (one TypeScript family, every endpoint in its role's own directory):
 *   controller→service 24, service→controller 1      — inverted: 1 MISFIT
 *   service→repository 30, repository→service 2      — inverted: 2 MISFITs
 *   model→record 62, record→model 61                 — mutual: nothing
 *   worker→job 772, job→worker 0                     — one-way: significant, no MISFIT
 *   presenter→view 3, 0                              — too small to establish anything
 *   helper→form 2, form→helper 1                     — too small to establish anything
 *   service→service 5                                — same role: out of scope
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
  judgePlannedFileEdges,
} from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/index.js";
import { signTestPValue } from "../../../../../../../src/core/primitives/math/statistics/index.js";

type PairCount = [roleSrc: string, roleDst: string, edgeCount: number];

const PAIR_COUNTS: PairCount[] = [
  ["controller", "service", 24],
  ["service", "controller", 1],
  ["service", "repository", 30],
  ["repository", "service", 2],
  ["model", "record", 62],
  ["record", "model", 61],
  ["worker", "job", 772],
  ["presenter", "view", 3],
  ["helper", "form", 2],
  ["form", "helper", 1],
];

/** The i-th file of a role, in that role's own directory. */
function roleFile(role: string, index: number): string {
  return `${role}/${role}${index}.ts`;
}

/**
 * A graph holding exactly `pairCounts` edges: the i-th edge of a pair joins
 * the i-th file of each role, so edges never repeat and both directions of a
 * pair may meet the same two files.
 */
function graphFromPairs(
  pairCounts: PairCount[],
  sameRoleEdges: number,
): { graph: FileDependencyGraph; roles: Map<string, DependencyNormFileRole> } {
  const roles = new Map<string, DependencyNormFileRole>();
  const edges: FileDependencyGraph["edges"] = [];
  const add = (roleSrc: string, sourceIndex: number, roleDst: string, targetIndex: number) => {
    const sourceRelPath = roleFile(roleSrc, sourceIndex);
    const targetRelPath = roleFile(roleDst, targetIndex);
    roles.set(sourceRelPath, { role: roleSrc, strong: true });
    roles.set(targetRelPath, { role: roleDst, strong: true });
    edges.push({ sourceRelPath, targetRelPath, callWeight: 1 });
  };
  for (const [roleSrc, roleDst, count] of pairCounts) for (let i = 0; i < count; i++) add(roleSrc, i, roleDst, i);
  for (let i = 0; i < sameRoleEdges; i++) add("service", i, "service", i + 1);
  const files = [...roles.keys()].map((relPath) => ({ relPath, language: "typescript", symbolCount: 1 }));
  return { graph: { files, edges }, roles };
}

function inversionFixture() {
  return graphFromPairs(PAIR_COUNTS, 5);
}

const FIXTURE_EDGE_COUNT = 24 + 1 + 30 + 2 + 62 + 61 + 772 + 3 + 2 + 1 + 5;

describe("computeDependencyNorms — MISFIT is a direction inversion", () => {
  it("tests every unordered role pair holding an edge, same-role pairs aside, under BH", () => {
    const { graph, roles } = inversionFixture();
    const report = computeDependencyNorms({ graph, fileRoles: roles });

    // Six pairs; sorted p: 2^−771 (one-way), 1058/2^32, 52/2^25, ¼, 1, 1.
    // BH at q = 0.05 over m = 6 rejects the first three.
    expect(report.ledgers).toEqual([
      {
        family: "ecmascript",
        pairCount: 11,
        significance: {
          method: "directionInversion",
          q: 0.05,
          familySize: 6,
          significantPairCount: 3,
          oneWayPairCount: 1,
        },
      },
    ]);
    expect(report.summary).toMatchObject({
      typedEdgeCount: FIXTURE_EDGE_COUNT,
      judgedEdgeCount: FIXTURE_EDGE_COUNT,
      violationCount: 3,
    });
  });

  it("flags the lone edge against a 24:1 established direction, with both counts, p and the direction", () => {
    const { graph, roles } = inversionFixture();
    const report = computeDependencyNorms({ graph, fileRoles: roles });

    const inverted = report.findings.filter((f) => f.roleSrc === "service" && f.roleDst === "controller");
    expect(inverted).toEqual([
      {
        kind: "misfit",
        family: "ecmascript",
        sourceRelPath: "service/service0.ts",
        targetRelPath: "controller/controller0.ts",
        roleSrc: "service",
        roleDst: "controller",
        locality: "crossDomain",
        callWeight: 1,
        pairSupport: 1,
        pValue: signTestPValue(24, 1),
        establishedDirection: { roleSrc: "controller", roleDst: "service", support: 24 },
      },
    ]);
    // The majority direction's own edges conform.
    expect(report.findings.some((f) => f.roleSrc === "controller")).toBe(false);
  });

  it("flags every minority edge of an inverted pair (30:2 → both repository→service edges)", () => {
    const { graph, roles } = inversionFixture();
    const report = computeDependencyNorms({ graph, fileRoles: roles });

    const inverted = report.findings.filter((f) => f.roleSrc === "repository");
    expect(inverted.map((f) => f.sourceRelPath)).toEqual(["repository/repository0.ts", "repository/repository1.ts"]);
    expect(inverted.every((f) => f.pairSupport === 2 && f.establishedDirection.support === 30)).toBe(true);
  });

  it("never flags a mutual pair (62:61), a one-way pair (772:0), a tiny pair (3:0, 2:1) or a same-role pair", () => {
    const { graph, roles } = inversionFixture();
    const report = computeDependencyNorms({ graph, fileRoles: roles });

    const flaggedRoles = new Set(report.findings.flatMap((f) => [f.roleSrc, f.roleDst]));
    for (const role of ["model", "record", "worker", "job", "presenter", "view", "helper", "form"]) {
      expect(flaggedRoles.has(role)).toBe(false);
    }
    expect(report.findings.some((f) => f.roleSrc === f.roleDst)).toBe(false);
    expect(report.findings).toHaveLength(3);
    expect(report.findings.every((f) => f.kind === "misfit")).toBe(true);
  });

  it("pools localities: an inversion split across directories is still one pair", () => {
    // 12 controller→service edges same-domain and 12 cross-domain, the lone
    // service→controller edge same-domain: the ledger keeps the localities
    // apart, the direction test reads the pair once, over all 25 edges.
    const { graph, roles } = graphFromPairs(
      [
        ["controller", "service", 24],
        ["service", "controller", 1],
      ],
      0,
    );
    const componentOf = new Map<string, string>();
    for (let i = 0; i < 12; i++) {
      componentOf.set(roleFile("controller", i), "app");
      componentOf.set(roleFile("service", i), "app");
    }

    const report = computeDependencyNorms({ graph, fileRoles: roles, componentOf });
    const ledger = buildNormLedgers({ graph, fileRoles: roles, componentOf }).forLanguage("typescript");

    expect(ledger.pairs.get("controller\u0000service\u0000sameDomain")).toBe(12);
    expect(ledger.pairs.get("controller\u0000service\u0000crossDomain")).toBe(12);
    expect(report.findings).toEqual([
      expect.objectContaining({
        sourceRelPath: "service/service0.ts",
        locality: "sameDomain",
        pairSupport: 1,
        establishedDirection: { roleSrc: "controller", roleDst: "service", support: 24 },
      }),
    ]);
  });

  it("judges locality: same-directory, then same-domain, else cross-domain", () => {
    const { roles: baseRoles } = inversionFixture();
    const edges = [
      { sourceRelPath: "logic/tasks.ts", targetRelPath: "logic/reports.ts", callWeight: 3 },
      { sourceRelPath: "logic/billing.ts", targetRelPath: "logic/inner/notes.ts", callWeight: 3 },
    ];
    const files = ["logic/tasks.ts", "logic/reports.ts", "logic/billing.ts", "logic/inner/notes.ts"].map((relPath) => ({
      relPath,
      language: "typescript",
      symbolCount: 1,
    }));
    const roles = new Map(baseRoles);
    for (const f of files) roles.set(f.relPath, { role: "service", strong: true });
    const componentOf = new Map(files.map((f) => [f.relPath, "logic"]));

    const ledger = buildNormLedgers({ graph: { files, edges }, fileRoles: roles, componentOf }).forLanguage(
      "typescript",
    );

    expect(ledger.pairs.get("service\u0000service\u0000sameDirectory")).toBe(1);
    expect(ledger.pairs.get("service\u0000service\u0000sameDomain")).toBe(1);
    expect(ledger.pairs.has("service\u0000service\u0000crossDomain")).toBe(false);
  });

  it("never judges an edge touching an untyped or weak-role file, and counts both", () => {
    const { graph, roles } = inversionFixture();
    const files = [...graph.files, { relPath: "x/unknown.ts", language: "typescript", symbolCount: 1 }];
    files.push({ relPath: "controller/loose.ts", language: "typescript", symbolCount: 1 });
    roles.set("controller/loose.ts", { role: "helper", strong: false });
    const edges = [
      ...graph.edges,
      { sourceRelPath: "x/unknown.ts", targetRelPath: "controller/controller0.ts", callWeight: 5 },
      { sourceRelPath: "controller/loose.ts", targetRelPath: "controller/controller1.ts", callWeight: 5 },
    ];

    const report = computeDependencyNorms({ graph: { files, edges }, fileRoles: roles });

    expect(report.summary.untypedFileCount).toBe(1);
    expect(report.summary.weakRoleFileCount).toBe(1);
    expect(report.summary.typedEdgeCount).toBe(FIXTURE_EDGE_COUNT);
    expect(report.summary.judgedEdgeCount).toBe(FIXTURE_EDGE_COUNT);
    expect(report.findings.map((f) => f.sourceRelPath)).not.toContain("x/unknown.ts");
    expect(report.findings.map((f) => f.sourceRelPath)).not.toContain("controller/loose.ts");
  });
});

/**
 * bd tea-rags-mcp-23iii: the WRITE-TIME verdict — "I am about to add this
 * edge; does the project do that?" — reads the same ledgers the report
 * findings came from, so one judgment rule serves both.
 */
describe("judgePlannedEdge", () => {
  const { graph, roles } = inversionFixture();
  const ledgers = buildNormLedgers({ graph, fileRoles: roles }).forLanguage("typescript");

  it("conforms an edge along the established direction", () => {
    const verdict = judgePlannedEdge(ledgers, { roleSrc: "controller", roleDst: "service", locality: "crossDomain" });
    expect(verdict).toMatchObject({ kind: "conforms", pairSupport: 24 });
    expect(verdict).not.toHaveProperty("establishedDirection");
  });

  it("calls an edge against the established direction a MISFIT and names the direction", () => {
    expect(
      judgePlannedEdge(ledgers, { roleSrc: "service", roleDst: "controller", locality: "sameDomain" }),
    ).toMatchObject({
      kind: "misfit",
      pairSupport: 1,
      pValue: signTestPValue(24, 1),
      establishedDirection: { roleSrc: "controller", roleDst: "service", support: 24 },
    });
  });

  it("calls a first edge against a one-way pair a MISFIT too — nobody wrote it, the direction is established", () => {
    expect(judgePlannedEdge(ledgers, { roleSrc: "job", roleDst: "worker", locality: "crossDomain" })).toMatchObject({
      kind: "misfit",
      pairSupport: 0,
      establishedDirection: { roleSrc: "worker", roleDst: "job", support: 772 },
    });
  });

  it("conforms either direction of a mutual pair", () => {
    expect(judgePlannedEdge(ledgers, { roleSrc: "record", roleDst: "model", locality: "crossDomain" }).kind).toBe(
      "conforms",
    );
  });

  it("answers a pair with no established pattern with insufficient support, not a fabricated verdict", () => {
    // No history at all, and a pair too small to establish a direction.
    expect(
      judgePlannedEdge(ledgers, { roleSrc: "presenter", roleDst: "controller", locality: "crossDomain" }),
    ).toMatchObject({ kind: "insufficientSupport", pairSupport: 0, pValue: 1 });
    expect(judgePlannedEdge(ledgers, { roleSrc: "view", roleDst: "presenter", locality: "crossDomain" })).toMatchObject(
      { kind: "insufficientSupport", pairSupport: 0 },
    );
  });
});

it("the report's findings and judgePlannedEdge agree on every finding (one judgment rule)", () => {
  const { graph, roles } = inversionFixture();
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
    expect(verdict.pValue).toBe(finding.pValue);
    expect(verdict.establishedDirection).toEqual(finding.establishedDirection);
  }
  expect(report.findings.length).toBeGreaterThan(0);
});

/**
 * bd tea-rags-mcp-mv8yv: `sourcePathPattern` scopes the FINDINGS by source
 * file, the way every other detector scopes - ledgers and the test stay
 * whole-graph, and the findings the scope drops are counted, not silently
 * lost.
 */
describe("computeDependencyNorms - sourcePathPattern", () => {
  it("keeps findings whose source matches and counts the rest as out of scope", () => {
    const { graph, roles } = inversionFixture();
    const report = computeDependencyNorms({ graph, fileRoles: roles, sourcePathPattern: "service/**" });

    expect(report.findings.map((f) => [f.kind, f.sourceRelPath])).toEqual([["misfit", "service/service0.ts"]]);
    expect(report.summary.outOfScopeFindingCount).toBe(2);
    expect(report.summary.violationCount).toBe(1);
  });

  it("leaves the summary untouched when the pattern names no scope", () => {
    const { graph, roles } = inversionFixture();
    const report = computeDependencyNorms({ graph, fileRoles: roles });

    expect(report.summary).not.toHaveProperty("outOfScopeFindingCount");
    expect(report.summary.violationCount).toBe(3);
  });

  it("admits all findings under a pattern every source matches", () => {
    const { graph, roles } = inversionFixture();
    const report = computeDependencyNorms({ graph, fileRoles: roles, sourcePathPattern: "**" });

    expect(report.findings).toHaveLength(3);
    expect(report.summary.outOfScopeFindingCount).toBe(0);
  });
});

/**
 * One ledger per language family (bd tea-rags-mcp-xb669.7). A role name is a
 * word of ONE language's vocabulary: a Ruby `form` persisting straight into a
 * repository says nothing about how a TypeScript `form` should reach one.
 *
 * Fixture: Ruby forms call Ruby repositories (24) and one repository calls a
 * form back; TypeScript runs the OPPOSITE convention — repositories call forms
 * (24) and one form calls a repository. Pooled, the pair is an even 25:25 and
 * nothing is inverted; per family each language has its own 24:1 inversion.
 * One TS form also reaches a Ruby repository — an edge between two
 * vocabularies.
 */
describe("dependency norms are judged per language family", () => {
  function polyglotFixture(): { graph: FileDependencyGraph; roles: Map<string, DependencyNormFileRole> } {
    const files: FileDependencyGraph["files"] = [];
    const roles = new Map<string, DependencyNormFileRole>();
    const edges: FileDependencyGraph["edges"] = [];
    const fileOf = (dir: string, role: string, index: number, ext: string) => {
      const relPath = `${dir}/${role}${index}.${ext}`;
      if (!roles.has(relPath)) {
        roles.set(relPath, { role, strong: true });
        const language = ext === "rb" ? "ruby" : ext === "js" ? "javascript" : "typescript";
        files.push({ relPath, language, symbolCount: 1 });
      }
      return relPath;
    };
    const add = (sourceRelPath: string, targetRelPath: string) => {
      edges.push({ sourceRelPath, targetRelPath, callWeight: 1 });
    };
    for (let i = 0; i < 24; i++) add(fileOf("app/forms", "form", i, "rb"), fileOf("app/repos", "repository", i, "rb"));
    add(fileOf("app/repos", "repository", 0, "rb"), fileOf("app/forms", "form", 1, "rb"));
    // TypeScript (one repository in JavaScript — ecmascript is one family).
    for (let i = 0; i < 24; i++) {
      add(fileOf("web/repos", "repository", i, i === 0 ? "js" : "ts"), fileOf("web/forms", "form", i, "tsx"));
    }
    add(fileOf("web/forms", "form", 0, "tsx"), fileOf("web/repos", "repository", 1, "ts"));
    add(fileOf("web/forms", "form", 2, "tsx"), fileOf("app/repos", "repository", 2, "rb")); // cross-language
    return { graph: { files, edges }, roles };
  }

  it("judges each family against its own direction, not the pooled even split", () => {
    const { graph, roles } = polyglotFixture();
    const report = computeDependencyNorms({ graph, fileRoles: roles });

    expect(report.findings.map((f) => [f.family, f.sourceRelPath, f.targetRelPath])).toEqual([
      ["ruby", "app/repos/repository0.rb", "app/forms/form1.rb"],
      ["ecmascript", "web/forms/form0.tsx", "web/repos/repository1.ts"],
    ]);
    expect(report.findings.map((f) => f.establishedDirection)).toEqual([
      { roleSrc: "form", roleDst: "repository", support: 24 },
      { roleSrc: "repository", roleDst: "form", support: 24 },
    ]);
  });

  it("leaves a cross-language edge unjudged and out of every ledger, counted with its reason", () => {
    const { graph, roles } = polyglotFixture();
    const report = computeDependencyNorms({ graph, fileRoles: roles });

    expect(report.summary).toMatchObject({
      typedEdgeCount: 51,
      judgedEdgeCount: 50,
      excluded: { crossLanguageEdgeCount: 1 },
    });
    expect(report.ledgers.map((l) => [l.family, l.pairCount, l.significance.familySize])).toEqual([
      ["ecmascript", 2, 1],
      ["ruby", 2, 1],
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
    const { graph, roles } = inversionFixture();
    // A second controller-bound edge from a service would deepen the
    // inversion — but it only names a constant nested in the controller.
    graph.edges.push({
      sourceRelPath: "service/service1.ts",
      targetRelPath: "controller/controller1.ts",
      callWeight: 0.5,
      importText: "zeitwerk:Controller1::RateLimitError",
    });
    // A reference to the primary itself stays a role edge (it calls in — a
    // call-less edge is excluded on its own account, see below).
    graph.edges.push({
      sourceRelPath: "service/service2.ts",
      targetRelPath: "controller/controller2.ts",
      callWeight: 1,
      importText: "zeitwerk:Controller2",
    });
    const filePrimaryTypes = new Map([
      ["controller/controller1.ts", "Controller1"],
      ["controller/controller2.ts", "Controller2"],
    ]);

    const report = computeDependencyNorms({ graph, fileRoles: roles, filePrimaryTypes });

    expect(report.summary.excluded.constantReferenceEdgeCount).toBe(1);
    expect(report.findings.some((f) => f.sourceRelPath === "service/service1.ts")).toBe(false);
    expect(report.summary.judgedEdgeCount).toBe(report.summary.typedEdgeCount - 1);
    const ledger = buildNormLedgers({ graph, fileRoles: roles, filePrimaryTypes }).forLanguage("typescript");
    expect(ledger.pairs.get("service\u0000controller\u0000crossDomain")).toBe(2);
  });

  it("keeps a nested-constant edge that carries a definite resolved call", () => {
    const { graph, roles } = inversionFixture();
    graph.edges.push({
      sourceRelPath: "service/service1.ts",
      targetRelPath: "controller/controller1.ts",
      callWeight: 1,
      importText: "zeitwerk:Controller1::RateLimitError",
    });
    const report = computeDependencyNorms({
      graph,
      fileRoles: roles,
      filePrimaryTypes: new Map([["controller/controller1.ts", "Controller1"]]),
    });

    expect(report.summary.excluded.constantReferenceEdgeCount).toBe(0);
  });
});

/**
 * An edge with no resolved call is no layering dependency (bd
 * tea-rags-mcp-4vj2u, xb669.8 gold set): measured on taxdome, every call-less
 * MISFIT was a constant-only mention — a `.new` factory dispatch, an STI
 * subtype registry, an initializer's config, an enqueue the resolver left
 * unpinned — 13 FALSE, 0 TRUE. Such an edge names the target, it never runs
 * the target's logic, so it carries no verdict. It stays PRECEDENT: dropping
 * call-less edges from the ledgers (55% of taxdome's typed edges) erased the
 * helper → record direction — helpers read records through the framework's
 * finders, which resolve to no in-project call — and with it four TRUE
 * record → helper findings.
 */
describe("computeDependencyNorms - an edge with no resolved call is no role edge", () => {
  it("never judges a call-less edge, counts it with its reason, and keeps it as ledger precedent", () => {
    const { graph, roles } = inversionFixture();
    // A second service→controller edge would be another inversion — but it calls nothing.
    graph.edges.push({
      sourceRelPath: "service/service1.ts",
      targetRelPath: "controller/controller1.ts",
      callWeight: 0,
    });

    const report = computeDependencyNorms({ graph, fileRoles: roles });

    expect(report.summary.excluded.uncalledEdgeCount).toBe(1);
    expect(report.summary.typedEdgeCount).toBe(FIXTURE_EDGE_COUNT + 1);
    expect(report.summary.judgedEdgeCount).toBe(FIXTURE_EDGE_COUNT);
    expect(report.findings.some((f) => f.sourceRelPath === "service/service1.ts")).toBe(false);
    const ledger = buildNormLedgers({ graph, fileRoles: roles }).forLanguage("typescript");
    expect(ledger.pairs.get("service\u0000controller\u0000crossDomain")).toBe(2);
  });

  it("keeps an edge carrying any resolved call, however small its dispatch share", () => {
    const { graph, roles } = inversionFixture();
    graph.edges.push({
      sourceRelPath: "service/service1.ts",
      targetRelPath: "controller/controller1.ts",
      callWeight: 0.25,
    });

    const report = computeDependencyNorms({ graph, fileRoles: roles });

    expect(report.summary.excluded.uncalledEdgeCount).toBe(0);
    expect(report.findings.some((f) => f.sourceRelPath === "service/service1.ts")).toBe(true);
  });
});

/**
 * An edge whose every call went through a framework's interface is no
 * layering dependency either (bd tea-rags-mcp-4vj2u, xb669.8 gold set): a
 * billing handler, a Rack middleware, a mailer each `Worker.perform_async(…)`
 * — the resolver routes the enqueue to `Worker#perform`, but the source knows
 * the worker's framework contract, not its logic. Like a call-less edge it
 * stays precedent and carries no verdict.
 */
describe("computeDependencyNorms - a framework-routed edge is no role edge", () => {
  it("never judges an edge whose every call is framework-routed, counts it, keeps it as precedent", () => {
    const { graph, roles } = inversionFixture();
    graph.edges.push({
      sourceRelPath: "service/service1.ts",
      targetRelPath: "controller/controller1.ts",
      callWeight: 1.5,
      frameworkRoutedCallWeight: 1.5,
    });

    const report = computeDependencyNorms({ graph, fileRoles: roles });

    expect(report.summary.excluded.frameworkRoutedEdgeCount).toBe(1);
    expect(report.summary.judgedEdgeCount).toBe(FIXTURE_EDGE_COUNT);
    expect(report.findings.some((f) => f.sourceRelPath === "service/service1.ts")).toBe(false);
    const ledger = buildNormLedgers({ graph, fileRoles: roles }).forLanguage("typescript");
    expect(ledger.pairs.get("service\u0000controller\u0000crossDomain")).toBe(2);
  });

  it("judges an edge with at least one call naming the target's own member", () => {
    const { graph, roles } = inversionFixture();
    graph.edges.push({
      sourceRelPath: "service/service1.ts",
      targetRelPath: "controller/controller1.ts",
      callWeight: 2,
      frameworkRoutedCallWeight: 1,
    });

    const report = computeDependencyNorms({ graph, fileRoles: roles });

    expect(report.summary.excluded.frameworkRoutedEdgeCount).toBe(0);
    expect(report.findings.some((f) => f.sourceRelPath === "service/service1.ts")).toBe(true);
  });
});

/**
 * A displaced role is precedent, never a verdict (bd tea-rags-mcp-4vj2u): the
 * role layer reads `helper` off a `class << self` utility or an `app/lib`
 * calculator, so an edge touching one says nothing about the helper layer —
 * yet dropping those files from the ledgers erased the helper → record
 * direction the real view helpers hold, measured on taxdome.
 */
describe("computeDependencyNorms - an edge touching a displaced role is never judged", () => {
  it("counts the edge, lists no finding, and keeps it in the ledger", () => {
    const { graph, roles } = inversionFixture();
    // A controller read off its name alone, outside the controllers' home.
    roles.set("lib/legacy_controller.ts", { role: "controller", strong: true, displaced: "outsideRoleHome" });
    graph.files.push({ relPath: "lib/legacy_controller.ts", language: "typescript", symbolCount: 1 });
    graph.edges.push({
      sourceRelPath: "service/service1.ts",
      targetRelPath: "lib/legacy_controller.ts",
      callWeight: 1,
    });

    const report = computeDependencyNorms({ graph, fileRoles: roles });

    expect(report.summary.excluded.displacedRoleEdgeCount).toBe(1);
    expect(report.summary.judgedEdgeCount).toBe(FIXTURE_EDGE_COUNT);
    expect(report.findings.some((f) => f.targetRelPath === "lib/legacy_controller.ts")).toBe(false);
    const ledger = buildNormLedgers({ graph, fileRoles: roles }).forLanguage("typescript");
    expect(ledger.pairs.get("service\u0000controller\u0000crossDomain")).toBe(2);
  });

  it("names an edge's own exclusion first: a call-less edge into a displaced role counts as uncalled", () => {
    const { graph, roles } = inversionFixture();
    roles.set("service/functions.ts", { role: "service", strong: true, displaced: "callShape" });
    graph.files.push({ relPath: "service/functions.ts", language: "typescript", symbolCount: 1 });
    graph.edges.push({
      sourceRelPath: "service/functions.ts",
      targetRelPath: "controller/controller1.ts",
      callWeight: 0,
    });

    const report = computeDependencyNorms({ graph, fileRoles: roles });

    expect(report.summary.excluded).toMatchObject({ uncalledEdgeCount: 1, displacedRoleEdgeCount: 0 });
  });
});

/**
 * The write-time verdict over FILE endpoints (bd tea-rags-mcp-xb669.2): the
 * edge a writer is about to add, judged against the INDEXED graph's ledgers.
 * Roles, family and the reference-level exclusions are read off the files the
 * graph already holds; the call-level exclusions need call data a planned edge
 * does not have yet, so they are named as unchecked instead of assumed away.
 */
describe("judgePlannedFileEdges", () => {
  const CALL_EVIDENCE_UNCHECKED = ["uncalled", "frameworkRouted"];

  it("conforms a planned edge along the established direction, naming roles, family and locality", () => {
    const { graph, roles } = inversionFixture();

    const [judgement] = judgePlannedFileEdges({ graph, fileRoles: roles }, [
      { sourceRelPath: "controller/controller3.ts", targetRelPath: "service/service7.ts" },
    ]);

    expect(judgement).toMatchObject({
      roleSrc: "controller",
      roleDst: "service",
      family: "ecmascript",
      locality: "crossDomain",
      verdict: { kind: "conforms", pairSupport: 24 },
      reverseSupport: 1,
      exclusionsUnchecked: ["constantReference", ...CALL_EVIDENCE_UNCHECKED],
    });
    expect(judgement.unjudgedReason).toBeUndefined();
  });

  it("calls a planned edge against the established direction a MISFIT and names the direction", () => {
    const { graph, roles } = inversionFixture();

    const [judgement] = judgePlannedFileEdges({ graph, fileRoles: roles }, [
      { sourceRelPath: "repository/repository9.ts", targetRelPath: "service/service9.ts" },
    ]);

    expect(judgement.verdict).toMatchObject({
      kind: "misfit",
      pairSupport: 2,
      pValue: signTestPValue(30, 2),
      establishedDirection: { roleSrc: "service", roleDst: "repository", support: 30 },
    });
    expect(judgement.transit).toBeUndefined();
  });

  it("answers a pair nobody wrote with insufficient support and the established transit through a third role", () => {
    const { graph, roles } = inversionFixture();

    const [judgement] = judgePlannedFileEdges({ graph, fileRoles: roles }, [
      { sourceRelPath: "controller/controller0.ts", targetRelPath: "repository/repository0.ts" },
    ]);

    expect(judgement.verdict).toMatchObject({ kind: "insufficientSupport", pairSupport: 0 });
    expect(judgement.transit).toEqual({ viaRole: "service", supportIn: 24, supportOut: 30 });
  });

  it("never judges an endpoint with a weak role or no role, and says which", () => {
    const { graph, roles } = inversionFixture();
    roles.set("service/service1.ts", { role: "service", strong: false });
    roles.delete("controller/controller1.ts");

    const [weak, untyped] = judgePlannedFileEdges({ graph, fileRoles: roles }, [
      { sourceRelPath: "service/service1.ts", targetRelPath: "repository/repository1.ts" },
      { sourceRelPath: "controller/controller1.ts", targetRelPath: "service/service2.ts" },
    ]);

    expect(weak).toMatchObject({ unjudgedReason: "weakRole", roleSrc: "service", roleDst: "repository" });
    expect(weak.verdict).toBeUndefined();
    expect(untyped).toMatchObject({ unjudgedReason: "untypedFile", roleDst: "service" });
    expect(untyped.verdict).toBeUndefined();
  });

  it("never judges a planned edge across language families", () => {
    const { graph, roles } = inversionFixture();
    graph.files.push({ relPath: "app/services/billing_service.rb", language: "ruby", symbolCount: 1 });
    roles.set("app/services/billing_service.rb", { role: "service", strong: true });

    const [judgement] = judgePlannedFileEdges({ graph, fileRoles: roles }, [
      { sourceRelPath: "controller/controller1.ts", targetRelPath: "app/services/billing_service.rb" },
    ]);

    expect(judgement).toMatchObject({ unjudgedReason: "crossLanguage", roleSrc: "controller", roleDst: "service" });
    expect(judgement.verdict).toBeUndefined();
  });

  it("never judges an endpoint the indexed graph does not hold: a new file, or one the production read excluded", () => {
    const { graph, roles } = inversionFixture();

    const [fresh, excluded] = judgePlannedFileEdges(
      { graph, fileRoles: roles },
      [
        { sourceRelPath: "controller/brand_new.ts", targetRelPath: "service/service1.ts" },
        { sourceRelPath: "tests/service.test.ts", targetRelPath: "service/service1.ts" },
      ],
      { isNonProduction: (relPath) => relPath.startsWith("tests/") },
    );

    expect(fresh.unjudgedReason).toBe("newFile");
    expect(excluded.unjudgedReason).toBe("nonProduction");
  });

  it("applies the report's constant-reference exclusion to a planned reference, and checks it off the unchecked list", () => {
    const { graph, roles } = inversionFixture();
    const filePrimaryTypes = new Map([["controller/controller1.ts", "Controller1"]]);

    const [nested, primary] = judgePlannedFileEdges({ graph, fileRoles: roles, filePrimaryTypes }, [
      {
        sourceRelPath: "service/service1.ts",
        targetRelPath: "controller/controller1.ts",
        reference: "Controller1::RateLimitError",
      },
      { sourceRelPath: "service/service1.ts", targetRelPath: "controller/controller1.ts", reference: "Controller1" },
    ]);

    expect(nested).toMatchObject({ unjudgedReason: "constantReference" });
    expect(nested.verdict).toBeUndefined();
    expect(primary.verdict?.kind).toBe("misfit");
    expect(primary.exclusionsUnchecked).toEqual(CALL_EVIDENCE_UNCHECKED);
  });

  it("never judges a planned edge touching a displaced role", () => {
    const { graph, roles } = inversionFixture();
    roles.set("lib/legacy_controller.ts", { role: "controller", strong: true, displaced: "outsideRoleHome" });
    graph.files.push({ relPath: "lib/legacy_controller.ts", language: "typescript", symbolCount: 1 });

    const [judgement] = judgePlannedFileEdges({ graph, fileRoles: roles }, [
      { sourceRelPath: "service/service1.ts", targetRelPath: "lib/legacy_controller.ts" },
    ]);

    expect(judgement).toMatchObject({ unjudgedReason: "displacedRole" });
    expect(judgement.verdict).toBeUndefined();
  });
});
