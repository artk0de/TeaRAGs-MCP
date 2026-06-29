import { describe, expect, it } from "vitest";

import {
  collectContributors,
  escapeMentions,
  renderChangelogSection,
  renderReleaseNotes,
  spliceVersionSection,
} from "../../scripts/lib/render-changelog.js";

// Themes are intentionally NOT in canonical order (workflow, search, fixes,
// codeIntel) so the rendering-order tests prove the renderer re-sorts by the
// fixed taxonomy rather than echoing array order. `indexing` and `language` are
// absent so the empty-theme-omission tests have something to assert against.
const DATA = {
  version: "1.30.0",
  date: "2026-06-06",
  compareUrl: "https://github.com/artk0de/TeaRAGs-MCP/compare/v1.29.0...v1.30.0",
  repoUrl: "https://github.com/artk0de/TeaRAGs-MCP",
  groups: [
    {
      theme: "workflow",
      items: [{ description: "manage git worktrees from the CLI and MCP", commits: ["c7a0125", "2239d32"] }],
    },
    {
      theme: "search",
      items: [{ description: "rerank presets resolve adaptive bounds per query", commits: ["abc1234", "def5678"] }],
    },
    {
      theme: "fixes",
      items: [{ description: "gitignore whitelists descend into subdirectories", commits: ["90d8bd8"] }],
    },
    {
      theme: "codeIntel",
      items: [
        {
          description: "Ruby call-graph navigation returns complete results through chained calls",
          commits: ["20d6d31", "a913793"],
        },
      ],
    },
  ],
  // allCommits carries everything (incl. refactor) — only the spoiler shows them.
  allCommits: [
    { hash: "abc1234", subject: "feat(explore): adaptive bounds per query" },
    { hash: "90d8bd8", subject: "fix(ingest): gitignore whitelist subdirs" },
    { hash: "aaa1111", subject: "refactor(explore): move helper" },
  ],
};

describe("renderChangelogSection", () => {
  it("emits version header with compare link and date", () => {
    expect(renderChangelogSection(DATA)).toContain(
      "## [1.30.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.29.0...v1.30.0) (2026-06-06)",
    );
  });

  it("renders product theme headings with emoji and label", () => {
    const out = renderChangelogSection(DATA);
    expect(out).toContain("### 🔎 Search & ranking");
    expect(out).toContain("### 🧠 Code intelligence");
    expect(out).toContain("### 🛠 CLI & workflow");
    expect(out).toContain("### 🩹 Fixes");
  });

  it("orders themes by the fixed taxonomy, not by array order", () => {
    const out = renderChangelogSection(DATA);
    expect(out.indexOf("🔎 Search & ranking")).toBeLessThan(out.indexOf("🧠 Code intelligence"));
    expect(out.indexOf("🧠 Code intelligence")).toBeLessThan(out.indexOf("🛠 CLI & workflow"));
    expect(out.indexOf("🛠 CLI & workflow")).toBeLessThan(out.indexOf("🩹 Fixes"));
  });

  it("omits themes that have no items", () => {
    const out = renderChangelogSection(DATA);
    expect(out).not.toContain("Indexing & performance");
    expect(out).not.toContain("Language support");
  });

  it("renders items as plain benefit bullets without inline hash links", () => {
    const out = renderChangelogSection(DATA);
    expect(out).toContain("* rerank presets resolve adaptive bounds per query");
    expect(out).not.toContain("/commit/");
    expect(out).not.toContain("([abc1234]");
  });

  it("does not prefix fix items (Fixes is its own section)", () => {
    expect(renderChangelogSection(DATA)).not.toContain("* fix:");
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

  it("renders the same product theme headings as the changelog", () => {
    const out = renderReleaseNotes(DATA);
    expect(out).toContain("### 🔎 Search & ranking");
    expect(out).toContain("### 🩹 Fixes");
  });

  it("renders clean benefit bullets without a fix prefix", () => {
    const out = renderReleaseNotes(DATA);
    expect(out).not.toContain("* fix:");
    expect(out).toContain("* gitignore whitelists descend into subdirectories");
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

  it("prepends a higher version not yet present", () => {
    const newSection = "## [2.0.0](url-d) (2026-07-01)\n\n### api\n\n* new ([zzz9999](z))\n";
    const out = spliceVersionSection(CHANGELOG, "2.0.0", newSection);
    expect(out.indexOf("## [2.0.0]")).toBeLessThan(out.indexOf("## [1.30.0]"));
  });

  it("inserts an absent middle version in descending-semver order", () => {
    // CHANGELOG has 1.30.0 then 1.29.0; insert absent 1.29.5 between them.
    const newSection = "## [1.29.5](url-e) (2026-06-05)\n\n### api\n\n* mid ([mmm5555](z))\n";
    const out = spliceVersionSection(CHANGELOG, "1.29.5", newSection);
    expect(out.indexOf("## [1.30.0]")).toBeLessThan(out.indexOf("## [1.29.5]"));
    expect(out.indexOf("## [1.29.5]")).toBeLessThan(out.indexOf("## [1.29.0]"));
  });
});

describe("escapeMentions", () => {
  it("wraps bare @-tokens in backticks so GitHub does not autolink them", () => {
    const out = escapeMentions("exotic YARD tags (@type/@option/@return)");
    expect(out).toContain("`@type`");
    expect(out).toContain("`@option`");
    expect(out).toContain("`@return`");
    // the raw, autolinkable form is gone
    expect(out).not.toContain("(@type/@option/@return)");
  });

  it("escapes YARD @!attribute tags", () => {
    expect(escapeMentions("@!attribute owner")).toContain("`@!attribute`");
  });

  it("leaves email addresses untouched (lookbehind guard)", () => {
    const out = escapeMentions("reach me at a@b.com today");
    expect(out).toContain("a@b.com");
    expect(out).not.toContain("`@b`");
  });
});

describe("collectContributors", () => {
  it("dedupes authors by email and renders the mapped handle", () => {
    const commits = [
      { hash: "aaa", subject: "feat: x", author: { name: "artk0de", email: "art2rik.desperado@gmail.com" }, body: "" },
      {
        hash: "bbb",
        subject: "fix: y",
        author: { name: "Arthur Korochansky", email: "art2rik.desperado@gmail.com" },
        body: "",
      },
    ];
    expect(collectContributors(commits)).toEqual(["@artk0de"]);
  });

  it("excludes CI bots and AI co-authors", () => {
    const commits = [
      {
        hash: "aaa",
        subject: "feat: x",
        author: { name: "artk0de", email: "art2rik.desperado@gmail.com" },
        body: "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>",
      },
      {
        hash: "rel",
        subject: "chore(release): v1",
        author: { name: "semantic-release-bot", email: "semantic-release-bot@martynus.net" },
        body: "",
      },
      { hash: "bot", subject: "chore: changelog", author: { name: "tea-rags-bot", email: "bot@tea-rags" }, body: "" },
    ];
    expect(collectContributors(commits)).toEqual(["@artk0de"]);
  });

  it("includes human co-authors, mapping known emails and falling back to plain name", () => {
    const commits = [
      {
        hash: "aaa",
        subject: "feat: x",
        author: { name: "artk0de", email: "art2rik.desperado@gmail.com" },
        body: "Co-Authored-By: Jane Doe <jane@example.com>",
      },
    ];
    expect(collectContributors(commits)).toEqual(["@artk0de", "Jane Doe"]);
  });
});

describe("renderReleaseNotes — contributors", () => {
  it("renders a Contributors section when contributors are provided", () => {
    const out = renderReleaseNotes(DATA, ["@artk0de"]);
    expect(out).toContain("### 👥 Contributors");
    expect(out).toContain("@artk0de");
    // a real mention, not escaped into code
    expect(out).not.toContain("`@artk0de`");
  });

  it("omits the Contributors section when none are provided", () => {
    expect(renderReleaseNotes(DATA)).not.toContain("Contributors");
  });

  it("escapes @-tokens in Full Commits subjects so they are not autolinked", () => {
    const data = {
      ...DATA,
      allCommits: [{ hash: "ddd4444", subject: "feat(trajectory): exotic YARD tags (@type/@option)" }],
    };
    const out = renderReleaseNotes(data);
    expect(out).toContain("`@type`");
    expect(out).toContain("`@option`");
    expect(out).not.toContain("(@type/@option)");
  });
});
