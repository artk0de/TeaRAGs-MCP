import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { selectBlogPostPaths } from "../../scripts/blog-posts-to-json.js";
import { collectBlogPostLinks, parseBlogPostLink } from "../../scripts/lib/blog-post.js";

const SCRIPT_PATH = join(process.cwd(), "scripts", "blog-posts-to-json.js");
const SITE = "https://artk0de.github.io/TeaRAGs-MCP";

function post(frontmatter: string[], body: string): string {
  return ["---", ...frontmatter, "---", "", body].join("\n");
}

describe("parseBlogPostLink — slug", () => {
  it("takes the slug from frontmatter when the post declares one", () => {
    const src = post(["slug: why-ranking-moved", "title: Why ranking moved"], "Lead.\n\n<!-- truncate -->");
    expect(parseBlogPostLink("2026-08-19-something-else-entirely.md", src).slug).toBe("why-ranking-moved");
  });

  it("derives the slug from the filename minus the date prefix when frontmatter has none", () => {
    const src = post(["title: Why ranking moved"], "Lead.\n\n<!-- truncate -->");
    expect(parseBlogPostLink("2026-08-19-why-ranking-moved.md", src).slug).toBe("why-ranking-moved");
  });

  it("falls back to the bare filename when there is no date prefix either", () => {
    const src = post(["title: Untitled"], "Lead.");
    expect(parseBlogPostLink("stray-post.mdx", src).slug).toBe("stray-post");
  });

  it("builds the published url from the slug", () => {
    const src = post(["slug: why-ranking-moved", "title: Why ranking moved"], "Lead.");
    expect(parseBlogPostLink("2026-08-19-why-ranking-moved.md", src).url).toBe(`${SITE}/blog/why-ranking-moved`);
  });
});

describe("parseBlogPostLink — title", () => {
  it("takes the title from frontmatter", () => {
    const src = post(["slug: s", "title: Why ranking moved"], "Lead.");
    expect(parseBlogPostLink("2026-08-19-s.md", src).title).toBe("Why ranking moved");
  });

  it("falls back to the slug when the post declares no title", () => {
    const src = post(["slug: why-ranking-moved"], "Lead.");
    expect(parseBlogPostLink("2026-08-19-why-ranking-moved.md", src).title).toBe("why-ranking-moved");
  });
});

describe("parseBlogPostLink — summary", () => {
  it("prefers the frontmatter description", () => {
    const src = post(
      ["slug: s", "title: T", "description: The one-sentence version."],
      "A much longer lead nobody should see.\n\n<!-- truncate -->",
    );
    expect(parseBlogPostLink("2026-08-19-s.md", src).summary).toBe("The one-sentence version.");
  });

  it("falls back to the lead above the truncate marker when there is no description", () => {
    const src = post(["slug: s", "title: T"], "The lead paragraph.\n\n<!-- truncate -->\n\n## Body\n\nNot the lead.");
    expect(parseBlogPostLink("2026-08-19-s.md", src).summary).toBe("The lead paragraph.");
  });

  it("collapses a multi-line lead into a single line", () => {
    const src = post(["slug: s", "title: T"], "The lead\nwraps across\n\nthree lines.\n\n<!-- truncate -->");
    expect(parseBlogPostLink("2026-08-19-s.md", src).summary).toBe("The lead wraps across three lines.");
  });

  it("flattens inline markdown links to their text (a site-relative href 404s on github.com)", () => {
    const src = post(["slug: s", "title: T"], "The [changelog](/changelog) says what shipped.\n\n<!-- truncate -->");
    expect(parseBlogPostLink("2026-08-19-s.md", src).summary).toBe("The changelog says what shipped.");
  });

  it("truncates a long lead on a word boundary and marks the cut with an ellipsis", () => {
    const lead = `${"alpha bravo charlie delta echo foxtrot golf hotel india juliett ".repeat(6)}end`;
    const { summary } = parseBlogPostLink(
      "2026-08-19-s.md",
      post(["slug: s", "title: T"], `${lead}\n\n<!-- truncate -->`),
    );
    expect(summary.length).toBeLessThanOrEqual(201);
    expect(summary.endsWith("…")).toBe(true);
    // cut on whitespace: the last word is whole, never a fragment
    expect(lead.split(" ")).toContain(summary.slice(0, -1).split(" ").at(-1));
  });

  it("does not leave punctuation stranded in front of the ellipsis", () => {
    // The cut lands right after a sentence-ending period, which would read
    // `…before and after.…` if the punctuation were kept.
    const lead = `${"alpha bravo charlie delta echo foxtrot golf hotel india juliett ".repeat(3)}kilo.  lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu.`;
    const { summary } = parseBlogPostLink(
      "2026-08-19-s.md",
      post(["slug: s", "title: T"], `${lead}\n\n<!-- truncate -->`),
    );
    expect(summary.endsWith("kilo…")).toBe(true);
  });

  it("leaves a short lead untouched — no ellipsis when nothing was cut", () => {
    const src = post(["slug: s", "title: T"], "Short enough.\n\n<!-- truncate -->");
    expect(parseBlogPostLink("2026-08-19-s.md", src).summary).toBe("Short enough.");
  });

  it("uses the whole body as the lead when the post carries no truncate marker", () => {
    const src = post(["slug: s", "title: T"], "All of it.");
    expect(parseBlogPostLink("2026-08-19-s.md", src).summary).toBe("All of it.");
  });
});

describe("collectBlogPostLinks", () => {
  const entries = [
    { filename: "2026-08-19-later.md", source: post(["slug: later", "title: Later", "description: B."], "x") },
    { filename: "2026-08-17-earlier.md", source: post(["slug: earlier", "title: Earlier", "description: A."], "x") },
  ];

  it("sorts posts oldest-first so a multi-post range reads chronologically", () => {
    expect(collectBlogPostLinks(entries).map((p) => p.slug)).toEqual(["earlier", "later"]);
  });

  it("emits exactly slug, title, summary and url per post", () => {
    expect(collectBlogPostLinks(entries)[0]).toEqual({
      slug: "earlier",
      title: "Earlier",
      summary: "A.",
      url: `${SITE}/blog/earlier`,
    });
  });

  it("returns an empty array for an empty range", () => {
    expect(collectBlogPostLinks([])).toEqual([]);
  });
});

describe("selectBlogPostPaths", () => {
  it("keeps markdown posts and drops the blog config files", () => {
    const raw = ["website/blog/2026-08-19-a.md", "website/blog/authors.yml", "website/blog/tags.yml"].join("\n");
    expect(selectBlogPostPaths(raw)).toEqual(["website/blog/2026-08-19-a.md"]);
  });

  it("keeps .mdx posts too", () => {
    expect(selectBlogPostPaths("website/blog/2026-08-19-a.mdx")).toEqual(["website/blog/2026-08-19-a.mdx"]);
  });

  it("drops `_`-prefixed Docusaurus partials", () => {
    const raw = ["website/blog/_snippet.md", "website/blog/2026-08-19-a.md"].join("\n");
    expect(selectBlogPostPaths(raw)).toEqual(["website/blog/2026-08-19-a.md"]);
  });

  it("ignores blank lines and surrounding whitespace", () => {
    expect(selectBlogPostPaths("\n  website/blog/2026-08-19-a.md  \n\n")).toEqual(["website/blog/2026-08-19-a.md"]);
  });

  it("returns nothing for an empty added-file list", () => {
    expect(selectBlogPostPaths("")).toEqual([]);
  });
});

describe("scripts/blog-posts-to-json stdin → stdout contract", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "blog-posts-"));
    mkdirSync(join(dir, "website", "blog"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function run(input: string): { stdout: string; exitCode: number } {
    const result = spawnSync("node", [SCRIPT_PATH], { cwd: dir, input, encoding: "utf8" });
    return { stdout: result.stdout ?? "", exitCode: result.status ?? 0 };
  }

  it("reads the added-file list from stdin and emits the post JSON on stdout", () => {
    writeFileSync(
      join(dir, "website", "blog", "2026-08-19-why-ranking-moved.md"),
      post(["slug: why-ranking-moved", "title: Why ranking moved"], "The lead.\n\n<!-- truncate -->"),
    );
    const { stdout, exitCode } = run("website/blog/2026-08-19-why-ranking-moved.md\n");
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual([
      {
        slug: "why-ranking-moved",
        title: "Why ranking moved",
        summary: "The lead.",
        url: `${SITE}/blog/why-ranking-moved`,
      },
    ]);
  });

  it("emits an empty array when the range added no posts", () => {
    const { stdout, exitCode } = run("website/blog/authors.yml\n");
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual([]);
  });

  it("emits an empty array for empty stdin", () => {
    const { stdout, exitCode } = run("");
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual([]);
  });
});
