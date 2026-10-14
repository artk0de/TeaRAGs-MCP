/**
 * readPayloadFileFacts / RequestScopedFileFactsReader (bd tea-rags-mcp-i2zr8):
 * the file-level facts a review consumes — maintenance readings and indexed
 * imports — read by ONE payload scroll whose pages feed both reducers, each
 * keeping its own dedupe rule, so the answers equal the standalone readers'.
 */
import { describe, expect, it, vi } from "vitest";

import {
  readPayloadFileFacts,
  RequestScopedFileFactsReader,
} from "../../../../../src/core/api/internal/infra/payload-file-facts-reader.js";
import { readPayloadFileMaintenanceSignals } from "../../../../../src/core/api/internal/infra/payload-file-maintenance-signal-reader.js";
import { readPayloadIndexedFileImports } from "../../../../../src/core/api/internal/infra/payload-import-specifier-reader.js";

const full = { commitCount: 7, bugFixRate: 40, ageDays: 3 };

/**
 * Multi-chunk files spread over pages in ascending point-id order: `src/a.ts`'s
 * first chunk carries readings but no imports, its second carries imports and
 * different readings — the maintenance reducer keeps the first, the imports
 * reducer the first NON-EMPTY.
 */
const FIXTURE_PAGES: { id: number; payload: Record<string, unknown> }[][] = [
  [
    { id: 1, payload: { relativePath: "src/a.ts", imports: [], git: { file: full } } },
    { id: 2, payload: { relativePath: "src/b.ts", git: { file: { commitCount: 2, ageDays: 1 } } } },
  ],
  [
    {
      id: 3,
      payload: { relativePath: "src/a.ts", imports: ["./b"], git: { file: { ...full, commitCount: 99 } } },
    },
    {
      id: 4,
      payload: {
        relativePath: "tests/a.test.ts",
        isTest: true,
        imports: ["../src/a"],
        git: { file: { commitCount: 1, bugFixRate: 0, ageDays: 200 } },
      },
    },
  ],
  [
    { id: 5, payload: { relativePath: "src/a.ts", imports: ["./c"] } },
    { id: 6, payload: { relativePath: "src/b.ts", imports: ["./a"], git: { file: full } } },
    { id: 7, payload: { imports: ["./orphan"], git: { file: full } } },
  ],
];

function scroller(pages = FIXTURE_PAGES) {
  return vi.fn(async function* (_collection: string, _keys: string[]) {
    yield* pages;
  });
}

function failingScroller(error: Error) {
  // Yields one page, then the scroll breaks mid-collection.
  return vi.fn(async function* (_collection: string, _keys: string[]) {
    yield FIXTURE_PAGES[0];
    throw error;
  });
}

describe("readPayloadFileFacts", () => {
  it("answers both reducers from one scroll, each identical to its standalone reader", async () => {
    const scrollPayloadPages = scroller();

    const facts = await readPayloadFileFacts({ scrollPayloadPages }, "code_x");

    expect(scrollPayloadPages).toHaveBeenCalledTimes(1);
    expect(facts.maintenanceSignals).toEqual(
      await readPayloadFileMaintenanceSignals({ scrollPayloadPages: scroller() }, "code_x"),
    );
    expect(facts.indexedFileImports).toEqual(
      await readPayloadIndexedFileImports({ scrollPayloadPages: scroller() }, "code_x"),
    );
    expect(facts.maintenanceSignals).toEqual(
      new Map([
        ["src/a.ts", full],
        ["tests/a.test.ts", { commitCount: 1, bugFixRate: 0, ageDays: 200 }],
        ["src/b.ts", full],
      ]),
    );
    expect(facts.indexedFileImports).toEqual(
      new Map([
        ["src/a.ts", { isTest: false, specifiers: ["./b"] }],
        ["tests/a.test.ts", { isTest: true, specifiers: ["../src/a"] }],
        ["src/b.ts", { isTest: false, specifiers: ["./a"] }],
      ]),
    );
  });

  it("scrolls the union of both reducers' payload keys", async () => {
    const scrollPayloadPages = scroller();

    await readPayloadFileFacts({ scrollPayloadPages }, "code_x");

    const keys = scrollPayloadPages.mock.calls[0][1];
    expect(new Set(keys)).toEqual(
      new Set([
        "relativePath",
        "git.file.commitCount",
        "git.file.bugFixRate",
        "git.file.ageDays",
        "imports",
        "isTest",
        "codegraph.symbols.file.skippedAs",
      ]),
    );
    expect(keys).toHaveLength(new Set(keys).size);
  });
});

describe("RequestScopedFileFactsReader", () => {
  it("scrolls once per review however many times either fact is consumed", async () => {
    const scrollPayloadPages = scroller();
    const reader = new RequestScopedFileFactsReader({ scrollPayloadPages });

    const [signals, imports, importsAgain] = await reader.withinRequest(async () =>
      Promise.all([
        reader.readFileMaintenanceSignals("code_x"),
        reader.readIndexedFileImports("code_x"),
        reader.readIndexedFileImports("code_x"),
      ]),
    );

    expect(scrollPayloadPages).toHaveBeenCalledTimes(1);
    expect(signals).toEqual(await readPayloadFileMaintenanceSignals({ scrollPayloadPages: scroller() }, "code_x"));
    expect(imports).toEqual(await readPayloadIndexedFileImports({ scrollPayloadPages: scroller() }, "code_x"));
    expect(importsAgain).toBe(imports);
  });

  it("shares a scan with a fact consumed after the other one settled", async () => {
    const scrollPayloadPages = scroller();
    const reader = new RequestScopedFileFactsReader({ scrollPayloadPages });

    await reader.withinRequest(async () => {
      await reader.readIndexedFileImports("code_x");
      await reader.readFileMaintenanceSignals("code_x");
    });

    expect(scrollPayloadPages).toHaveBeenCalledTimes(1);
  });

  it("re-reads in the next review — a finished review's facts are never served again", async () => {
    const scrollPayloadPages = scroller();
    const reader = new RequestScopedFileFactsReader({ scrollPayloadPages });

    await reader.withinRequest(async () => reader.readIndexedFileImports("code_x"));
    await reader.withinRequest(async () => reader.readFileMaintenanceSignals("code_x"));

    expect(scrollPayloadPages).toHaveBeenCalledTimes(2);
  });

  it("keeps one scan per collection", async () => {
    const scrollPayloadPages = scroller();
    const reader = new RequestScopedFileFactsReader({ scrollPayloadPages });

    await reader.withinRequest(async () =>
      Promise.all([reader.readIndexedFileImports("code_x"), reader.readIndexedFileImports("code_y")]),
    );

    expect(scrollPayloadPages.mock.calls.map(([collection]) => collection)).toEqual(["code_x", "code_y"]);
  });

  it("drops the shared scans only when the last overlapping review ends", async () => {
    const scrollPayloadPages = scroller();
    const reader = new RequestScopedFileFactsReader({ scrollPayloadPages });
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = reader.withinRequest(async () => {
      await reader.readIndexedFileImports("code_x");
      await firstHeld;
    });
    await reader.withinRequest(async () => reader.readFileMaintenanceSignals("code_x"));
    releaseFirst();
    await first;
    await reader.withinRequest(async () => reader.readFileMaintenanceSignals("code_x"));

    expect(scrollPayloadPages).toHaveBeenCalledTimes(2);
  });

  it("ends the review window when the review throws", async () => {
    const scrollPayloadPages = scroller();
    const reader = new RequestScopedFileFactsReader({ scrollPayloadPages });

    await expect(
      reader.withinRequest(async () => {
        await reader.readIndexedFileImports("code_x");
        throw new Error("section failed");
      }),
    ).rejects.toThrow("section failed");
    await reader.withinRequest(async () => reader.readIndexedFileImports("code_x"));

    expect(scrollPayloadPages).toHaveBeenCalledTimes(2);
  });

  it("propagates a failed scroll to both consumers of the shared scan", async () => {
    const failure = new Error("qdrant down");
    const scrollPayloadPages = failingScroller(failure);
    const reader = new RequestScopedFileFactsReader({ scrollPayloadPages });

    const outcomes = await reader.withinRequest(async () =>
      Promise.allSettled([reader.readFileMaintenanceSignals("code_x"), reader.readIndexedFileImports("code_x")]),
    );

    expect(scrollPayloadPages).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
  });

  it("reads each fact through its own narrow scroll outside a review", async () => {
    const scrollPayloadPages = scroller();
    const reader = new RequestScopedFileFactsReader({ scrollPayloadPages });

    const signals = await reader.readFileMaintenanceSignals("code_x");
    const imports = await reader.readIndexedFileImports("code_x");

    expect(scrollPayloadPages).toHaveBeenCalledTimes(2);
    expect(scrollPayloadPages.mock.calls[0][1]).toEqual([
      "relativePath",
      "git.file.commitCount",
      "git.file.bugFixRate",
      "git.file.ageDays",
    ]);
    expect(scrollPayloadPages.mock.calls[1][1]).toEqual([
      "relativePath",
      "imports",
      "isTest",
      "codegraph.symbols.file.skippedAs",
    ]);
    expect(signals.size).toBe(3);
    expect(imports.size).toBe(3);
  });
});
