import { describe, expect, it } from "vitest";

import {
  renderChangelogSection,
  renderReleaseNotes,
  spliceVersionSection,
} from "../../scripts/lib/render-changelog.js";

const DATA = {
  version: "1.30.0",
  date: "2026-06-06",
  compareUrl: "https://github.com/artk0de/TeaRAGs-MCP/compare/v1.29.0...v1.30.0",
  repoUrl: "https://github.com/artk0de/TeaRAGs-MCP",
  groups: [
    {
      domain: "explore",
      items: [
        {
          description: "rerank presets resolve adaptive bounds per query",
          commits: ["abc1234", "def5678"],
        },
        {
          kind: "fix",
          description: "preserve codegraph section in find_symbol outline",
          commits: ["ae55b29"],
        },
      ],
    },
  ],
  // allCommits carries everything (incl. refactor) — only the spoiler shows them.
  allCommits: [
    { hash: "abc1234", subject: "feat(explore): adaptive bounds per query" },
    { hash: "ae55b29", subject: "fix(explore): preserve codegraph section" },
    { hash: "aaa1111", subject: "refactor(explore): move helper" },
  ],
};

describe("renderChangelogSection", () => {
  it("emits version header with compare link and date", () => {
    expect(renderChangelogSection(DATA)).toContain(
      "## [1.30.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.29.0...v1.30.0) (2026-06-06)",
    );
  });

  it("renders feat items without a prefix", () => {
    expect(renderChangelogSection(DATA)).toContain(
      "* rerank presets resolve adaptive bounds per query ([abc1234](https://github.com/artk0de/TeaRAGs-MCP/commit/abc1234), [def5678](https://github.com/artk0de/TeaRAGs-MCP/commit/def5678))",
    );
  });

  it("marks fix items with a `fix:` prefix", () => {
    expect(renderChangelogSection(DATA)).toContain(
      "* fix: preserve codegraph section in find_symbol outline ([ae55b29](https://github.com/artk0de/TeaRAGs-MCP/commit/ae55b29))",
    );
  });

  it("never renders the full commit list nor refactor commits in the changelog", () => {
    const out = renderChangelogSection(DATA);
    expect(out).not.toContain("<details>");
    expect(out).not.toContain("refactor(explore): move helper");
  });
});

describe("renderReleaseNotes", () => {
  it("ALWAYS includes the version header with date", () => {
    expect(renderReleaseNotes(DATA)).toContain(
      "## [1.30.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.29.0...v1.30.0) (2026-06-06)",
    );
  });

  it("renders the same declarative groups as the changelog, fix marked", () => {
    const out = renderReleaseNotes(DATA);
    expect(out).toContain("### explore");
    expect(out).toContain("* fix: preserve codegraph section in find_symbol outline");
  });

  it("wraps the full commit list (incl. refactor) in a Full Commits spoiler", () => {
    const out = renderReleaseNotes(DATA);
    expect(out).toContain("<details>");
    expect(out).toContain("<summary>Full Commits</summary>");
    expect(out).toContain("- abc1234 feat(explore): adaptive bounds per query");
    expect(out).toContain("- aaa1111 refactor(explore): move helper");
  });
});

describe("spliceVersionSection", () => {
  const CHANGELOG = [
    "## [1.30.0](url-c) (2026-06-06)",
    "",
    "### Features",
    "",
    "* old conventional line ([x](y))",
    "",
    "## [1.29.0](url-b) (2026-06-05)",
    "",
    "### Features",
    "",
    "* prior version stays",
  ].join("\n");

  it("replaces only the matching version block, leaves older versions intact", () => {
    const newSection = "## [1.30.0](url-c) (2026-06-06)\n\n### explore\n\n* declarative ([abc1234](z))\n";
    const out = spliceVersionSection(CHANGELOG, "1.30.0", newSection);
    expect(out).toContain("### explore");
    expect(out).not.toContain("old conventional line");
    expect(out).toContain("## [1.29.0](url-b) (2026-06-05)");
    expect(out).toContain("* prior version stays");
  });

  it("prepends when the version is not yet present", () => {
    const newSection = "## [2.0.0](url-d) (2026-07-01)\n\n### api\n\n* new ([zzz9999](z))\n";
    const out = spliceVersionSection(CHANGELOG, "2.0.0", newSection);
    expect(out.indexOf("## [2.0.0]")).toBeLessThan(out.indexOf("## [1.30.0]"));
  });
});
