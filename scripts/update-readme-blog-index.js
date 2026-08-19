// scripts/update-readme-blog-index.js
// Refreshes the "From the blog" list in README.md from website/blog/.
// Run by hand (`npm run docs:blog-index`) and by the release workflow right
// after it writes the release post, so the newest release leads the list.
// All logic lives in scripts/lib/blog-index.js (unit-tested); this is thin
// orchestration only.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseBlogPost, renderBlogIndex, spliceBlogIndex } from "./lib/blog-index.js";

// Resolve from the script, not the cwd: the workflow, npm and a shell all
// invoke this from different places.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const blogDir = join(root, "website", "blog");
const readmePath = join(root, "README.md");

// `_`-prefixed files are Docusaurus partials, not published posts; authors.yml
// and tags.yml are config, hence the markdown-only filter.
const files = readdirSync(blogDir).filter((f) => /\.mdx?$/.test(f) && !f.startsWith("_"));
const posts = files.map((f) => parseBlogPost(f, readFileSync(join(blogDir, f), "utf8")));

try {
  const readme = readFileSync(readmePath, "utf8");
  writeFileSync(readmePath, spliceBlogIndex(readme, renderBlogIndex(posts)));
} catch (err) {
  console.error(`update-readme-blog-index failed: ${err.message}`);
  process.exit(1);
}

console.error(`README blog index updated from ${posts.length} post(s)`);
