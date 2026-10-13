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
const ALIASES_FILE = join(QDRANT_DIR, "aliases.ts");

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

/**
 * The ten port roles Q1 declares (N-4, NAMING.md "6oah1 N4"), plus the alias
 * role and the facade accessor that hands it out (bd tea-rags-mcp-89k7k.39).
 */
const PORT_INTERFACES = [
  "QdrantAliasAdmin",
  "QdrantAliasAccess",
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
  it("declares ports.ts with every port role", () => {
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

  it("the facade and the alias collaborator implement the alias roles (bd tea-rags-mcp-89k7k.39)", () => {
    expect(stripComments(readFileSync(CLIENT_FILE, "utf-8"))).toMatch(
      /implements[\s\S]*?\bQdrantAliasAccess\b[\s\S]*?\{/,
    );
    expect(stripComments(readFileSync(ALIASES_FILE, "utf-8"))).toMatch(
      /export class QdrantAliasManager implements QdrantAliasAdmin\b/,
    );
  });
});

/**
 * Q2maint pin (bd tea-rags-mcp-89k7k.35, 6oah1 Q2): the maintenance domain
 * types its Qdrant dependency against the narrowest `ports.ts` role it calls,
 * not against the 55-method concrete facade. Files where a port cannot cover
 * the dependency YET stay on the concrete class, and each carries its reason
 * here — a hand-off to an `adapters/qdrant` collaborator whose own signature
 * still takes `QdrantManager`. When one of those collaborators is ported, the file
 * narrows and its entry must be deleted (the second test below refuses a
 * stale entry).
 */
const MAINTENANCE_DIR = join(ROOT, "src/core/domains/maintenance");

const MAINTENANCE_CONCRETE_KEPT: Record<string, string> = {
  "src/core/domains/maintenance/migration/adapters/index-store-adapter.ts":
    "hands the manager to SchemaMetadataPointStore, whose constructor is still concrete",
  "src/core/domains/maintenance/migration/adapters/sparse-store-adapter.ts":
    "hands the manager to SchemaMetadataPointStore, whose constructor is still concrete",
  "src/core/domains/maintenance/migration/adapters/stats-store-adapter.ts":
    "passes the manager to the scroll.ts helpers (scrollAllPoints / sampleVectors), whose parameters are still concrete",
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

/**
 * The concrete-facade type references a file holds, comments excluded — the
 * facade, the guard, and the alias collaborator the facade's `aliases`
 * accessor returns (a holder types that as `QdrantAliasAdmin`, bd tea-rags-mcp-89k7k.39).
 */
function holdsConcreteFacadeReference(file: string): boolean {
  return /Qdrant(?:Alias)?Manager\b|EmbeddingModelGuard\b/.test(stripComments(readFileSync(file, "utf-8")));
}

/**
 * Q2pipe pin (bd tea-rags-mcp-89k7k.35, 6oah1 Q2): the ingest pipeline and its
 * enrichment half type their Qdrant dependency against the narrowest `ports.ts`
 * role they call, not against the 55-method concrete facade. Files where a port
 * cannot cover the dependency YET stay on the concrete class, and each carries
 * its reason here — a connection-intent accessor (`url` / `isEmbedded`). When one of those narrows, its entry must be deleted (the second
 * test below refuses a stale entry).
 */
const PIPELINE_DIR = join(ROOT, "src/core/domains/ingest/pipeline");

const PIPELINE_CONCRETE_KEPT: Record<string, string> = {
  "src/core/domains/ingest/pipeline/base.ts":
    "reads the connection-intent accessors isEmbedded / url for the registry's qdrantEmbedded / qdrantUrl — outside every port",
  "src/core/domains/ingest/pipeline/status-module.ts": "reads the connection-intent accessor url — outside every port",
};

describe("ingest pipeline types its qdrant dependency against the ports (6oah1 Q2pipe)", () => {
  it("holds no QdrantManager / EmbeddingModelGuard type reference outside the concrete-kept allowlist", () => {
    const offenders = typescriptFiles(PIPELINE_DIR)
      .filter(holdsConcreteFacadeReference)
      .map(rel)
      .filter((file) => !(file in PIPELINE_CONCRETE_KEPT));
    expect(
      offenders,
      "files still binding the concrete facade — narrow them to a ports.ts role, or record in PIPELINE_CONCRETE_KEPT why they must stay concrete",
    ).toEqual([]);
  });

  it("keeps the concrete-kept allowlist honest — every entry still holds a concrete reference", () => {
    const stale = Object.keys(PIPELINE_CONCRETE_KEPT).filter((file) => {
      const absolute = join(ROOT, file);
      return !existsSync(absolute) || !holdsConcreteFacadeReference(absolute);
    });
    expect(
      stale,
      "allowlist entries whose file no longer references the concrete facade — delete them so the list tracks the code",
    ).toEqual([]);
  });
});

/**
 * Q2ingestRest pin (bd tea-rags-mcp-89k7k.35, 6oah1 Q2): the rest of the ingest
 * domain — infra, operations and sync — types its Qdrant dependency against the
 * narrowest `ports.ts` role it calls, not against the 55-method concrete
 * facade. Files where a port cannot cover the dependency YET stay on the
 * concrete class, and each carries its reason here — a hand-off to an
 * `adapters/qdrant` helper whose own parameter is still concrete. When one of those narrows, its entry must be
 * deleted (the second test below refuses a stale entry).
 */
const INGEST_REST_DIRS = [
  join(ROOT, "src/core/domains/ingest/infra"),
  join(ROOT, "src/core/domains/ingest/operations"),
  join(ROOT, "src/core/domains/ingest/sync"),
];

const INGEST_REST_CONCRETE_KEPT: Record<string, string> = {
  "src/core/domains/ingest/infra/stats-recompute.ts":
    "passes the manager to scroll.ts's scrollAllPoints, whose parameter is still concrete",
};

describe("rest of ingest types its qdrant dependency against the ports (6oah1 Q2ingestRest)", () => {
  it("holds no QdrantManager / EmbeddingModelGuard type reference outside the concrete-kept allowlist", () => {
    const offenders = INGEST_REST_DIRS.flatMap(typescriptFiles)
      .filter(holdsConcreteFacadeReference)
      .map(rel)
      .filter((file) => !(file in INGEST_REST_CONCRETE_KEPT));
    expect(
      offenders,
      "files still binding the concrete facade — narrow them to a ports.ts role, or record in INGEST_REST_CONCRETE_KEPT why they must stay concrete",
    ).toEqual([]);
  });

  it("keeps the concrete-kept allowlist honest — every entry still holds a concrete reference", () => {
    const stale = Object.keys(INGEST_REST_CONCRETE_KEPT).filter((file) => {
      const absolute = join(ROOT, file);
      return !existsSync(absolute) || !holdsConcreteFacadeReference(absolute);
    });
    expect(
      stale,
      "allowlist entries whose file no longer references the concrete facade — delete them so the list tracks the code",
    ).toEqual([]);
  });
});

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

/**
 * Q2explore pin (bd tea-rags-mcp-89k7k.35, 6oah1 Q2): the explore domain types
 * its Qdrant dependency against the narrowest `ports.ts` role it calls, not
 * against the 55-method concrete facade. The strategy spine (base + the
 * constructors forwarding into it) needs search, point-read, payload-index and
 * catalog roles at once, so it takes their intersection; queries and the
 * working-tree helpers take the one or two roles their calls touch, keeping
 * pre-existing `Pick` optionality shapes intact but sourcing them from the
 * port. Files where a port cannot cover the dependency YET stay on the concrete
 * class and carry their reason here; when one narrows, its entry must be
 * deleted (the second test below refuses a stale entry).
 */
const EXPLORE_DIR = join(ROOT, "src/core/domains/explore");

const EXPLORE_CONCRETE_KEPT: Record<string, string> = {};

/**
 * Q2api pin (bd tea-rags-mcp-89k7k.35, 6oah1 Q2): the api / bootstrap / cli /
 * mcp slices type their Qdrant dependency against the narrowest `ports.ts`
 * role they call, not against the 55-method concrete facade. Files where a
 * port cannot cover the dependency YET stay on the concrete class, and each
 * carries its reason here — a construction site (`new QdrantManager` / the
 * guard's), a connection-intent accessor (`url` / `isEmbedded`), a hand-off to a collaborator whose own signature is still
 * concrete, the api/public value re-export cli composes through, or a cli
 * surface that may not import adapters below api/public at all. When one of
 * those narrows, its entry must be deleted (the second test below refuses a
 * stale entry).
 */
const API_DIRS = [
  join(ROOT, "src/core/api"),
  join(ROOT, "src/bootstrap"),
  join(ROOT, "src/cli"),
  join(ROOT, "src/mcp"),
];

const API_CONCRETE_KEPT: Record<string, string> = {
  "src/core/api/public/index.ts":
    "value re-export of the manager — the construction actors in cli/ build it through the api surface",
  "src/core/api/internal/ops/explore-ops.ts":
    "hands the manager to StatsRecomputeService, whose constructor is still concrete (scroll.ts's scrollAllPoints — narrows when that helper takes QdrantPointReader)",
  "src/core/api/internal/ops/indexing-ops.ts":
    "reads the connection-intent accessors url / isEmbedded — outside every port",
  "src/core/api/internal/ops/project-registry-ops.ts":
    "reads the connection-intent accessors url / isEmbedded for the registry's qdrant backend fields — outside every port",
  "src/core/api/internal/facades/explore-facade.ts":
    "hands the manager to ExploreOps, whose deps still hold it concrete (StatsRecomputeService forward)",
  "src/core/api/internal/facades/ingest-facade.ts":
    "hands the manager to IndexingOps and createIngestDependencies, whose signatures still hold it concrete",
  "src/core/api/internal/ingest-dependencies.ts":
    "hands the manager to the Index/Sparse/Stats store adapters and SchemaManager, whose constructors are still concrete",
  "src/bootstrap/factory.ts":
    "constructs the manager and reads its connection-intent accessor url; IngestFacade's deps still hold it concrete",
  "src/bootstrap/embedding-binding.ts":
    "constructs the manager and hands it to EmbeddingModelGuard's concrete constructor — guard ctor and the armed slot are construction sites",
  "src/cli/commands/doctor.ts":
    "composition actor constructing the manager; its narrow test-injection surfaces stay Pick'd off the api/public re-export — cli may not import adapters below api/public",
  "src/cli/commands/projects.ts":
    "composition actor constructing the manager; its narrow test-injection surfaces stay Pick'd off the api/public re-export — cli may not import adapters below api/public",
  "src/cli/commands/qdrant.ts": "constructs the manager (composition actor) — construction sites keep the concrete",
};

describe("api/bootstrap/cli/mcp type their qdrant dependency against the ports (6oah1 Q2api)", () => {
  it("holds no QdrantManager / EmbeddingModelGuard type reference outside the concrete-kept allowlist", () => {
    const offenders = API_DIRS.flatMap(typescriptFiles)
      .filter(holdsConcreteFacadeReference)
      .map(rel)
      .filter((file) => !(file in API_CONCRETE_KEPT));
    expect(
      offenders,
      "files still binding the concrete facade — narrow them to a ports.ts role, or record in API_CONCRETE_KEPT why they must stay concrete",
    ).toEqual([]);
  });

  it("keeps the concrete-kept allowlist honest — every entry still holds a concrete reference", () => {
    const stale = Object.keys(API_CONCRETE_KEPT).filter((file) => {
      const absolute = join(ROOT, file);
      return !existsSync(absolute) || !holdsConcreteFacadeReference(absolute);
    });
    expect(
      stale,
      "allowlist entries whose file no longer references the concrete facade — delete them so the list tracks the code",
    ).toEqual([]);
  });
});

describe("explore domain types its qdrant dependency against the ports (6oah1 Q2explore)", () => {
  it("holds no QdrantManager / EmbeddingModelGuard type reference outside the concrete-kept allowlist", () => {
    const offenders = typescriptFiles(EXPLORE_DIR)
      .filter(holdsConcreteFacadeReference)
      .map(rel)
      .filter((file) => !(file in EXPLORE_CONCRETE_KEPT));
    expect(
      offenders,
      "files still binding the concrete facade — narrow them to a ports.ts role, or record in EXPLORE_CONCRETE_KEPT why they must stay concrete",
    ).toEqual([]);
  });

  it("keeps the concrete-kept allowlist honest — every entry still holds a concrete reference", () => {
    const stale = Object.keys(EXPLORE_CONCRETE_KEPT).filter((file) => {
      const absolute = join(ROOT, file);
      return !existsSync(absolute) || !holdsConcreteFacadeReference(absolute);
    });
    expect(
      stale,
      "allowlist entries whose file no longer references the concrete facade — delete them so the list tracks the code",
    ).toEqual([]);
  });
});
