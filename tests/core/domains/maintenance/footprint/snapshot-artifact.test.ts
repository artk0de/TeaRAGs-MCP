import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
});
