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

describe("renderEnvChanges / envChanges section", () => {
  it("renders an Environment Variables section when envChanges present", () => {
    const data = {
      version: "1.40.0",
      date: "2026-06-29",
      compareUrl: "https://example/compare",
      groups: [],
      allCommits: [],
      envChanges: [{ name: "QDRANT_TURBO_QUANT", description: "Enable TurboQuant 8x", default: "true", change: "new" }],
    };
    const section = renderChangelogSection(data);
    expect(section).toContain("Environment Variables");
    expect(section).toContain("`QDRANT_TURBO_QUANT`");
    expect(section).toContain("Enable TurboQuant 8x");
    expect(section).toContain("`true`");
    expect(section).toContain("new");
  });

  it("omits the Environment Variables section when envChanges absent or empty", () => {
    const data = { version: "1.40.0", date: "2026-06-29", compareUrl: "u", groups: [], allCommits: [] };
    expect(renderChangelogSection(data)).not.toContain("Environment Variables");
  });

  it("renders envChanges in renderReleaseNotes too, before the Full Commits spoiler", () => {
    const data = {
      version: "1.40.0",
      date: "2026-06-29",
      compareUrl: "u",
      groups: [],
      allCommits: [],
      envChanges: [{ name: "QDRANT_LOW_MEMORY", description: "Force on-disk", default: "false", change: "new" }],
    };
    const notes = renderReleaseNotes(data, []);
    expect(notes).toContain("Environment Variables");
    expect(notes.indexOf("Environment Variables")).toBeLessThan(notes.indexOf("Full Commits"));
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
    expect(collectContributors(commits)).toEqual(["@artk0de (Arthur Korochansky)"]);
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

  it("renders a handle the release job resolved at run time for an unknown email", () => {
    const commits = [
      { hash: "aaa", subject: "fix: y", author: { name: "Alexander Logvinov", email: "avl@logvinov.com" }, body: "" },
    ];
    expect(collectContributors(commits, { "avl@logvinov.com": "incubus" })).toEqual(["@incubus (Alexander Logvinov)"]);
  });

  it("matches a resolved handle case-insensitively on the email", () => {
    const commits = [
      { hash: "aaa", subject: "fix: y", author: { name: "Alexander Logvinov", email: "AVL@Logvinov.com" }, body: "" },
    ];
    expect(collectContributors(commits, { "avl@logvinov.com": "incubus" })).toEqual(["@incubus (Alexander Logvinov)"]);
  });

  it("omits the parenthesised name when git only ever recorded the handle itself", () => {
    const commits = [
      { hash: "aaa", subject: "feat: x", author: { name: "artk0de", email: "art2rik.desperado@gmail.com" }, body: "" },
    ];
    expect(collectContributors(commits)).toEqual(["@artk0de"]);
  });

  // Measured on the live v1.43.1 release: GitHub builds its own Contributors
  // block (avatars, above Assets) from the BARE mentions in the notes. Spelling
  // the same handle as `[@incubus](https://github.com/incubus)` dropped incubus
  // out of that block entirely. A markdown link here is a regression, not a
  // polish pass.
  it("credits a bare mention so GitHub's own Contributors block picks the account up", () => {
    const commits = [
      { hash: "aaa", subject: "fix: y", author: { name: "Alexander Logvinov", email: "avl@logvinov.com" }, body: "" },
    ];
    const credit = collectContributors(commits, { "avl@logvinov.com": "incubus" })[0];
    expect(credit.startsWith("@incubus")).toBe(true);
    expect(credit).not.toContain("](https://github.com/");
  });

  it("keeps the plain name when no handle is known for the email", () => {
    const commits = [
      { hash: "aaa", subject: "fix: y", author: { name: "Alexander Logvinov", email: "avl@logvinov.com" }, body: "" },
    ];
    expect(collectContributors(commits, {})).toEqual(["Alexander Logvinov"]);
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

// ── Blog posts published in the release range ────────────────────────────────
// Posts are written BY HAND. Git is the source of truth for which ones belong
// to a release: a post ADDED inside the release's commit range is that
// release's article. scripts/blog-posts-to-json.js turns the range's added-file
// list into { slug, title, summary, url }; both artifacts render one line each
// directly under the version header.

const POSTS = [
  {
    slug: "why-ranking-moved",
    title: "Why ranking moved",
    summary: "One sentence about the post.",
    url: "https://artk0de.github.io/TeaRAGs-MCP/blog/why-ranking-moved",
  },
  {
    slug: "what-the-numbers-said",
    title: "What the numbers said",
    summary: "A second post in the same range.",
    url: "https://artk0de.github.io/TeaRAGs-MCP/blog/what-the-numbers-said",
  },
];

// Smallest release that still exercises header + one theme + the full-commits
// spoiler, so the no-posts baseline can be asserted byte-for-byte.
const MINI = {
  version: "1.41.0",
  date: "2026-08-19",
  compareUrl: "https://github.com/artk0de/TeaRAGs-MCP/compare/v1.40.0...v1.41.0",
  groups: [{ theme: "search", items: [{ description: "better ranking" }] }],
  allCommits: [{ hash: "abc1234", subject: "feat(explore): better ranking" }],
};

const MINI_SECTION = [
  "## [1.41.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.40.0...v1.41.0) (2026-08-19)",
  "",
  "### 🔎 Search & ranking",
  "",
  "* better ranking",
  "",
].join("\n");

const MINI_NOTES = [
  "## [1.41.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.40.0...v1.41.0) (2026-08-19)",
  "",
  "### 🔎 Search & ranking",
  "",
  "* better ranking",
  "",
  "<details>",
  "<summary>Full Commits</summary>",
  "",
  "- abc1234 feat(explore): better ranking",
  "",
  "</details>",
  "",
].join("\n");

describe("blog posts in the release range", () => {
  it("links each post with its summary in the changelog section", () => {
    expect(renderChangelogSection(MINI, { blogPosts: POSTS })).toContain(
      "📝 [Why ranking moved](https://artk0de.github.io/TeaRAGs-MCP/blog/why-ranking-moved) — One sentence about the post.",
    );
  });

  it("links each post with its summary in the GitHub release notes", () => {
    expect(renderReleaseNotes(MINI, [], { blogPosts: POSTS })).toContain(
      "📝 [Why ranking moved](https://artk0de.github.io/TeaRAGs-MCP/blog/why-ranking-moved) — One sentence about the post.",
    );
  });

  it("places the links directly under the version header and before the themed sections", () => {
    const artifacts = [
      renderChangelogSection(MINI, { blogPosts: POSTS }),
      renderReleaseNotes(MINI, [], { blogPosts: POSTS }),
    ];
    for (const out of artifacts) {
      expect(out.indexOf("## [1.41.0]")).toBeLessThan(out.indexOf("📝"));
      expect(out.indexOf("📝")).toBeLessThan(out.indexOf("### 🔎 Search & ranking"));
    }
  });

  it("renders one line per post, in the order given (oldest first)", () => {
    const lines = renderChangelogSection(MINI, { blogPosts: POSTS })
      .split("\n")
      .filter((l) => l.startsWith("📝"));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Why ranking moved");
    expect(lines[1]).toContain("What the numbers said");
  });

  it("links by ABSOLUTE url — CHANGELOG.md is read on github.com, where /blog 404s", () => {
    expect(renderChangelogSection(MINI, { blogPosts: POSTS })).not.toContain("](/blog/");
  });

  it("does not autolink a phantom account from an @-token in a summary", () => {
    const posts = [{ ...POSTS[0], summary: "credit to @nobody for the idea" }];
    const out = renderChangelogSection(MINI, { blogPosts: posts });
    expect(out).toContain("`@nobody`");
    expect(out).not.toContain("to @nobody for");
    expect(renderReleaseNotes(MINI, [], { blogPosts: posts })).toContain("`@nobody`");
  });

  it("renders NOTHING when the range added no posts — byte-identical to the baseline", () => {
    expect(renderChangelogSection(MINI, { blogPosts: [] })).toBe(MINI_SECTION);
    expect(renderReleaseNotes(MINI, [], { blogPosts: [] })).toBe(MINI_NOTES);
  });

  it("renders NOTHING when no posts are passed at all", () => {
    expect(renderChangelogSection(MINI)).toBe(MINI_SECTION);
    expect(renderReleaseNotes(MINI)).toBe(MINI_NOTES);
    expect(renderReleaseNotes(MINI, [])).toBe(MINI_NOTES);
  });

  it("keeps the rest of each artifact intact when posts ARE rendered", () => {
    const section = renderChangelogSection(MINI, { blogPosts: POSTS });
    expect(section).toContain("## [1.41.0]");
    expect(section).toContain("* better ranking");
    const notes = renderReleaseNotes(MINI, ["@artk0de"], { blogPosts: POSTS });
    expect(notes).toContain("<summary>Full Commits</summary>");
    expect(notes).toContain("@artk0de");
  });
});
