// scripts/blog-posts-to-json.js
// Reads the added-file list of a release's commit range from stdin —
// `git diff --diff-filter=A --name-only <range> -- website/blog` — and emits a
// JSON array of { slug, title, summary, url }, oldest post first.
//
// Git is the source of truth for which posts belong to a release: a post ADDED
// inside the range is that release's article. No frontmatter release tag, no
// manual mapping. Ranges that added no post emit `[]`, which renders nothing.
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { collectBlogPostLinks } from "./lib/blog-post.js";

// Only markdown files are posts. `authors.yml` / `tags.yml` are blog config and
// `_`-prefixed files are Docusaurus partials — same filter the README index
// applies in scripts/update-readme-blog-index.js.
export function selectBlogPostPaths(raw) {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((path) => /\.mdx?$/.test(path) && !basename(path).startsWith("_"));
}

// Paths are repo-relative (git emits them that way), so they resolve against
// the working directory the release workflow runs in. A path that no longer
// exists is skipped rather than fatal: retro-changelog.js replays historical
// ranges against the CURRENT tree, where a post added back then may since have
// been renamed or removed.
export function readBlogPosts(paths, cwd = process.cwd()) {
  const entries = [];
  for (const path of paths) {
    const absolute = resolve(cwd, path);
    if (!existsSync(absolute)) {
      console.error(`blog-posts-to-json: skipping ${path} (no longer on disk)`);
      continue;
    }
    entries.push({ filename: basename(path), source: readFileSync(absolute, "utf8") });
  }
  return collectBlogPostLinks(entries);
}

// CLI entry only when run directly (importing for tests must not read stdin).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const posts = readBlogPosts(selectBlogPostPaths(readFileSync(0, "utf8")));
  process.stdout.write(JSON.stringify(posts, null, 2));
}
