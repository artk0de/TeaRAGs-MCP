import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fixturePhysicalCollectionName } from "../../../__helpers__/collection-identity.js";
import type { CollectionArtifact } from "../../../../../src/core/domains/maintenance/footprint/artifact.js";
import { cloneCollectionFootprint } from "../../../../../src/core/domains/maintenance/footprint/clone-saga.js";
import { ResidualVerdictsArtifact } from "../../../../../src/core/domains/maintenance/footprint/residual-verdicts-artifact.js";

function resolved(logicalName: string) {
  return {
    logicalName,
    physicalName: fixturePhysicalCollectionName(`${logicalName}_v1`),
    path: "/p",
    embeddingModel: "j",
    embeddingDimensions: 768,
    qdrantUrl: "http://h",
    codegraphEnabled: true,
  };
}

describe("ResidualVerdictsArtifact", () => {
  let root: string;
  const fileFor = (logicalName: string): string => join(root, "residual-verdicts", `${logicalName}.duckdb`);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "residual-artifact-"));
    mkdirSync(join(root, "residual-verdicts"));
    writeFileSync(fileFor("code_src"), "db");
    writeFileSync(`${fileFor("code_src")}.wal`, "wal");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("is a logical artifact", () => {
    const artifact = new ResidualVerdictsArtifact(fileFor);
    expect([artifact.id, artifact.addressing]).toEqual(["residual-verdicts", "logical"]);
  });

  it("remove deletes the target's file and its WAL, and is idempotent", async () => {
    const artifact = new ResidualVerdictsArtifact(fileFor);
    const ctx = { source: resolved("code_src"), target: resolved("code_src") };

    await artifact.remove(ctx);
    await artifact.remove(ctx);

    expect(existsSync(fileFor("code_src"))).toBe(false);
    expect(existsSync(`${fileFor("code_src")}.wal`)).toBe(false);
  });

  it("clone copies nothing and leaves the source file in place", async () => {
    const artifact: CollectionArtifact = new ResidualVerdictsArtifact(fileFor);

    await artifact.clone({
      source: resolved("code_src"),
      target: resolved("code_dst"),
    });

    expect(existsSync(fileFor("code_src"))).toBe(true);
    expect(existsSync(fileFor("code_dst"))).toBe(false);
  });

  it("a rolled-back clone removes only the target's file, never the source's", async () => {
    const failing = {
      id: "stats" as const,
      addressing: "logical" as const,
      clone: async () => {
        throw new Error("boom");
      },
      remove: async () => undefined,
    };
    writeFileSync(fileFor("code_dst"), "stray");
    const factory = {
      build: () => ({
        context: { source: resolved("code_src"), target: resolved("code_dst") },
        artifacts: [new ResidualVerdictsArtifact(fileFor), failing],
      }),
    };

    await expect(cloneCollectionFootprint(factory, resolved("code_src"), resolved("code_dst"))).rejects.toThrow("boom");

    expect(existsSync(fileFor("code_src"))).toBe(true);
    expect(existsSync(fileFor("code_dst"))).toBe(false);
  });
});
