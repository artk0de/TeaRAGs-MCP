/**
 * The diff-scoped finding contract (bd tea-rags-mcp-r8hme.44, H3 T3) — the
 * review_changes architecture findings keyed by STRUCTURED endpoints that
 * mirror the `ArchitectureViolation` endpoint shapes, so a fingerprint over
 * "detector + endpoints" (89k7k.1.7) never parses prose. The reviewer-facing
 * `subject` is rendered from those endpoints, never authored beside them.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  diffFindingEndpointRefs,
  renderDiffFindingSubject,
  silentCouplingGroupSubject,
  type DiffFindingEndpoints,
} from "../../../../src/core/contracts/types/diff-detector-finding.js";

const readSource = (relative: string): string => readFileSync(new URL(relative, import.meta.url), "utf8");

const CONTRACT_MODULE = "../../../../src/core/contracts/types/diff-detector-finding.ts";
const REVIEW_DTO = "../../../../src/core/api/public/dto/review.ts";
const DIFF_RUN = "../../../../src/core/api/internal/ops/diff-detector-run.ts";

describe("diff-detector-finding contract (bd tea-rags-mcp-r8hme.44)", () => {
  it("imports nothing outside contracts — the finding contract stays pure", () => {
    const specifiers = [...readSource(CONTRACT_MODULE).matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) expect(specifier.startsWith("./")).toBe(true);
  });

  it("is where the public review DTO reads the finding types — never internal ops (SDP api/public/dto -> api)", () => {
    const source = readSource(REVIEW_DTO);
    expect(source).toContain("contracts/types/diff-detector-finding.js");
    expect(source).not.toMatch(/from\s+"[^"]*internal\/ops\//);
  });

  it("is the one definition: the diff run no longer declares the finding or status shape", () => {
    const source = readSource(DIFF_RUN);
    expect(source).not.toContain("export interface DiffDetectorFinding ");
    expect(source).not.toContain("export interface DiffDetectorStatus ");
  });

  describe("renderDiffFindingSubject", () => {
    const cases: [DiffFindingEndpoints, string][] = [
      [{ kind: "fileEdge", sourceRelPath: "src/a.ts", targetRelPath: "src/b.ts" }, "src/a.ts -> src/b.ts"],
      [
        {
          kind: "componentEdge",
          sourceComponent: "src/app",
          targetComponent: "src/lib",
          sourceRelPath: "src/app/a.ts",
          targetRelPath: "src/lib/b.ts",
        },
        "src/app/a.ts -> src/lib/b.ts",
      ],
      [{ kind: "filePair", sourceRelPath: "src/a.ts", targetRelPath: "src/z.ts" }, "src/a.ts ~ src/z.ts"],
      [
        { kind: "fileGroup", relPath: "src/hub.ts", partnerCount: 4 },
        "src/hub.ts co-changes significantly with 4 files without a structural edge",
      ],
      [{ kind: "file", relPath: "src/lib/index.ts", component: "src/lib" }, "src/lib/index.ts"],
      [{ kind: "component", component: "src/app" }, "src/app"],
      [{ kind: "componentPair", componentA: "alpha", componentB: "beta" }, "alpha ~ beta"],
    ];
    it.each(cases)("renders %j as the reviewer-facing subject", (endpoints, subject) => {
      expect(renderDiffFindingSubject(endpoints)).toBe(subject);
    });

    it("renders a group subject with the same wording the whole-repo report's group violation uses", () => {
      expect(renderDiffFindingSubject({ kind: "fileGroup", relPath: "x.ts", partnerCount: 2 })).toBe(
        silentCouplingGroupSubject("x.ts", 2),
      );
    });
  });

  describe("diffFindingEndpointRefs", () => {
    it("names a component-judged file edge by its FILES — the edge the diff added carries the cost", () => {
      expect(
        diffFindingEndpointRefs({
          kind: "componentEdge",
          sourceComponent: "src/app",
          targetComponent: "src/lib",
          sourceRelPath: "src/app/a.ts",
          targetRelPath: "src/lib/b.ts",
        }),
      ).toEqual({ files: ["src/app/a.ts", "src/lib/b.ts"], components: [] });
    });

    it("names component endpoints as components, never as paths to guess from", () => {
      expect(diffFindingEndpointRefs({ kind: "component", component: "src/app" })).toEqual({
        files: [],
        components: ["src/app"],
      });
      expect(diffFindingEndpointRefs({ kind: "componentPair", componentA: "a", componentB: "b" })).toEqual({
        files: [],
        components: ["a", "b"],
      });
    });

    it("names file endpoints as files", () => {
      expect(diffFindingEndpointRefs({ kind: "filePair", sourceRelPath: "a.ts", targetRelPath: "b.ts" })).toEqual({
        files: ["a.ts", "b.ts"],
        components: [],
      });
      expect(diffFindingEndpointRefs({ kind: "fileGroup", relPath: "hub.ts", partnerCount: 3 })).toEqual({
        files: ["hub.ts"],
        components: [],
      });
      expect(diffFindingEndpointRefs({ kind: "file", relPath: "lib/index.ts", component: "lib" })).toEqual({
        files: ["lib/index.ts"],
        components: [],
      });
    });
  });
});
