// scripts/lib/render-changelog.js
// Pure renderers consumed by build-changelog-artifacts.js and retro-changelog.js.
// One JSON source (release-notes.json) → three divergent markdown artifacts:
// the GitHub release notes, the CHANGELOG.md section, and a Docusaurus blog post.

// Fixed product-theme taxonomy. The order here IS the render order; a theme with
// no items in a release is skipped. Keys match release-notes.json
// `groups[].theme`. The agent groups commits by user-facing capability (not by
// internal module), so headings read as product surfaces, not code domains.
// `name` is the same surface written as running prose (the blog lead sentence
// enumerates the themes a release touched); it lives next to `label` so the two
// spellings of one theme can never drift apart.
const THEMES = [
  { key: "search", label: "🔎 Search & ranking", name: "search & ranking" },
  { key: "codeIntel", label: "🧠 Code intelligence", name: "code intelligence" },
  { key: "indexing", label: "⚡ Indexing & performance", name: "indexing & performance" },
  { key: "language", label: "🗣 Language support", name: "language support" },
  { key: "workflow", label: "🛠 CLI & workflow", name: "CLI & workflow" },
  { key: "fixes", label: "🩹 Fixes", name: "fixes" },
];

// Published docs site. Both GitHub-facing artifacts link the blog post by
// ABSOLUTE url: CHANGELOG.md is read on github.com too, where a site-relative
// `/blog/...` path resolves against github.com and 404s.
const SITE_URL = "https://artk0de.github.io/TeaRAGs-MCP";

// Email → GitHub handle for known contributors. Git author NAME varies across
// machines (`artk0de` / `Arthur Korochansky`) but the EMAIL is stable, so the
// email is the join key. Maps to the account whose avatar should surface in the
// GitHub release Contributors block.
const CONTRIBUTOR_HANDLES = {
  "art2rik.desperado@gmail.com": "artk0de",
};

// CI bots and AI co-authors are not human contributors — keep them out of the
// Contributors credit (and out of the release avatar block).
const NON_HUMAN_EMAILS = new Set(["bot@tea-rags", "semantic-release-bot@martynus.net", "noreply@anthropic.com"]);

// GitHub Flavored Markdown autolinks any bare `@name` outside inline code into a
// user mention — so YARD/JSDoc tags in commit subjects (`@type`, `@option`,
// `@return`, `@!attribute`) drag phantom accounts into the release Contributors
// block. Wrap each `@`-token in backticks (semantically correct: it IS a tag).
// The `(?<!\w)` lookbehind skips the `@` inside an email address (`a@b.com`).
export function escapeMentions(text) {
  return text.replace(/(?<!\w)@!?[A-Za-z][\w-]*/g, "`$&`");
}

// MDX 3 parses `{ identifier }` in free text as a JSX expression and `<Foo>` as
// a component, so a commit message carrying a destructuring pattern or a generic
// type argument breaks the site build. HTML entities render as plain text and
// bypass the expression parser entirely. Same substitution scripts/prepare-
// changelog.sh applies to CHANGELOG.md on its way to the website — applied here
// per untrusted string instead of per file, so the structural markdown this
// module emits (the `<!-- truncate -->` marker above all) survives untouched.
export function escapeMdx(text) {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\{/g, "&#123;").replace(/\}/g, "&#125;");
}

// The two escaping policies for commit-derived prose. GitHub renders markdown,
// so it only needs mention escaping; the blog post is compiled by MDX and needs
// both. Renderers take one of these so a single body renderer serves all three
// artifacts.
const githubText = (text) => escapeMentions(text);
const mdxText = (text) => escapeMdx(escapeMentions(text));

// Co-authored-by trailers in a commit body, parsed to { name, email }.
function parseCoAuthors(body) {
  const out = [];
  const re = /co-authored-by:\s*(.+?)\s*<(.+?)>/gi;
  for (let m = re.exec(body); m !== null; m = re.exec(body)) {
    out.push({ name: m[1].trim(), email: m[2].trim() });
  }
  return out;
}

// Real human contributors for a release range, in first-seen order: every commit
// author plus co-authored-by humans, minus CI bots and AI co-authors. Known
// emails render as `@handle` mentions (avatar in the release block); unknown
// humans render as their plain name — never a broken `@mention`.
export function collectContributors(commits) {
  const seen = new Set();
  const out = [];
  const add = (person) => {
    const email = (person.email || "").toLowerCase();
    if (NON_HUMAN_EMAILS.has(email) || seen.has(email)) return;
    seen.add(email);
    const handle = CONTRIBUTOR_HANDLES[email];
    out.push(handle ? `@${handle}` : person.name);
  };
  for (const c of commits) {
    if (c.author) add(c.author);
    for (const co of parseCoAuthors(c.body || "")) add(co);
  }
  return out;
}

// Product bullets are benefit-framed prose with no inline hash links — full
// per-commit traceability lives in the Full Commits spoiler (GitHub release) and
// the compareUrl version header (CHANGELOG). Fixes are their own theme, so no
// per-item `fix:` prefix. `@`-tokens are escaped so a YARD tag in a description
// can't autolink into a phantom mention.
function renderItem(it, esc) {
  return `* ${esc(it.description)}`;
}

// Themes present in this release, in taxonomy order — the shared shape behind
// every artifact's body.
function presentThemes(data) {
  const byTheme = new Map((data.groups || []).map((g) => [g.theme, g]));
  return THEMES.filter((t) => byTheme.has(t.key) && byTheme.get(t.key).items.length > 0).map((t) => ({
    ...t,
    items: byTheme.get(t.key).items,
  }));
}

// Render only the themes present in this release, always in taxonomy order.
function renderGroups(data, esc = githubText) {
  return presentThemes(data)
    .map((t) => `### ${t.label}\n\n${t.items.map((it) => renderItem(it, esc)).join("\n")}`)
    .join("\n\n");
}

// Environment-variable additions/changes for this release. Surfaced on BOTH
// artifacts so a user upgrading sees every new/changed knob with its default.
// `change` is "new" | "changed". Empty/absent → no section.
function renderEnvChanges(data, esc = githubText) {
  const envs = data.envChanges || [];
  if (envs.length === 0) return "";
  const rows = envs
    // Only the description is free prose: name and default sit inside code
    // spans, which MDX treats as literal text, and `change` is a fixed enum.
    .map((e) => `* \`${e.name}\` · ${esc(e.description)} · default: \`${e.default}\` (${e.change})`)
    .join("\n");
  return `### 🔧 Environment Variables\n\n${rows}`;
}

// Version header carries the release date — required on BOTH artifacts.
function versionHeader(data) {
  return `## [${data.version}](${data.compareUrl}) (${data.date})`;
}

// Blog slug for a release. Dots are illegal in a clean url segment, so the
// version is dash-separated: 1.41.0 → release-v1-41-0.
export function blogPostSlug(version) {
  return `release-v${version.replace(/\./g, "-")}`;
}

// Docusaurus derives a post's date from a `YYYY-MM-DD-` filename prefix; the
// frontmatter `date` restates it, but the prefix is what keeps `website/blog/`
// sorted and readable on disk.
export function blogPostFilename(data) {
  return `${data.date}-${blogPostSlug(data.version)}.md`;
}

export function blogPostUrl(version) {
  return `${SITE_URL}/blog/${blogPostSlug(version)}`;
}

// Both GitHub-facing artifacts point at the post the same release produced —
// but only when there IS one. retro-changelog.js rebuilds sections for tags cut
// long before the blog existed, and a link to a post that was never written is
// a 404 in the changelog. The caller knows whether the post exists; it says so
// through `blogPostPublished`, which defaults to the live release path where
// build-changelog-artifacts.js writes the post in the same run.
function blogBackLink(data, blogPostPublished) {
  return blogPostPublished ? `📝 [Read the release post](${blogPostUrl(data.version)})\n\n` : "";
}

// CHANGELOG.md / website: header + product themes only. No inline hash links, no
// full commit list — release-level traceability via the compareUrl in the header.
export function renderChangelogSection(data, { blogPostPublished = true } = {}) {
  const env = renderEnvChanges(data);
  const envBlock = env ? `\n\n${env}` : "";
  return `${versionHeader(data)}\n\n${blogBackLink(data, blogPostPublished)}${renderGroups(data)}${envBlock}\n`;
}

// GitHub release notes: header (with date) + product themes + full commits
// spoiler + optional Contributors credit. `contributors` is the rendered list
// from collectContributors (already `@handle` / plain-name strings) — supplied
// by build-changelog-artifacts.js from git, NOT by the agent. Commit subjects
// are mention-escaped so raw YARD tags don't autolink phantom accounts.
export function renderReleaseNotes(data, contributors = [], { blogPostPublished = true } = {}) {
  const body = renderGroups(data);
  const env = renderEnvChanges(data);
  const envBlock = env ? `\n\n${env}` : "";
  const commits = data.allCommits.map((c) => `- ${c.hash} ${escapeMentions(c.subject)}`).join("\n");
  const spoiler = `<details>\n<summary>Full Commits</summary>\n\n${commits}\n\n</details>`;
  const credits = contributors.length ? `\n\n### 👥 Contributors\n\n${contributors.join(", ")}` : "";
  return `${versionHeader(data)}\n\n${blogBackLink(data, blogPostPublished)}${body}${envBlock}\n\n${spoiler}${credits}\n`;
}

// "a, b and c" — theme names read as prose in the lead sentence.
function joinList(names) {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Lead paragraph: what shipped, at a glance. Every number in it is DERIVED from
// the release data — items per theme, commits in range, env changes — so the
// post cannot state a fact the release notes do not already carry. That is the
// whole reason this artifact needs no second LLM pass.
function renderLead(data) {
  const themes = presentThemes(data);
  const items = themes.reduce((n, t) => n + t.items.length, 0);
  const commits = (data.allCommits || []).length;
  const envs = (data.envChanges || []).length;
  const range = commits ? `, out of ${plural(commits, "commit")} in the range` : "";
  const env = envs ? ` ${plural(envs, "environment variable")} changed with it.` : "";
  const head = `**TeaRAGs v${data.version}** is out (${data.date})`;
  if (items === 0) {
    return `${head} — a maintenance release with nothing user-facing to report${range}.${env}`;
  }
  return `${head}: ${plural(items, "change")} across ${joinList(themes.map((t) => t.name))}${range}.${env}`;
}

// Footer: per-release traceability (the commit range) plus the way back to the
// full history. `/changelog` is a site-relative docs route — correct here,
// because unlike CHANGELOG.md this file is only ever rendered by the site.
function renderBlogFooter(data) {
  const parts = data.compareUrl.split("/compare/");
  const label = parts.length > 1 ? parts[1] : "commit range";
  return `---\n\nFull commit range: [\`${label}\`](${data.compareUrl}) · every released version: [Changelog](/changelog).`;
}

// Docusaurus blog post for a release, rendered from the same release-notes.json
// as the other two artifacts. MDX-escaped throughout: item descriptions come
// from commit text, and the blog config sets `onUntruncatedBlogPosts: "throw"`,
// so the truncate marker below is load-bearing — without it the site build fails.
export function renderReleaseBlogPost(data, contributors = []) {
  const frontmatter = [
    "---",
    `slug: ${blogPostSlug(data.version)}`,
    `title: TeaRAGs v${data.version}`,
    // Author and tag keys must exist in website/blog/{authors,tags}.yml —
    // the blog config sets onInlineAuthors/onInlineTags to "throw".
    "authors: [artk0de]",
    "tags: [release]",
    `date: ${data.date}`,
    "---",
  ].join("\n");
  const credits = contributors.length
    ? `### 👥 Contributors\n\n${contributors.map((c) => escapeMdx(c)).join(", ")}`
    : "";
  const sections = [
    frontmatter,
    renderLead(data),
    "<!-- truncate -->",
    renderGroups(data, mdxText),
    renderEnvChanges(data, mdxText),
    credits,
    renderBlogFooter(data),
  ].filter(Boolean);
  return `${sections.join("\n\n")}\n`;
}

// Replace the `## [version]...` block in CHANGELOG.md with a freshly rendered
// section, leaving every other version block untouched. When the version is
// absent, insert it in descending-semver order (not blindly at the top).
export function spliceVersionSection(changelog, version, newSection) {
  const lines = changelog.split("\n");
  const headerRe = /^## \[(\d+)\.(\d+)\.(\d+)\]/;
  const startRe = new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\]`);

  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (start === -1 && startRe.test(lines[i])) {
      start = i;
      continue;
    }
    if (start !== -1 && /^## \[/.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (start !== -1) {
    return [...lines.slice(0, start), newSection.trimEnd(), "", ...lines.slice(end)].join("\n");
  }

  // absent → semver-aware insert before the first version strictly smaller.
  const [tx, ty, tz] = version.split(".").map(Number);
  const isSmaller = (line) => {
    const m = line.match(headerRe);
    if (!m) return false;
    const [x, y, z] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (x !== tx) return x < tx;
    if (y !== ty) return y < ty;
    return z < tz;
  };
  for (let i = 0; i < lines.length; i++) {
    if (isSmaller(lines[i])) {
      return [...lines.slice(0, i), newSection.trimEnd(), "", ...lines.slice(i)].join("\n");
    }
  }
  // no smaller header: target is the oldest → append at end (or prepend if no headers at all).
  const hasHeader = lines.some((l) => /^## \[/.test(l));
  return hasHeader ? `${changelog.trimEnd()}\n\n${newSection.trimEnd()}\n` : `${newSection.trimEnd()}\n\n${changelog}`;
}
