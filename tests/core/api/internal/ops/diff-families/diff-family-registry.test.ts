/**
 * Structure pin for the per-family split of `DiffDetectorRun`
 * (bd tea-rags-mcp-89k7k.1.19.10). Behaviour is `diff-detector-run.test.ts`'s;
 * this file pins only the SHAPE: one `DiffFamilyDetector` module per family,
 * a registry in the run's observable output order, no family logic left in
 * `diff-detector-run.ts`, and the directory reached through its facade only.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { DIFF_FAMILY_DETECTORS } from "../../../../../../src/core/api/internal/ops/diff-families/index.js";

const ROOT = join(import.meta.dirname, "../../../../../../");
const SRC_DIR = join(ROOT, "src");
const OPS_DIR = join(ROOT, "src/core/api/internal/ops");
const FAMILIES_DIR = join(OPS_DIR, "diff-families");
const DIFF_RUN = join(OPS_DIR, "diff-detector-run.ts");
/** The two modules the outside may name directly: the facade and the contract. */
const DIRECTLY_IMPORTABLE = new Set([join(FAMILIES_DIR, "index.ts"), join(FAMILIES_DIR, "diff-family-detector.ts")]);

function tsFilesUnder(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) tsFilesUnder(abs, acc);
    else if (entry.endsWith(".ts")) acc.push(abs);
  }
  return acc;
}

/** Resolved absolute targets of every relative module specifier in a file (static, re-export, dynamic, type). */
function relativeTargets(file: string): string[] {
  const text = readFileSync(file, "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const targets: string[] = [];
  const pattern = /(?:from\s*|import\s*\(\s*|import\s+)"(\.{1,2}\/[^"]+)"/g;
  for (const match of text.matchAll(pattern)) {
    targets.push(resolve(dirname(file), match[1]).replace(/\.js$/, ".ts"));
  }
  return targets;
}

const rel = (abs: string): string => relative(ROOT, abs);
const insideFamilies = (abs: string): boolean => abs.startsWith(`${FAMILIES_DIR}/`);

describe("DiffDetectorRun's per-family split", () => {
  it("registers the nine families in the run's output order", () => {
    expect(DIFF_FAMILY_DETECTORS.map((detector) => detector.family)).toEqual([
      "stableDependencies",
      "leakingAbstraction",
      "cycles",
      "mainSequence",
      "silentCoupling",
      "facadeContract",
      "splitCandidates",
      "layeringBackEdge",
      "hubLike",
    ]);
  });

  it("leaves no judge* method in diff-detector-run.ts", () => {
    expect(readFileSync(DIFF_RUN, "utf-8")).not.toMatch(/\bprivate\s+judge[A-Z]\w*\(/);
  });

  it("is reached from outside the directory through its facade or contract only", () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(SRC_DIR)) {
      if (insideFamilies(file)) continue;
      for (const target of relativeTargets(file)) {
        if (insideFamilies(target) && !DIRECTLY_IMPORTABLE.has(target)) {
          offenders.push(`${rel(file)} -> ${rel(target)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never imports a loose api/internal/ops file back (no api <-> diff-families cycle)", () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(FAMILIES_DIR)) {
      for (const target of relativeTargets(file)) {
        if (dirname(target) === OPS_DIR) offenders.push(`${rel(file)} -> ${rel(target)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
