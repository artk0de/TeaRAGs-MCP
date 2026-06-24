import { describe, expect, it, vi } from "vitest";

import { QdrantManager } from "../../../../src/core/adapters/qdrant/client.js";

describe("QdrantManager snapshot/recover", () => {
  it("createSnapshot returns the snapshot name", async () => {
    const m = new QdrantManager("http://127.0.0.1:9999");
    // @ts-expect-error access private client for test seam
    m.client = { createSnapshot: vi.fn().mockResolvedValue({ name: "snap-1.snapshot" }) };
    await expect(m.createSnapshot("code_src_v1")).resolves.toBe("snap-1.snapshot");
  });

  it("createSnapshot throws when client returns no name", async () => {
    const m = new QdrantManager("http://127.0.0.1:9999");
    // @ts-expect-error test seam
    m.client = { createSnapshot: vi.fn().mockResolvedValue(null) };
    await expect(m.createSnapshot("code_src_v1")).rejects.toThrow(/no name/i);
  });

  it("snapshotDownloadUrl builds correct URL", () => {
    const m = new QdrantManager("http://127.0.0.1:6333/");
    expect(m.snapshotDownloadUrl("code_src_v1", "snap-1.snapshot")).toBe(
      "http://127.0.0.1:6333/collections/code_src_v1/snapshots/snap-1.snapshot",
    );
  });

  it("snapshotDownloadUrl trims trailing slash from base URL", () => {
    const m = new QdrantManager("http://127.0.0.1:6333");
    expect(m.snapshotDownloadUrl("code_src_v1", "snap-1.snapshot")).toBe(
      "http://127.0.0.1:6333/collections/code_src_v1/snapshots/snap-1.snapshot",
    );
  });

  it("recoverFromSnapshot passes location with snapshot priority", async () => {
    const m = new QdrantManager("http://127.0.0.1:9999");
    const recoverSnapshot = vi.fn().mockResolvedValue(true);
    // @ts-expect-error test seam
    m.client = { recoverSnapshot };
    await m.recoverFromSnapshot("code_dst_v1", "http://h/collections/code_src_v1/snapshots/snap-1.snapshot");
    expect(recoverSnapshot).toHaveBeenCalledWith("code_dst_v1", {
      location: "http://h/collections/code_src_v1/snapshots/snap-1.snapshot",
      priority: "snapshot",
    });
  });

  it("recoverFromSnapshot throws when the client reports failure", async () => {
    const m = new QdrantManager("http://127.0.0.1:9999");
    // @ts-expect-error test seam
    m.client = { recoverSnapshot: vi.fn().mockResolvedValue(false) };
    await expect(m.recoverFromSnapshot("code_dst_v1", "file:///x")).rejects.toThrow(/recovery failed/i);
  });

  it("deleteSnapshot calls client.deleteSnapshot with collection and snapshot name", async () => {
    const m = new QdrantManager("http://127.0.0.1:9999");
    const deleteSnapshot = vi.fn().mockResolvedValue(undefined);
    // @ts-expect-error test seam
    m.client = { deleteSnapshot };
    await m.deleteSnapshot("code_src_v1", "snap-1.snapshot");
    expect(deleteSnapshot).toHaveBeenCalledWith("code_src_v1", "snap-1.snapshot");
  });
});
