// scripts/lib/blog-post.js
// One hand-written post in website/blog/, parsed. The shared primitive behind
// two consumers that both need to say "this post, at this url": the README
// index (lib/blog-index.js) and the release changelog's article links
// (blog-posts-to-json.js → lib/render-changelog.js).

// Published docs site. Posts are linked by ABSOLUTE url because both consumers
// are read on github.com too, where a site-relative `/blog/...` path resolves
// against github.com and 404s.
export const SITE_URL = "https://artk0de.github.io/TeaRAGs-MCP";

export function blogPostUrl(slug) {
  return `${SITE_URL}/blog/${slug}`;
}

// Docusaurus names blog files `YYYY-MM-DD-<slug>.md`.
export const BLOG_FILENAME_RE = /^(\d{4}-\d{2}-\d{2})-(.+?)\.mdx?$/;

// A summary longer than this stops being a summary. Cut on a word boundary.
const SUMMARY_MAX = 200;

// Deliberately dependency-free: the frontmatter this reads is hand-written and
// is always flat `key: value` scalars. Pulling in a YAML parser for four fields
// would buy nothing and would put a runtime dependency in the path of a README
// refresh and a release build.
export function parseFrontmatter(source) {
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

// Frontmatter wins; the filename is the fallback, because Docusaurus itself
// derives date and slug from it when a post omits them.
export function blogPostSlug(filename, fm) {
  const named = BLOG_FILENAME_RE.exec(filename);
  return fm.slug || (named ? named[2] : filename.replace(/\.mdx?$/, ""));
}

export function blogPostDate(filename, fm) {
  const named = BLOG_FILENAME_RE.exec(filename);
  return fm.date || (named ? named[1] : "");
}

// Inline links flattened to their text. A lead sentence routinely carries a
// site-relative link (`[changelog](/changelog)`), which is correct inside the
// site and a 404 in the GitHub release notes — and the summary is prose, not a
// link carrier. `!` covers images, so an embed degrades to its alt text.
function flattenLinks(text) {
  return text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");
}

function collapse(text) {
  return flattenLinks(text).replace(/\s+/g, " ").trim();
}

// Cut on the last word boundary inside the budget, then drop whatever
// punctuation the cut left dangling — a lead truncated just past a sentence end
// would otherwise read `…before and after.…`.
function truncate(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const boundary = cut.lastIndexOf(" ");
  const head = boundary > 0 ? cut.slice(0, boundary) : cut;
  return `${head.replace(/[\s.,;:!?…—–-]+$/, "")}…`;
}

// Docusaurus's own excerpt semantics: the frontmatter `description` is the
// post's summary when the author wrote one, and the prose above
// `<!-- truncate -->` is the excerpt otherwise. A description is authored short
// and is taken as-is; a lead is arbitrary prose, so it gets collapsed onto one
// line and cut to a length that reads as a summary.
export function blogPostSummary(source, fm) {
  if (fm.description) return collapse(fm.description);
  const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  return truncate(collapse(body.split(/<!--\s*truncate\s*-->/)[0]), SUMMARY_MAX);
}

// One post reduced to what a changelog link needs. `date` rides along for
// ordering only — collectBlogPostLinks drops it before it reaches an artifact.
export function parseBlogPostLink(filename, source) {
  const fm = parseFrontmatter(source);
  const slug = blogPostSlug(filename, fm);
  return {
    slug,
    title: fm.title || slug,
    summary: blogPostSummary(source, fm),
    url: blogPostUrl(slug),
    date: blogPostDate(filename, fm),
  };
}

// Oldest first, so a release range containing several posts reads
// chronologically. The slug breaks ties so two posts dated the same day still
// order deterministically across machines.
function byOldest(a, b) {
  return a.date.localeCompare(b.date) || a.slug.localeCompare(b.slug);
}

// `entries` is [{ filename, source }] — the caller owns the disk reads.
export function collectBlogPostLinks(entries) {
  return entries
    .map(({ filename, source }) => parseBlogPostLink(filename, source))
    .sort(byOldest)
    .map(({ slug, title, summary, url }) => ({ slug, title, summary, url }));
}
