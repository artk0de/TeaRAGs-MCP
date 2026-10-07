/**
 * bd tea-rags-mcp-214ib — the working-tree overlay (`buildOnDemandGitSignals`)
 * names an author identity exactly as the index does: one canonical display
 * name per identity, from the repo-wide window commits the persisted
 * file-churn snapshot holds (no `git log` of its own), applied to the file's
 * recent* and blame* names. A name the file's own records favour must not leak.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { importGitHistory } from "../../../../__helpers__/git-history-import.js";
import { GitCliAdapter } from "../../../../../../src/core/adapters/vcs/git/git-cli/adapter.js";
import type { CommitFileNumstat } from "../../../../../../src/core/adapters/vcs/types.js";
import {
  FileChurnDiscovery,
  type FileChurnDiscoveryPersistence,
  type PersistedFileChurnDiscovery,
} from "../../../../../../src/core/domains/trajectory/git/infra/file-churn-discovery.js";
import { buildOnDemandGitSignals } from "../../../../../../src/core/domains/trajectory/git/infra/on-demand-signals.js";

vi.setConfig({ testTimeout: 60_000 });

const DAY = 86_400_000;
const NOW = Date.now();
const at = (daysAgo: number): string => new Date(NOW - daysAgo * DAY).toISOString();
const FILE = "src/target.ts";
const OTHER = "src/other.ts";
const body = (n: number): string => `export function f(): number {\n  return ${n};\n}\n`;

function memoryStore(): FileChurnDiscoveryPersistence {
  let snapshot: PersistedFileChurnDiscovery | null = null;
  return {
    load: () => snapshot,
    loadLatest: () => snapshot,
    save: (repoRoot: string, head: string, sinceIso: string, entries: CommitFileNumstat[]) => {
      snapshot = { version: 2, repoRoot, head, sinceIso, entries };
    },
  };
}

describe("buildOnDemandGitSignals — canonical author names (bd tea-rags-mcp-214ib)", () => {
  let repo: string;

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "on-demand-names-")));
    mkdirSync(join(repo, "src"));
    const x = { name: "Robert Smith", email: "bob@x" };
    const y = { name: "bob", email: "bob@x" };
    importGitHistory(repo, [
      { message: "feat: other 1", author: x, authorDate: at(40), writes: { [OTHER]: body(1) } },
      { message: "feat: other 2", author: x, authorDate: at(30), writes: { [OTHER]: body(2) } },
      { message: "feat: other 3", author: x, authorDate: at(20), writes: { [OTHER]: body(3) } },
      // The target's own records carry the minority spelling only.
      { message: "feat: target", author: y, authorDate: at(10), writes: { [FILE]: body(7) } },
    ]);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  const overlay = async (churnStore: FileChurnDiscoveryPersistence) =>
    (
      await buildOnDemandGitSignals(
        new GitCliAdapter(repo),
        [
          {
            relPath: FILE,
            lineCount: 3,
            fileSignals: true,
            workingContent: body(7),
            chunks: [{ chunkId: "f", startLine: 1, endLine: 3 }],
          },
        ],
        {
          timeoutMs: 30_000,
          file: { maxAgeMonths: 12 },
          chunk: { maxAgeMonths: 6, timeoutMs: 30_000, maxFileLines: 5000, concurrency: 4 },
          churnStore,
        },
      )
    ).get(FILE);

  it("shows the repo-wide canonical name in recent* and blame*, not the file's own spelling", async () => {
    const store = memoryStore();
    await new FileChurnDiscovery(new GitCliAdapter(repo), { maxAgeMonths: 12, timeoutMs: 30_000, store }).fileChurn();

    const signals = await overlay(store);

    expect(signals?.file).toMatchObject({
      recentDominantAuthor: "Robert Smith",
      recentAuthors: ["Robert Smith"],
      blameDominantAuthor: "Robert Smith",
      blameAuthors: ["Robert Smith"],
    });
    expect(signals?.chunks.get("f")).toMatchObject({ blameDominantAuthor: "Robert Smith" });
  });

  it("keeps the per-file name when no snapshot exists, without a repo-wide log of its own", async () => {
    const signals = await overlay(memoryStore());

    expect(signals?.file).toMatchObject({ recentDominantAuthor: "bob", blameDominantAuthor: "bob" });
  });
});
