/**
 * Import-direction pins for the ingest domain (bd tea-rags-mcp-g7w8f, item 1).
 *
 * The ingest root is the stable sink of the domain: pipeline, sync, operations
 * and infra import `errors.ts`, so the root may not import back into any of
 * them. Each assertion below pins one edge group that used to close the ingest
 * knot. `import type` counts: the architecture detector judges type edges too.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../../../");
const INGEST_DIR = join(ROOT, "src/core/domains/ingest");
const PIPELINE_DIR = join(INGEST_DIR, "pipeline");
const PIPELINE_INFRA_DIR = join(PIPELINE_DIR, "infra");
const ENRICHMENT_DIR = join(PIPELINE_DIR, "enrichment");

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
const isUnder = (abs: string, dir: string): boolean => abs.startsWith(dir + sep);

/** Root-level ingest files other than the `index.ts` facade (facade aggregation is not judged). */
function rootFilesExceptFacade(): string[] {
  return readdirSync(INGEST_DIR)
    .filter((entry) => entry.endsWith(".ts") && entry !== "index.ts")
    .map((entry) => join(INGEST_DIR, entry));
}

describe("ingest root never imports into its children", () => {
  it("ingest/errors.ts imports no file under an ingest child directory (DeletionOutcome is a contract)", () => {
    const errorsFile = join(INGEST_DIR, "errors.ts");
    const offenders = relativeTargets(errorsFile)
      .filter((target) => isUnder(target, INGEST_DIR) && dirname(target) !== INGEST_DIR)
      .map((target) => `${rel(errorsFile)} -> ${rel(target)}`);
    expect(offenders).toEqual([]);
  });

  it("no root ingest file except index.ts imports a file under pipeline/, sync/, operations/ or infra/ (IngestDependencies lives in pipeline)", () => {
    const offenders: string[] = [];
    for (const file of rootFilesExceptFacade()) {
      for (const target of relativeTargets(file)) {
        if (isUnder(target, INGEST_DIR) && dirname(target) !== INGEST_DIR) {
          offenders.push(`${rel(file)} -> ${rel(target)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("pipeline/infra owns the batching and work-item vocabulary", () => {
  it("nothing under pipeline/infra/ imports a file directly in pipeline/ or the ingest root other than errors.ts", () => {
    const allowed = join(INGEST_DIR, "errors.ts");
    const offenders: string[] = [];
    for (const file of tsFilesUnder(PIPELINE_INFRA_DIR)) {
      for (const target of relativeTargets(file)) {
        const dir = dirname(target);
        if ((dir === PIPELINE_DIR || dir === INGEST_DIR) && target !== allowed) {
          offenders.push(`${rel(file)} -> ${rel(target)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("nothing under pipeline/enrichment/ imports pipeline/types.ts (ChunkItem comes from pipeline/infra)", () => {
    const pipelineTypes = join(PIPELINE_DIR, "types.ts");
    const offenders: string[] = [];
    for (const file of tsFilesUnder(ENRICHMENT_DIR)) {
      for (const target of relativeTargets(file)) {
        if (target === pipelineTypes) offenders.push(`${rel(file)} -> ${rel(target)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("the enrichment executor owns its wire format", () => {
  it("nothing under enrichment/executor/ imports a file elsewhere under enrichment/ (the worker protocol lives in executor/)", () => {
    const executorDir = join(ENRICHMENT_DIR, "executor");
    const offenders: string[] = [];
    for (const file of tsFilesUnder(executorDir)) {
      for (const target of relativeTargets(file)) {
        if (isUnder(target, ENRICHMENT_DIR) && !isUnder(target, executorDir)) {
          offenders.push(`${rel(file)} -> ${rel(target)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
