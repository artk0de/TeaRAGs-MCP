/**
 * One list of the files a review did not judge (bd tea-rags-mcp-56fax): every
 * section used to carry its own `{relPath, reason}` list, and the same unjudged
 * files (docs, configs, tests) repeated once per section — 27% of a measured
 * review answer. The review block lists each file once, grouped by the
 * sections' reasons; a section keeps only its count, so no fact is lost.
 */
import { describe, expect, it } from "vitest";

import { hoistNotJudgedFiles } from "../../../../../src/core/api/internal/ops/review-not-judged-files.js";
import type { ReviewSectionId, ReviewSectionResult } from "../../../../../src/core/api/public/dto/review.js";

type Sections = Partial<Record<ReviewSectionId, ReviewSectionResult>>;

describe("hoistNotJudgedFiles", () => {
  it("lists a file every section skipped once, with each section's reason", () => {
    const sections = {
      cohesion: { built: true, notJudged: [{ relPath: "README.md", reason: "noCohesionData" }] },
      architecture: { built: true, notJudged: [{ relPath: "README.md", reason: "unsupportedLanguage" }] },
    } as unknown as Sections;

    const hoisted = hoistNotJudgedFiles(sections);

    expect(hoisted.notJudged).toEqual([
      { reasons: { cohesion: "noCohesionData", architecture: "unsupportedLanguage" }, relPaths: ["README.md"] },
    ]);
    expect(hoisted.sections.cohesion).toEqual({ built: true, notJudged: 1 });
    expect(hoisted.sections.architecture).toEqual({ built: true, notJudged: 1 });
  });

  it("groups files the sections skipped for the same reasons, first-seen order", () => {
    const sections = {
      cohesion: {
        built: true,
        notJudged: [
          { relPath: "a.md", reason: "noCohesionData" },
          { relPath: "b.ts", reason: "noCohesionData" },
          { relPath: "c.md", reason: "noCohesionData" },
        ],
      },
      architecture: {
        built: true,
        notJudged: [
          { relPath: "a.md", reason: "unsupportedLanguage" },
          { relPath: "c.md", reason: "unsupportedLanguage" },
        ],
      },
    } as unknown as Sections;

    expect(hoistNotJudgedFiles(sections).notJudged).toEqual([
      { reasons: { cohesion: "noCohesionData", architecture: "unsupportedLanguage" }, relPaths: ["a.md", "c.md"] },
      { reasons: { cohesion: "noCohesionData" }, relPaths: ["b.ts"] },
    ]);
  });

  it("keeps an entry's detail under its section", () => {
    const sections = {
      norms: { built: true, notJudged: [{ relPath: "a.rb", reason: "parseFailed", detail: "line 3" }] },
    } as unknown as Sections;

    expect(hoistNotJudgedFiles(sections).notJudged).toEqual([
      { reasons: { norms: "parseFailed" }, details: { norms: "line 3" }, relPaths: ["a.rb"] },
    ]);
  });

  it("moves naming's file entries out of notJudgedNames, leaving its counts", () => {
    const sections = {
      naming: {
        built: true,
        notJudged: 1,
        notJudgedBy: { file: { nonProduction: 1 } },
        notJudgedNames: [{ relPath: "a.test.ts", kind: "file", reason: "nonProduction" }],
      },
      cohesion: { built: true, notJudged: [{ relPath: "a.test.ts", reason: "noCohesionData" }] },
    } as unknown as Sections;

    const hoisted = hoistNotJudgedFiles(sections);

    expect(hoisted.notJudged).toEqual([
      { reasons: { naming: "nonProduction", cohesion: "noCohesionData" }, relPaths: ["a.test.ts"] },
    ]);
    expect(hoisted.sections.naming).toEqual({ built: true, notJudged: 1, notJudgedBy: { file: { nonProduction: 1 } } });
  });

  it("answers no list when no section skipped a file, and leaves sections untouched", () => {
    const sections = { cohesion: { built: true, reports: [] } } as unknown as Sections;

    const hoisted = hoistNotJudgedFiles(sections);

    expect(hoisted.notJudged).toBeUndefined();
    expect(hoisted.sections).toEqual(sections);
  });
});
