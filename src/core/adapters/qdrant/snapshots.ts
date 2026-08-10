/**
 * Collection snapshots — the copy-out / copy-in pair the worktree provisioner
 * and the footprint tooling use to clone an index without re-embedding it.
 *
 * A concern of its own, small as it is, because a snapshot is the one artifact
 * whose identity lives OUTSIDE the API surface: `createSnapshot` returns a name,
 * {@link QdrantSnapshotStore.snapshotDownloadUrl} turns that name plus the live
 * connection URL into a fetchable location, and `recoverFromSnapshot` reads such
 * a location back. Those three only make sense as a set, and the URL builder is
 * the reason this cannot simply fold into collection administration: it is the
 * only method in the adapter that formats a URL rather than calling the client.
 */

import type { QdrantConnection } from "./connection.js";
import { QdrantOperationError } from "./errors.js";

export class QdrantSnapshotStore {
  constructor(private readonly connection: QdrantConnection) {}

  async createSnapshot(name: string): Promise<string> {
    const desc = await this.connection.call(async () => this.connection.client.createSnapshot(name));
    if (!desc?.name) {
      throw new QdrantOperationError("createSnapshot", `Snapshot creation returned no name for collection ${name}`);
    }
    return desc.name;
  }

  snapshotDownloadUrl(collection: string, snapshotName: string): string {
    return `${this.connection.url.replace(/\/$/, "")}/collections/${collection}/snapshots/${snapshotName}`;
  }

  async recoverFromSnapshot(targetCollection: string, location: string): Promise<void> {
    const ok = await this.connection.call(async () =>
      this.connection.client.recoverSnapshot(targetCollection, { location, priority: "snapshot" }),
    );
    if (!ok) {
      throw new QdrantOperationError(
        "recoverFromSnapshot",
        `Snapshot recovery failed for collection ${targetCollection}`,
      );
    }
  }

  async deleteSnapshot(collection: string, snapshotName: string): Promise<void> {
    await this.connection.call(async () => this.connection.client.deleteSnapshot(collection, snapshotName));
  }
}
