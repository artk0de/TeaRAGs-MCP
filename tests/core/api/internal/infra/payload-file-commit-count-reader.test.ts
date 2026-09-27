/**
 * readPayloadFileCommitCounts (bd tea-rags-mcp-r8hme.14): every file's
 * `git.file.commitCount`, read in one payload-narrowed pass over the collection.
 * Every chunk of a file carries the same file-scoped git signals, so the first
 * chunk seen answers for its file.
 */
import { describe, expect, it, vi } from "vitest";

import { readPayloadFileCommitCounts } from "../../../../../src/core/api/internal/infra/payload-file-commit-count-reader.js";

function pages(...batches: Record<string, unknown>[][]) {
  return vi.fn(async function* () {
    for (const batch of batches) yield batch.map((payload, i) => ({ id: i, payload }));
  });
}

describe("readPayloadFileCommitCounts", () => {
  it("reads each file's commit count once, leaving out files the git trajectory never measured", async () => {
    const scrollPayloadPages = pages(
      [
        { relativePath: "src/a.ts", git: { file: { commitCount: 7 } } },
        { relativePath: "src/a.ts", git: { file: { commitCount: 7 } } },
        { relativePath: "src/b.ts", git: { file: {} } },
      ],
      [{ relativePath: "src/c.ts" }, { relativePath: "src/d.ts", git: { file: { commitCount: 1 } } }, { git: {} }],
    );

    const counts = await readPayloadFileCommitCounts({ scrollPayloadPages }, "code_x");

    expect(counts).toEqual(
      new Map([
        ["src/a.ts", 7],
        ["src/d.ts", 1],
      ]),
    );
    expect(scrollPayloadPages).toHaveBeenCalledWith("code_x", ["relativePath", "git.file.commitCount"]);
  });
});
