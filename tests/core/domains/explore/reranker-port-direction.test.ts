/**
 * Direction pin for the Reranker port (bd tea-rags-mcp-89k7k.35, 6oah1 E1).
 *
 * `reranker-port.ts` declares the consumed surface the Reranker's holders are
 * typed against (N-1 = a: `<Class>Port`, class name unchanged). For the port to
 * be the stable abstraction the split is for, the ports file must be a LEAF
 * over its own declarations — it type-imports only from `contracts/`, never
 * from `reranker.js` — and the dependency arrow runs one way: concrete class →
 * port → holders.
 *
 * The holder census (main, 2026-10-11): explore strategies/{base,factory,
 * file-outline,similar,symbol} + post-process + rank-module, and api/internal
 * ops/{explore,indexing,trace-path} + facades/{explore,ingest} + infra/
 * schema-builder + app-factory. Files where the concrete class must stay each
 * carry their reason in the allowlist below (the second test refuses a stale
 * entry).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../../../");
const EXPLORE_DIR = join(ROOT, "src/core/domains/explore");
const PORT_FILE = join(EXPLORE_DIR, "reranker-port.ts");
const RERANKER_FILE = join(EXPLORE_DIR, "reranker.ts");

/** The api/internal files that hold a reranker dependency (E1 census). */
const API_INTERNAL_HOLDERS = [
  "src/core/api/internal/app-factory.ts",
  "src/core/api/internal/composition.ts",
  "src/core/api/internal/facades/explore-facade.ts",
  "src/core/api/internal/facades/ingest-facade.ts",
  "src/core/api/internal/infra/schema-builder.ts",
  "src/core/api/internal/ops/explore-ops.ts",
  "src/core/api/internal/ops/indexing-ops.ts",
  "src/core/api/internal/ops/trace-path-ops.ts",
] as const;

/** The file with comments removed, so prose mentions of a class name never read as a type reference. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Resolved absolute targets of every relative module specifier in a file (static, re-export, dynamic, type). */
function relativeTargets(file: string): string[] {
  const text = stripComments(readFileSync(file, "utf-8"));
  const targets: string[] = [];
  const pattern = /(?:from\s*|import\s*\(\s*|import\s+)"(\.{1,2}\/[^"]+)"/g;
  for (const match of text.matchAll(pattern)) {
    targets.push(resolve(dirname(file), match[1]).replace(/\.js$/, ".ts"));
  }
  return targets;
}

function typescriptFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...typescriptFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(absolute);
  }
  return files;
}

const rel = (abs: string): string => relative(ROOT, abs);

/** The concrete-class references a file holds, comments excluded (`RerankerPort`, `RerankMode` etc. do not match). */
function holdsConcreteReranker(file: string): boolean {
  return /\bReranker\b/.test(stripComments(readFileSync(file, "utf-8")));
}

/**
 * Files that must keep the concrete class. When one of these narrows, its
 * entry must be deleted so the list tracks the code.
 */
const CONCRETE_KEPT: Record<string, string> = {
  "src/core/domains/explore/reranker.ts":
    "declares the concrete class — the implementation site, implements RerankerPort",
  "src/core/domains/explore/index.ts":
    "domain barrel re-exports the class for the assembly surface (composition constructs it)",
  "src/core/api/internal/composition.ts": "the one constructor site — news up Reranker and wires registry data into it",
};

describe("explore declares RerankerPort and the holders type against it (6oah1 E1)", () => {
  it("declares reranker-port.ts with the RerankerPort interface", () => {
    expect(existsSync(PORT_FILE), "src/core/domains/explore/reranker-port.ts is missing").toBe(true);
    const text = readFileSync(PORT_FILE, "utf-8");
    expect(text).toMatch(/export interface RerankerPort\b/);
  });

  it("reranker-port.ts imports nothing from reranker.js — the port is a leaf over its declarations", () => {
    const offenders = relativeTargets(PORT_FILE)
      .filter((target) => target === RERANKER_FILE)
      .map((target) => `${rel(PORT_FILE)} -> ${rel(target)}`);
    expect(offenders).toEqual([]);
  });

  it("reranker.ts implements the port", () => {
    expect(relativeTargets(RERANKER_FILE)).toContain(PORT_FILE);
    expect(stripComments(readFileSync(RERANKER_FILE, "utf-8"))).toMatch(
      /export class Reranker implements RerankerPort\b/,
    );
  });

  it("explore and the api/internal holders hold no concrete Reranker type reference outside the concrete-kept allowlist", () => {
    const holders = [...typescriptFiles(EXPLORE_DIR), ...API_INTERNAL_HOLDERS.map((f) => join(ROOT, f))];
    const offenders = holders
      .filter(holdsConcreteReranker)
      .map(rel)
      .filter((file) => !(file in CONCRETE_KEPT));
    expect(
      offenders,
      "files still binding the concrete Reranker class — retype them to RerankerPort, or record in CONCRETE_KEPT why they must stay concrete",
    ).toEqual([]);
  });

  it("keeps the concrete-kept allowlist honest — every entry still holds a concrete reference", () => {
    const stale = Object.keys(CONCRETE_KEPT).filter((file) => {
      const absolute = join(ROOT, file);
      return !existsSync(absolute) || !holdsConcreteReranker(absolute);
    });
    expect(
      stale,
      "allowlist entries whose file no longer references the concrete class — delete them so the list tracks the code",
    ).toEqual([]);
  });
});
