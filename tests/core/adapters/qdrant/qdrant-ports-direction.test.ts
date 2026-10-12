/**
 * Import-direction pin for adapters/qdrant ports (bd tea-rags-mcp-89k7k.35, 6oah1 Q1).
 *
 * `ports.ts` declares the role interfaces consumers will be typed against
 * (N-3: they live beside their collaborator classes, not in contracts). For a
 * port to be the stable abstraction the split is for, the ports file must be a
 * LEAF over its own type declarations: it may type-import from the collaborator
 * modules that own the shared result/option types (`collection-admin.ts`,
 * `search-executor.ts`, `types.ts`, …), but never from the two concrete
 * facades it abstracts — `client.ts` (`QdrantManager`) and
 * `embedding-model-guard.ts` (`EmbeddingModelGuard`). The dependency arrow runs
 * one way: concrete class → port.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../../../");
const QDRANT_DIR = join(ROOT, "src/core/adapters/qdrant");
const PORTS_FILE = join(QDRANT_DIR, "ports.ts");
const CLIENT_FILE = join(QDRANT_DIR, "client.ts");
const GUARD_FILE = join(QDRANT_DIR, "embedding-model-guard.ts");

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

/** The ten port roles Q1 declares (N-4, NAMING.md "6oah1 N4"). */
const PORT_INTERFACES = [
  "QdrantCollectionCatalog",
  "QdrantCollectionLifecycle",
  "QdrantPointReader",
  "QdrantPointWriter",
  "QdrantSearchReader",
  "QdrantPayloadIndexAdmin",
  "QdrantOptimizerControl",
  "QdrantSnapshotSource",
  "QdrantHealthProbe",
  "EmbeddingModelGuardPort",
] as const;

describe("adapters/qdrant ports are a leaf the concrete facades implement", () => {
  it("declares ports.ts with the ten port roles", () => {
    expect(existsSync(PORTS_FILE), "src/core/adapters/qdrant/ports.ts is missing").toBe(true);
    const text = readFileSync(PORTS_FILE, "utf-8");
    for (const name of PORT_INTERFACES) {
      expect(text, `${name} is not declared in ports.ts`).toMatch(new RegExp(`export interface ${name}\\b`));
    }
  });

  it("ports.ts imports nothing from client.ts / embedding-model-guard.ts", () => {
    const offenders = relativeTargets(PORTS_FILE)
      .filter((target) => target === CLIENT_FILE || target === GUARD_FILE)
      .map((target) => `${rel(PORTS_FILE)} -> ${rel(target)}`);
    expect(offenders).toEqual([]);
  });

  it("client.ts imports the ports from ./ports.js", () => {
    expect(relativeTargets(CLIENT_FILE)).toContain(PORTS_FILE);
  });

  it("embedding-model-guard.ts imports the ports from ./ports.js", () => {
    expect(relativeTargets(GUARD_FILE)).toContain(PORTS_FILE);
  });
});
