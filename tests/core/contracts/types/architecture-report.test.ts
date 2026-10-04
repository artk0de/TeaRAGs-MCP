/**
 * The boundary-diagnostics finding contract (bd tea-rags-mcp-0e4vf) — one home
 * for the finding vocabulary the public DTO and the domain detectors both
 * speak, so a new detector shape is added once instead of hand-synced across
 * `contracts`, `api/public/dto/architecture.ts` and the domain type files.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type {
  ArchitectureDirectoryRelation,
  ArchitectureFileEdge,
  FacadeLeakKind,
  MainSequenceComponentVolatilityEvidence,
} from "../../../../src/core/contracts/types/architecture-report.js";
import type { DependencyDirectoryRelation } from "../../../../src/core/domains/trajectory/codegraph/symbols/boundary-diagnostics/index.js";

const readSource = (relative: string): string => readFileSync(new URL(relative, import.meta.url), "utf8");

const CONTRACT_MODULE = "../../../../src/core/contracts/types/architecture-report.ts";
const DOMAIN_TYPES = "../../../../src/core/domains/trajectory/codegraph/symbols/boundary-diagnostics/types.ts";
const TEMPORAL_TYPES = "../../../../src/core/domains/trajectory/codegraph/temporal/boundary-diagnostics/types.ts";
const DTO = "../../../../src/core/api/public/dto/architecture.ts";
const MCP_TOOL = "../../../../src/mcp/tools/codegraph.ts";

describe("architecture-report contract (bd tea-rags-mcp-0e4vf)", () => {
  it("imports nothing outside contracts — the finding contract stays pure", () => {
    const source = readSource(CONTRACT_MODULE);
    const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier.startsWith("./")).toBe(true);
    }
  });

  it("sources the shared vocabulary from the contract, not its own copies (symbols boundary-diagnostics)", () => {
    const source = readSource(DOMAIN_TYPES);
    expect(source).toContain("contracts/types/architecture-report.js");

    // Local DEFINITIONS of the shared vocabulary are gone…
    const localDefinitions = [
      "export type FacadeLeakKind =",
      "export type ConventionPrivacyRule =",
      "export type FacadeModuleExclusionReason =",
      "export type MainSequenceZone =",
      "export type LayeringViolationKind =",
      "export interface LayeringKeepCost",
      "export interface LayeringFeedbackEdge",
    ];
    for (const probe of localDefinitions) {
      expect(source).not.toContain(probe);
    }

    // …the domain names survive as aliases of the contract types.
    expect(source).toContain("export type DependencyDirectoryRelation = ArchitectureDirectoryRelation;");
    expect(source).toContain("export type ComponentDependencyFileEdge = ArchitectureFileEdge;");
    expect(source).toContain("export type MainSequenceComponentVolatility = MainSequenceComponentVolatilityEvidence;");
  });

  it("sources the shared vocabulary from the contract (temporal boundary-diagnostics)", () => {
    const source = readSource(TEMPORAL_TYPES);
    expect(source).toContain("contracts/types/architecture-report.js");
    expect(source).not.toContain('export type SilentCouplingStructuralVisibility = "');
    expect(source).not.toContain("export interface SilentCouplingBuildSummary");
  });

  it("re-exports the report surface from the contract instead of redefining it (public DTO)", () => {
    const source = readSource(DTO);
    expect(source).toContain("contracts/types/architecture-report.js");
    expect(source).not.toContain("export interface StableDependencyViolationEvidence");
    expect(source).not.toContain("export interface GetArchitectureReportResponse");
    expect(source).not.toContain('export type FacadeLeakKind = "bypass"');
  });

  it("reaches the report through api/public only (MCP tool surface)", () => {
    const source = readSource(MCP_TOOL);
    expect(source).toContain('from "../../core/api/public/index.js"');
    expect(source).not.toMatch(/from\s+"[^"]*domains\//);
    expect(source).not.toMatch(/from\s+"[^"]*contracts\//);
  });

  it("keeps the domain vocabulary and the contract one and the same type", () => {
    const relation: DependencyDirectoryRelation = "descendant";
    const contractRelation: ArchitectureDirectoryRelation = relation;
    const evidence: MainSequenceComponentVolatilityEvidence = {
      value: 3.5,
      measuredFileCount: 4,
      threshold: 2.0,
      label: "volatile",
    };
    const edge: ArchitectureFileEdge = {
      sourceRelPath: "src/a.ts",
      targetRelPath: "src/b.ts",
      callWeight: 2,
    };
    const leakKind: FacadeLeakKind = "bypass";

    expect(contractRelation).toBe("descendant");
    expect(evidence.label).toBe("volatile");
    expect(edge.callWeight).toBe(2);
    expect(leakKind).toBe("bypass");
  });
});
