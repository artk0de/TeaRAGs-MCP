/**
 * `index-codebase` and the worktree seed (bd tea-rags-mcp-k8gac): the opt-out
 * flag reaches the run, and the run's seed outcome reaches both the human
 * status block and the `--json` object.
 */

import { describe, expect, it } from "vitest";
import yargs from "yargs";

import { buildIndexOptions, indexCodebaseCommand } from "../../src/cli/commands/index-codebase.js";
import type { WorkerMessage } from "../../src/cli/index-progress/ipc-protocol.js";
import { formatIndexStatus, formatIndexStatusJson } from "../../src/cli/index-progress/status-format.js";
import { runIndexWorker } from "../../src/cli/index-progress/worker.js";
import { createColorizer } from "../../src/cli/infra/color.js";
import type { IndexStatus, WorktreeSeedReport } from "../../src/core/api/public/index.js";

function parse(argv: string[]): Record<string, unknown> {
  let failure: string | undefined;
  const parsed = yargs([])
    .command({ ...indexCodebaseCommand, handler: () => undefined })
    .exitProcess(false)
    .fail((msg: string) => {
      failure = msg;
    })
    .parse(argv) as Record<string, unknown>;
  if (failure !== undefined) throw new Error(failure);
  return parsed;
}

const SEEDED: WorktreeSeedReport = {
  status: "seeded",
  source: { collectionName: "code_main", project: "tea-rags", path: "/repo/main" },
  filesCopied: 16463,
  filesIndexed: 11087,
  filesRemoved: 12,
  gitRefresh: "background",
  rejected: [],
};

const status: IndexStatus = { isIndexed: true, status: "indexed", collectionName: "code_wt" };

describe("--no-worktree-seed", () => {
  it("turns the seed off for the run", () => {
    const argv = parse(["index-codebase", "/repo/wt", "--no-worktree-seed"]);
    expect(argv.path).toBe("/repo/wt");
    expect(buildIndexOptions(argv as never).seedFromWorktree).toBe(false);
  });

  it("leaves the default (seed when a sibling allows it) untouched when absent", () => {
    const options = buildIndexOptions(parse(["index-codebase", "/repo/wt"]) as never);
    expect(options).not.toHaveProperty("seedFromWorktree");
  });

  it("keeps the other flags mapping as before", () => {
    const options = buildIndexOptions(
      parse(["index-codebase", "--force-enrichments", "git,codegraph", "--languages", "ruby"]) as never,
    );
    expect(options).toEqual({ forceReindex: false, forceEnrichments: ["git", "codegraph"], languages: ["ruby"] });
  });
});

describe("the seed outcome in the run's output", () => {
  it("rides every status message the worker sends, like the run's enrichment metrics", async () => {
    const app = {
      indexCodebase: async () => Promise.resolve({ status: "completed", worktreeSeed: SEEDED }),
      getIndexStatus: async () => Promise.resolve(status),
      whenEnrichmentComplete: async () => Promise.resolve(),
    };
    const sent: WorkerMessage[] = [];

    await runIndexWorker(app as never, "/repo/wt", {}, (m) => sent.push(m));

    const statuses = sent.filter((m): m is Extract<WorkerMessage, { type: "status" }> => m.type === "status");
    expect(statuses).toHaveLength(2);
    for (const message of statuses) expect(message.status.worktreeSeed).toEqual(SEEDED);
  });

  it("is reported verbatim in the --json object", () => {
    const json = formatIndexStatusJson({ ...status, worktreeSeed: SEEDED }, { path: "/repo/wt" }) as Record<
      string,
      unknown
    >;
    expect(json.worktreeSeed).toEqual(SEEDED);
  });

  it("is absent from the --json object of a run that was no first index", () => {
    const json = formatIndexStatusJson(status, { path: "/repo/wt" }) as Record<string, unknown>;
    expect(json).not.toHaveProperty("worktreeSeed");
  });

  it("gets its own block in the human status", () => {
    const colors = createColorizer({ env: { NO_COLOR: "1" }, isTTY: false });
    const text = formatIndexStatus({ ...status, worktreeSeed: SEEDED }, colors);
    expect(text).toContain("Worktree seed");
    expect(text).toContain("  seeded from tea-rags (/repo/main): 16463 files copied, 11087 embedded, 12 removed");
  });

  it("prints no block when the seed has nothing to say", () => {
    const colors = createColorizer({ env: { NO_COLOR: "1" }, isTTY: false });
    const text = formatIndexStatus(
      { ...status, worktreeSeed: { status: "skipped", reason: "no-sibling", rejected: [] } },
      colors,
    );
    expect(text).not.toContain("Worktree seed");
  });
});
