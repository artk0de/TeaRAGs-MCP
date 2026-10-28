import type { ProceduralDatabaseMigration } from "../runner.js";

/** Physical conversion precedes BEGIN; the ordinary transaction records success in the ledger. */
export const STORAGE_FORMAT_2_MIGRATION: ProceduralDatabaseMigration = {
  filename: "069-cg-storage-format-2.ts",
  async prepare(client) {
    await client.convertStorageToCurrentFormat?.();
  },
  async run() {
    // Already verified and atomically published by prepare, before the transactional runner.
  },
};
