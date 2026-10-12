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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../../../");
const QDRANT_DIR = join(ROOT, "src/core/adapters/qdrant");
const PORTS_FILE = join(QDRANT_DIR, "ports.ts");
const CLIENT_FILE = join(QDRANT_DIR, "client.ts");
const GUARD_FILE = join(QDRANT_DIR, "embedding-model-guard.ts");

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

/**
 * Q2maint pin (bd tea-rags-mcp-89k7k.35, 6oah1 Q2): the maintenance domain
 * types its Qdrant dependency against the narrowest `ports.ts` role it calls,
 * not against the 55-method concrete facade. Files where a port cannot cover
 * the dependency YET stay on the concrete class, and each carries its reason
 * here — a connection-intent accessor (`aliases`) or a hand-off to an
 * `adapters/qdrant` collaborator whose own signature still takes
 * `QdrantManager`. When one of those collaborators is ported, the file
 * narrows and its entry must be deleted (the second test below refuses a
 * stale entry).
 */
const MAINTENANCE_DIR = join(ROOT, "src/core/domains/maintenance");

const MAINTENANCE_CONCRETE_KEPT: Record<string, string> = {
  "src/core/domains/maintenance/footprint/factory.ts":
    "forwards the manager into QdrantArtifact's concrete constructor (QdrantArtifact needs the aliases accessor)",
  "src/core/domains/maintenance/footprint/qdrant-artifact.ts":
    "calls the aliases accessor (createAlias / deleteAlias) — connection intent, outside every port",
  "src/core/domains/maintenance/migration/adapters/index-store-adapter.ts":
    "calls aliases.listAliases and hands the manager to SchemaMetadataPointStore, whose constructor is still concrete",
  "src/core/domains/maintenance/migration/adapters/sparse-store-adapter.ts":
    "hands the manager to SchemaMetadataPointStore, whose constructor is still concrete",
  "src/core/domains/maintenance/migration/adapters/stats-store-adapter.ts":
    "passes the manager to the scroll.ts helpers (scrollAllPoints / sampleVectors), whose parameters are still concrete",
  "src/core/domains/maintenance/worktree/worktree-provisioner.ts":
    "calls aliases.resolveActive — connection intent, outside every port",
};

function typescriptFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...typescriptFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(absolute);
  }
  return files;
}

/** The concrete-facade type references a maintenance file holds, comments excluded. */
function holdsConcreteFacadeReference(file: string): boolean {
  return /QdrantManager|EmbeddingModelGuard\b/.test(stripComments(readFileSync(file, "utf-8")));
}

describe("maintenance domain types its qdrant dependency against the ports (6oah1 Q2maint)", () => {
  it("holds no QdrantManager / EmbeddingModelGuard type reference outside the concrete-kept allowlist", () => {
    const offenders = typescriptFiles(MAINTENANCE_DIR)
      .filter(holdsConcreteFacadeReference)
      .map(rel)
      .filter((file) => !(file in MAINTENANCE_CONCRETE_KEPT));
    expect(
      offenders,
      "files still binding the concrete facade — narrow them to a ports.ts role, or record in MAINTENANCE_CONCRETE_KEPT why they must stay concrete",
    ).toEqual([]);
  });

  it("keeps the concrete-kept allowlist honest — every entry still holds a concrete reference", () => {
    const stale = Object.keys(MAINTENANCE_CONCRETE_KEPT).filter((file) => {
      const absolute = join(ROOT, file);
      return !existsSync(absolute) || !holdsConcreteFacadeReference(absolute);
    });
    expect(
      stale,
      "allowlist entries whose file no longer references the concrete facade — delete them so the list tracks the code",
    ).toEqual([]);
  });
});
