import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fixturePhysicalCollectionName } from "../../../__helpers__/collection-identity.js";
import { SnapshotArtifact } from "../../../../../src/core/domains/maintenance/footprint/snapshot-artifact.js";

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

describe("SnapshotArtifact", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "snapshot-artifact-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("removes the legacy snapshot, its backup and the checkpoint files with the sharded store", async () => {
    const files = [
      "code_a.json",
      "code_a.json.backup",
      "code_a.checkpoint.json",
      "code_a.checkpoint.json.tmp",
      "code_b.json",
    ];
    for (const name of files) writeFileSync(join(root, name), "{}");
    const store = { cloneTo: vi.fn(), delete: vi.fn(async () => undefined) };
    const artifact = new SnapshotArtifact(root, () => store);

    await artifact.remove({ source: resolved("code_a"), target: resolved("code_a") });

    expect(store.delete).toHaveBeenCalledOnce();
    expect(files.filter((name) => existsSync(join(root, name)))).toEqual(["code_b.json"]);
  });

  it("removes interrupted-write temp entries and the retired recovery marker", async () => {
    mkdirSync(join(root, "code_a.tmp.1772810315425"));
    writeFileSync(join(root, "code_a.tmp.1772810315425", "shard-0.json"), "{}");
    writeFileSync(join(root, "code_a.json.tmp.1772810315425.k3j2h1x"), "{}");
    writeFileSync(join(root, "code_a.recovery-complete"), "");
    writeFileSync(join(root, "code_ab.tmp.1"), "{}");
    const store = { cloneTo: vi.fn(), delete: vi.fn(async () => undefined) };

    await new SnapshotArtifact(root, () => store).remove({ source: resolved("code_a"), target: resolved("code_a") });

    expect(readdirSync(root)).toEqual(["code_ab.tmp.1"]);
  });

  it("removes from the entries the caller already listed instead of scanning the directory", async () => {
    writeFileSync(join(root, "code_a.tmp.1"), "{}");
    writeFileSync(join(root, "code_a.tmp.2"), "{}");
    const store = { cloneTo: vi.fn(), delete: vi.fn(async () => undefined) };

    await new SnapshotArtifact(root, () => store).remove({
      source: resolved("code_a"),
      target: resolved("code_a"),
      knownStoreEntries: ["code_a.tmp.1"],
    });

    expect(readdirSync(root)).toEqual(["code_a.tmp.2"]);
  });
});
