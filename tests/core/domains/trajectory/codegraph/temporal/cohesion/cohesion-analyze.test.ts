/**
 * `analyzeFileCohesion` — the A3 read-side core (bd tea-rags-mcp-tzy8r): one
 * file's stored symbol-commit rows → fenced → pair statistics → clusters →
 * cohesion score + split verdict with evidence attached.
 *
 * Invariants under test:
 *   - two disjoint co-change groups inside one file ARE the split candidate,
 *     with clusters and top pairs as evidence, never an opinion;
 *   - a file whose symbols all change together stays one cluster;
 *   - a low-confidence pair does not bridge two clusters (support alone is
 *     not admission — a hub symbol touched by everything would otherwise
 *     weld the graph together);
 *   - fewer than two fenced symbols is NO analysis (absence, not zero);
 *   - the fence runs inside the analysis and is reported as evidence.
 */

import { describe, expect, it } from "vitest";

import type { TemporalSymbolCommitFileSnapshot } from "../../../../../../../src/core/contracts/types/codegraph.js";
import { analyzeFileCohesion } from "../../../../../../../src/core/domains/trajectory/codegraph/temporal/cohesion/analyze.js";

const rows = (relPath: string, symbols: [string, string[]][]): TemporalSymbolCommitFileSnapshot => ({
  relPath,
  symbols: symbols.map(([symbolId, commitShas]) => ({ symbolId, commitShas })),
});

describe("analyzeFileCohesion", () => {
  it("names a split candidate from two disjoint co-change groups, with evidence", () => {
    // parser group co-changes on c1/c2, renderer group on c5/c6; c3 crosses
    // the groups once — below minSupport, so no bridge.
    const report = analyzeFileCohesion(
      rows("src/thing.ts", [
        ["Parser#run", ["c1", "c2", "c3"]],
        ["Parser#lex", ["c1", "c2", "c4"]],
        ["Renderer#dom", ["c5", "c6", "c3"]],
        ["Renderer#css", ["c5", "c6", "c7"]],
      ]),
    );

    expect(report).not.toBeNull();
    expect(report?.splitCandidate).toBe(true);
    expect(report?.clusters).toHaveLength(2);
    expect(report?.clusters.map((c) => [...c.symbols].sort())).toEqual(
      expect.arrayContaining([
        ["Parser#lex", "Parser#run"],
        ["Renderer#css", "Renderer#dom"],
      ]),
    );
    expect(report?.cohesion).toBeCloseTo(0.5);
    expect(report?.unclusteredSymbols).toEqual([]);
    // Every cluster carries its strongest pairs as evidence.
    const parser = report?.clusters.find((c) => c.symbols.includes("Parser#run"));
    expect(parser?.topPairs).toEqual([
      { a: "Parser#lex", b: "Parser#run", support: 2, confidence: expect.closeTo(2 / 3) },
    ]);
    expect(report?.analyzedSymbols).toBe(4);
  });

  it("keeps a file whose symbols change together one cohesive cluster", () => {
    const report = analyzeFileCohesion(
      rows("src/tight.ts", [
        ["T#a", ["c1", "c2", "c3"]],
        ["T#b", ["c1", "c2", "c4"]],
        ["T#c", ["c1", "c2", "c5"]],
      ]),
    );

    expect(report?.clusters).toHaveLength(1);
    expect(report?.cohesion).toBe(1);
    expect(report?.splitCandidate).toBe(false);
    expect(report?.unclusteredSymbols).toEqual([]);
  });

  it("does not let a low-confidence pair bridge two clusters", () => {
    // Hub#many changed ten times; x1/x2 are the only commits it shares with
    // Left#one. Support clears minSupport, but P(Left | hub) = 0.2 is noise —
    // the confidence gate refuses the pair and nothing clusters. (The sides
    // share nothing with each other, so there is no second pair to admit.)
    const hubShas = ["h1", "h2", "h3", "h4", "h5", "h6", "h7", "h8", "x1", "x2"];
    const report = analyzeFileCohesion(
      rows("src/hub.ts", [
        ["Hub#many", hubShas],
        ["Left#one", ["x1", "x2", "l1"]],
        ["Right#one", ["y1", "y2", "r1"]],
      ]),
    );

    expect(report?.pairCount).toBe(0);
    expect(report?.clusters).toEqual([]);
    expect(report?.cohesion).toBe(1);
    expect(report?.splitCandidate).toBe(false);
    expect(report?.unclusteredSymbols.sort()).toEqual(["Hub#many", "Left#one", "Right#one"]);
  });

  it("returns no analysis for a file with fewer than two fenced symbols", () => {
    expect(analyzeFileCohesion(rows("src/empty.ts", []))).toBeNull();
    expect(analyzeFileCohesion(rows("src/single.ts", [["S#one", ["c1", "c2"]]]))).toBeNull();
  });

  it("reports the fence as evidence — a formatter sweep changes no verdict", () => {
    // The sweep commit touches all four symbols; without the fence it would
    // weld the two groups into one cluster and hide the split. The groups'
    // own commits pair two symbols each.
    const report = analyzeFileCohesion(
      rows("src/swept.ts", [
        ["P#one", ["c1", "c2", "FMT"]],
        ["P#two", ["c1", "c2", "FMT"]],
        ["R#one", ["c5", "c6", "c7", "FMT"]],
        ["R#two", ["c5", "c6", "c7", "FMT"]],
      ]),
    );

    expect(report?.massCommitsDropped).toBe(1);
    expect(report?.splitCandidate).toBe(true);
    expect(report?.clusters).toHaveLength(2);
  });

  it("reports the window the rows were walked over — a stated limit, not an opinion", () => {
    const report = analyzeFileCohesion(
      rows("src/w.ts", [
        ["W#a", ["c1", "c2"]],
        ["W#b", ["c1", "c2"]],
      ]),
      {
        windowMonths: 6,
      },
    );

    expect(report?.windowMonths).toBe(6);
  });
});
