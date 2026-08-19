// scripts/lib/blog-index.js
// Pure renderers behind scripts/update-readme-blog-index.js: turn the files in
// website/blog/ into the "From the blog" block README.md keeps between markers.

const SITE_URL = "https://artk0de.github.io/TeaRAGs-MCP";

// Marker pair README.md carries. Everything between them is generated and is
// replaced wholesale on every run; everything outside is hand-written and is
// never touched.
export const BLOG_INDEX_START = "<!-- BLOG:START -->";
export const BLOG_INDEX_END = "<!-- BLOG:END -->";

const DEFAULT_LIMIT = 5;

// Docusaurus names blog files `YYYY-MM-DD-<slug>.md`.
const FILENAME_RE = /^(\d{4}-\d{2}-\d{2})-(.+?)\.mdx?$/;

// Deliberately dependency-free: the frontmatter this reads is written by
// renderReleaseBlogPost and by hand, so it is always flat `key: value` scalars.
// Pulling in a YAML parser for three fields would buy nothing and would put a
// runtime dependency in the path of a README refresh.
function parseFrontmatter(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (!match) return {};
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    // Quotes are the author's, not part of the value.
    fields[kv[1]] = kv[2].trim().replace(/^["'](.*)["']$/, "$1");
  }
  return fields;
}

// One post reduced to what the README block needs. Frontmatter wins; the
// filename is the fallback, because Docusaurus itself derives date and slug
// from it when a post omits them.
export function parseBlogPost(filename, source) {
  const fm = parseFrontmatter(source);
  const named = FILENAME_RE.exec(filename);
  const slug = fm.slug || (named ? named[2] : filename.replace(/\.mdx?$/, ""));
  return {
    title: fm.title || slug,
    slug,
    date: fm.date || (named ? named[1] : ""),
  };
}

// Newest first. The date is the sort key; the slug breaks ties so two posts
// dated the same day still order deterministically across machines.
function byNewest(a, b) {
  return b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug);
}

// The README list. Each item is a SINGLE link node with the date folded into
// the link text — prettier reflows `*.md` at 80 columns on commit and will
// break a line that has text trailing a long link, but it never breaks inside
// one. Keeping each item atomic makes the generated block a prettier fixed
// point, which is what keeps re-running the generator a no-op.
export function renderBlogIndex(posts, limit = DEFAULT_LIMIT) {
  if (posts.length === 0) return "_No posts yet._";
  return [...posts]
    .sort(byNewest)
    .slice(0, limit)
    .map((p) => `- [${p.title} — ${p.date}](${SITE_URL}/blog/${p.slug})`)
    .join("\n");
}

// Replace the generated block in README.md, leaving the markers and everything
// around them alone. Throws rather than guessing when the markers are missing
// or out of order — a silently skipped splice would leave a stale list nobody
// notices.
export function spliceBlogIndex(readme, block) {
  const start = readme.indexOf(BLOG_INDEX_START);
  const end = readme.indexOf(BLOG_INDEX_END);
  if (start === -1) throw new Error(`README.md is missing the ${BLOG_INDEX_START} marker`);
  if (end === -1) throw new Error(`README.md is missing the ${BLOG_INDEX_END} marker`);
  if (end < start) throw new Error(`README.md has ${BLOG_INDEX_START} / ${BLOG_INDEX_END} in the wrong order`);
  const head = readme.slice(0, start + BLOG_INDEX_START.length);
  const tail = readme.slice(end);
  return `${head}\n\n${block}\n\n${tail}`;
}
