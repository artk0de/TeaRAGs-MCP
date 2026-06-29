// scripts/lib/render-changelog.js
// Pure renderers consumed by build-changelog-artifacts.js and retro-changelog.js.
// One JSON source (release-notes.json) → two divergent markdown artifacts.

// Fixed product-theme taxonomy. The order here IS the render order; a theme with
// no items in a release is skipped. Keys match release-notes.json
// `groups[].theme`. The agent groups commits by user-facing capability (not by
// internal module), so headings read as product surfaces, not code domains.
const THEMES = [
  { key: "search", label: "🔎 Search & ranking" },
  { key: "codeIntel", label: "🧠 Code intelligence" },
  { key: "indexing", label: "⚡ Indexing & performance" },
  { key: "language", label: "🗣 Language support" },
  { key: "workflow", label: "🛠 CLI & workflow" },
  { key: "fixes", label: "🩹 Fixes" },
];

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
function renderItem(it) {
  return `* ${escapeMentions(it.description)}`;
}

// Render only the themes present in this release, always in taxonomy order.
function renderGroups(data) {
  const byTheme = new Map(data.groups.map((g) => [g.theme, g]));
  return THEMES.filter((t) => byTheme.has(t.key))
    .map((t) => {
      const lines = byTheme
        .get(t.key)
        .items.map((it) => renderItem(it))
        .join("\n");
      return `### ${t.label}\n\n${lines}`;
    })
    .join("\n\n");
}

// Version header carries the release date — required on BOTH artifacts.
function versionHeader(data) {
  return `## [${data.version}](${data.compareUrl}) (${data.date})`;
}

// CHANGELOG.md / website: header + product themes only. No inline hash links, no
// full commit list — release-level traceability via the compareUrl in the header.
export function renderChangelogSection(data) {
  return `${versionHeader(data)}\n\n${renderGroups(data)}\n`;
}

// GitHub release notes: header (with date) + product themes + full commits
// spoiler + optional Contributors credit. `contributors` is the rendered list
// from collectContributors (already `@handle` / plain-name strings) — supplied
// by build-changelog-artifacts.js from git, NOT by the agent. Commit subjects
// are mention-escaped so raw YARD tags don't autolink phantom accounts.
export function renderReleaseNotes(data, contributors = []) {
  const body = renderGroups(data);
  const commits = data.allCommits.map((c) => `- ${c.hash} ${escapeMentions(c.subject)}`).join("\n");
  const spoiler = `<details>\n<summary>Full Commits</summary>\n\n${commits}\n\n</details>`;
  const credits = contributors.length ? `\n\n### 👥 Contributors\n\n${contributors.join(", ")}` : "";
  return `${versionHeader(data)}\n\n${body}\n\n${spoiler}${credits}\n`;
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
