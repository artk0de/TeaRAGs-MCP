/**
 * `namingSectionProvider` (bd tea-rags-mcp-89k7k.1.4, F3 slice 1): the review
 * section behind `review_changes`'s `naming` id. It owns no judgement of its
 * own — it forwards the diff request to `NamingLexiconOps#getNamingLexicon`
 * (which re-reads the diff itself; the double read is documented in the
 * provider) and spreads the returned `.review` verbatim, so the section keeps
 * field parity with `get_naming_lexicon` diff mode for free.
 */
import { describe, expect, it, vi } from "vitest";

import type { DiffScopeRead } from "../../../../../../src/core/api/internal/ops/diff-scope-reader.js";
import type { ReviewSectionContext } from "../../../../../../src/core/api/internal/ops/review-sections/index.js";
import { namingSectionProvider } from "../../../../../../src/core/api/internal/ops/review-sections/naming-section.js";

const scope: DiffScopeRead = {
  workTree: "/w",
  base: "main",
  mergeBase: "mb123",
  notices: [],
  changedFiles: 2,
  wholeFiles: 0,
  files: ["src/a.ts", "src/b.ts"],
  addedRanges: new Map(),
  nonProduction: new Set(),
  skipped: 0,
};

function makeContext(overrides: Partial<ReviewSectionContext> = {}): ReviewSectionContext {
  return {
    scope,
    graphDb: undefined,
    temporalCochange: undefined,
    temporalCochangeError: undefined,
    lexiconOps: {
      getNamingLexicon: vi.fn().mockResolvedValue({
        scope: "",
        byType: [],
        names: [],
        review: {
          workTree: "/w",
          base: "main",
          mergeBase: "mb123",
          changedFiles: 2,
          checked: 4,
          conforming: 3,
          novel: 0,
          findings: [{ relPath: "src/a.ts", line: 3, name: "meta", kind: "local", verdict: "MISFIT" }],
          notJudged: 1,
        },
      }),
    },
    addressing: { project: "p" },
    collectionName: "code_x",
    windowMonths: 6,
    diffRequest: { base: "main", files: ["src/a.ts"] },
    ...overrides,
  };
}

describe("namingSectionProvider", () => {
  it("is built whenever the lexicon is wired — it degrades on its own", () => {
    expect(namingSectionProvider.isBuilt(makeContext())).toEqual({ built: true });
    expect(namingSectionProvider.isBuilt(makeContext({ lexiconOps: undefined }))).toEqual({
      built: false,
      reason: expect.stringMatching(/naming lexicon not wired/),
    });
  });

  it("passes the diff request through and spreads `.review` verbatim", async () => {
    const context = makeContext();
    const payload = (await namingSectionProvider.run(context)) as Record<string, unknown>;

    expect(context.lexiconOps?.getNamingLexicon).toHaveBeenCalledWith({
      project: "p",
      changes: { base: "main" },
      files: ["src/a.ts"],
    });
    expect(payload.checked).toBe(4);
    expect(payload.conforming).toBe(3);
    expect(payload.findings).toEqual([
      { relPath: "src/a.ts", line: 3, name: "meta", kind: "local", verdict: "MISFIT" },
    ]);
    expect(payload.notJudged).toBe(1);
  });

  it("omits `files` when the request named none — the lexicon reads the diff itself", async () => {
    const context = makeContext({ diffRequest: { base: undefined } });
    await namingSectionProvider.run(context);
    const call = (context.lexiconOps?.getNamingLexicon as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.changes).toEqual({});
    expect(call.files).toBeUndefined();
  });

  it("answers not-built when the lexicon returns no review", async () => {
    const context = makeContext({
      lexiconOps: { getNamingLexicon: vi.fn().mockResolvedValue({ scope: "", byType: [], names: [] }) },
    });
    const payload = (await namingSectionProvider.run(context)) as { built: boolean; reason?: string };
    expect(payload.built).toBe(false);
    expect(payload.reason).toMatch(/no review/);
  });
});
