import { describe, expect, it } from "vitest";

import {
  BLOG_INDEX_END,
  BLOG_INDEX_START,
  parseBlogPost,
  renderBlogIndex,
  spliceBlogIndex,
} from "../../scripts/lib/blog-index.js";

const POST = [
  "---",
  "slug: release-v1-41-0",
  "title: TeaRAGs v1.41.0",
  "authors: [artk0de]",
  "tags: [release]",
  "date: 2026-08-19",
  "---",
  "",
  "Body text.",
  "",
  "<!-- truncate -->",
].join("\n");

describe("parseBlogPost", () => {
  it("reads title, slug and date from frontmatter", () => {
    expect(parseBlogPost("2026-08-19-release-v1-41-0.md", POST)).toEqual({
      title: "TeaRAGs v1.41.0",
      slug: "release-v1-41-0",
      date: "2026-08-19",
    });
  });

  it("falls back to the filename date prefix when the post omits date", () => {
    const src = ["---", "slug: why-this-blog-exists", "title: Why this blog exists", "---", "", "Body."].join("\n");
    expect(parseBlogPost("2026-08-19-why-this-blog-exists.md", src)).toEqual({
      title: "Why this blog exists",
      slug: "why-this-blog-exists",
      date: "2026-08-19",
    });
  });

  it("falls back to the filename-derived slug and uses it as the title when both are absent", () => {
    const src = ["---", "tags: [release]", "---", "", "Body."].join("\n");
    expect(parseBlogPost("2026-01-02-hello-world.md", src)).toEqual({
      title: "hello-world",
      slug: "hello-world",
      date: "2026-01-02",
    });
  });

  it("strips surrounding quotes from frontmatter values", () => {
    const src = ["---", 'slug: "quoted-slug"', "title: 'Quoted title'", "---", "", "Body."].join("\n");
    const post = parseBlogPost("2026-03-04-quoted-slug.md", src);
    expect(post.slug).toBe("quoted-slug");
    expect(post.title).toBe("Quoted title");
  });

  it("survives a file with no frontmatter at all", () => {
    expect(parseBlogPost("2026-05-06-no-frontmatter.md", "just a body\n")).toEqual({
      title: "no-frontmatter",
      slug: "no-frontmatter",
      date: "2026-05-06",
    });
  });
});

describe("renderBlogIndex", () => {
  const POSTS = [
    { title: "Oldest", slug: "oldest", date: "2026-01-01" },
    { title: "Newest", slug: "newest", date: "2026-08-19" },
    { title: "Middle", slug: "middle", date: "2026-04-04" },
  ];

  it("sorts newest first", () => {
    const out = renderBlogIndex(POSTS);
    expect(out.indexOf("Newest")).toBeLessThan(out.indexOf("Middle"));
    expect(out.indexOf("Middle")).toBeLessThan(out.indexOf("Oldest"));
  });

  it("links every post by absolute site url and shows its date", () => {
    expect(renderBlogIndex(POSTS)).toContain(
      "- [Newest — 2026-08-19](https://artk0de.github.io/TeaRAGs-MCP/blog/newest)",
    );
  });

  it("keeps at most `limit` posts, defaulting to 5", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      title: `Post ${i}`,
      slug: `post-${i}`,
      date: `2026-08-0${i + 1}`,
    }));
    expect(renderBlogIndex(many).split("\n").filter(Boolean)).toHaveLength(5);
    expect(renderBlogIndex(many, 2).split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("renders a placeholder rather than an empty block when there are no posts", () => {
    expect(renderBlogIndex([])).toContain("No posts yet");
  });
});

describe("spliceBlogIndex", () => {
  const README = [
    "## 📚 Documentation",
    "",
    "docs go here",
    "",
    "## 📝 From the blog",
    "",
    BLOG_INDEX_START,
    "",
    "- [Old — 2026-01-01](https://artk0de.github.io/TeaRAGs-MCP/blog/old)",
    "",
    BLOG_INDEX_END,
    "",
    "## 🤝 Contributing",
    "",
  ].join("\n");

  const BLOCK = "- [Newest — 2026-08-19](https://artk0de.github.io/TeaRAGs-MCP/blog/newest)";

  it("replaces the content between the markers", () => {
    const out = spliceBlogIndex(README, BLOCK);
    expect(out).toContain(BLOCK);
    expect(out).not.toContain("blog/old");
  });

  it("keeps everything outside the markers byte-identical", () => {
    const out = spliceBlogIndex(README, BLOCK);
    expect(out.startsWith("## 📚 Documentation\n\ndocs go here\n\n## 📝 From the blog\n")).toBe(true);
    expect(out.endsWith("\n## 🤝 Contributing\n")).toBe(true);
    expect(out).toContain(BLOG_INDEX_START);
    expect(out).toContain(BLOG_INDEX_END);
  });

  it("is idempotent — splicing the same block twice yields identical output", () => {
    const once = spliceBlogIndex(README, BLOCK);
    expect(spliceBlogIndex(once, BLOCK)).toBe(once);
  });

  it("throws a named error when a marker is missing", () => {
    expect(() => spliceBlogIndex("# README\n", BLOCK)).toThrow(/BLOG:START/);
    expect(() => spliceBlogIndex(`# README\n${BLOG_INDEX_START}\n`, BLOCK)).toThrow(/BLOG:END/);
  });

  it("throws when the markers are inverted", () => {
    const broken = `${BLOG_INDEX_END}\nstuff\n${BLOG_INDEX_START}\n`;
    expect(() => spliceBlogIndex(broken, BLOCK)).toThrow(/order/);
  });
});
