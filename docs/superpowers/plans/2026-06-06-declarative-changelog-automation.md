# Declarative Changelog Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** After every `semantic-release` publish, a Claude agent on a
self-hosted runner generates a tea-rags-backed **declarative** changelog and
rewrites two artifact families in distinct formats — GitHub releases
(declarative + full commits under a spoiler) and changelog files (declarative
only, with inline commit-hash links) — plus a one-time retrospective migration
of the 23 existing CHANGELOG versions and up to 68 existing GitHub releases.

**Architecture:** The agent never writes markdown directly. It emits a
structured `release-notes.json` (declarative groups + per-item commit hashes +
full commit list). A deterministic Node builder
(`scripts/build-changelog-artifacts.mjs`) renders that JSON into **two**
artifacts via two pure functions — `renderChangelogSection()` (declarative +
inline hashes, no full list) and `renderReleaseNotes()` (declarative +
`<details>` Full Commits). Forward path runs as a `release: published` workflow
on `[self-hosted, tea-rags]`; the retrospective path reuses the identical
builder over historical tag ranges. The existing `prepare-changelog.sh` mirror
to `website/docs/changelog.md` is unchanged — it keeps copying `CHANGELOG.md`,
which is now already declarative.

**Tech Stack:** GitHub Actions (self-hosted runner),
`anthropics/claude-code-action@v1` (OAuth, subscription), tea-rags MCP
(`hybrid_search`/`find_similar`), Node 22 ESM + Vitest, `gh` CLI,
conventional-commit `CHANGELOG.md`.

---

## Prerequisites (verify before Task 1)

- [ ] **OAuth token present.** Confirm `@claude` answers in any repo issue/PR →
      `secrets.CLAUDE_CODE_OAUTH_TOKEN` is valid and reused. If not: run
      `claude setup-token` (Pro/Max), add as repo Actions secret; install Claude
      GitHub App via `/install-github-app`.
- [ ] **Self-hosted runner online** with labels `[self-hosted, tea-rags]`, on
      the machine where tea-rags MCP + ollama (`192.168.1.71:11434`) + Qdrant
      index `code_8b243ffe` are reachable. Required because semantic search
      needs LAN access cloud runners lack.
- [ ] **`.mcp.json`** at repo root exposes the tea-rags server to
      `claude-code-action` (same config the local session uses).
- [ ] **`secrets.RELEASE_TOKEN`** (existing PAT) reused for push +
      `gh release edit`.

---

## File Structure

| File                                      | Responsibility                                                                                                         | Status |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------ |
| `scripts/release-changelog-prompt.md`     | Agent instruction: grouping rules, noise-fold rule, JSON output contract                                               | Create |
| `scripts/lib/render-changelog.mjs`        | Pure renderers: `renderChangelogSection(data)`, `renderReleaseNotes(data)`, `spliceVersionSection(...)`                | Create |
| `scripts/build-changelog-artifacts.mjs`   | CLI: read `release-notes.json` → write `changelog-section.md` + `release-notes.md`; splice section into `CHANGELOG.md` | Create |
| `scripts/git-log-to-json.mjs`             | `\x1f`/`\x1e`-delimited `git log` → `[{hash,subject,body}]`                                                            | Create |
| `tests/scripts/render-changelog.test.mjs` | Vitest fixtures for both renderers + the splice                                                                        | Create |
| `.github/workflows/release-changelog.yml` | Forward automation on `release: published`                                                                             | Create |
| `scripts/retro-changelog.mjs`             | One-time: iterate tags → agent per range → rebuild whole CHANGELOG + edit each release                                 | Create |
| `scripts/prepare-changelog.sh`            | Unchanged mirror CHANGELOG.md → website (now declarative input)                                                        | Keep   |

**JSON contract** (`release-notes.json`) — single source both renderers consume:

```json
{
  "version": "1.30.0",
  "date": "2026-06-06",
  "compareUrl": "https://github.com/artk0de/TeaRAGs-MCP/compare/v1.29.0...v1.30.0",
  "repoUrl": "https://github.com/artk0de/TeaRAGs-MCP",
  "groups": [
    {
      "domain": "explore",
      "items": [
        {
          "description": "rerank presets resolve adaptive bounds per query",
          "commits": ["abc1234", "def5678"]
        }
      ]
    },
    {
      "domain": "small fixes and improvements",
      "items": [
        {
          "description": "internal moves, formatting, test scaffolding",
          "commits": ["aaa1111", "bbb2222", "ccc3333"]
        }
      ]
    }
  ],
  "allCommits": [
    { "hash": "abc1234", "subject": "feat(explore): adaptive bounds per query" }
  ]
}
```

---

## Task 1: Declarative format spec (agent prompt) + git-log parser

**Files:**

- Create: `scripts/release-changelog-prompt.md`
- Create: `scripts/git-log-to-json.mjs`

- [ ] **Step 1: Write the prompt file.** No code test — this is data consumed by
      the agent. Content:

```markdown
# Declarative Changelog — Agent Instructions

You are post-processing a published release. Inputs available in the working
dir:

- `commits.json` — array of `{ hash, subject, body }` for this release range.
- tea-rags MCP — use `hybrid_search` / `find_similar` to understand what
  changed.

## Produce `release-notes.json` ONLY (no prose, no markdown to stdout)

Schema: see plan JSON contract. Rules:

1. **Group by domain**, not by commit type. Domains are tea-rags path shortcuts:
   explore, ingest, trajectory, api, chunker, codegraph, adapters, infra,
   config. Derive the domain from the commit scope or the changed symbols (query
   tea-rags).
2. **Declarative descriptions.** Describe the resulting capability/behavior, not
   the commit verb. "rerank presets resolve adaptive bounds per query", NOT "add
   adaptiveBounds() to Reranker".
3. **Fold noise into one group** literally named `small fixes and improvements`:
   any commit whose net effect is a rename/move/format/test/chore/build, OR a
   pure refactor with no externally observable behavior change. Collapse them
   into 1-3 umbrella items; keep their hashes in `commits[]`.
4. **Every item lists its commit hashes** (7-char short) in `commits[]`.
5. **`allCommits`** = every commit in range, verbatim subject, for the release
   spoiler.
6. Use tea-rags to decide domain + whether a change is observable (real feature)
   vs noise — query the changed symbols, read overlay labels.
```

- [ ] **Step 2: Write the git-log parser** (no test — trivial split).

```javascript
// scripts/git-log-to-json.mjs — reads `git log --format=%H%x1f%s%x1f%b%x1e` from stdin
import { readFileSync } from "node:fs";

const raw = readFileSync(0, "utf8");
const records = raw
  .split("\x1e")
  .map((r) => r.trim())
  .filter(Boolean);
const out = records.map((r) => {
  const [hash, subject, body = ""] = r.split("\x1f");
  return { hash: hash.slice(0, 7), subject: subject.trim(), body: body.trim() };
});
process.stdout.write(JSON.stringify(out, null, 2));
```

- [ ] **Step 3: Commit.**

```bash
git add scripts/release-changelog-prompt.md scripts/git-log-to-json.mjs
git commit -m "feat(ci): declarative changelog agent prompt + git-log parser"
```

---

## Task 2: Pure renderers (TDD core)

**Files:**

- Create: `scripts/lib/render-changelog.mjs`
- Test: `tests/scripts/render-changelog.test.mjs`

- [ ] **Step 1: Write failing tests.**

```javascript
import { describe, expect, it } from "vitest";

import {
  renderChangelogSection,
  renderReleaseNotes,
} from "../../scripts/lib/render-changelog.mjs";

const DATA = {
  version: "1.30.0",
  date: "2026-06-06",
  compareUrl:
    "https://github.com/artk0de/TeaRAGs-MCP/compare/v1.29.0...v1.30.0",
  repoUrl: "https://github.com/artk0de/TeaRAGs-MCP",
  groups: [
    {
      domain: "explore",
      items: [
        {
          description: "rerank presets resolve adaptive bounds per query",
          commits: ["abc1234", "def5678"],
        },
      ],
    },
    {
      domain: "small fixes and improvements",
      items: [
        {
          description: "internal moves and formatting",
          commits: ["aaa1111", "bbb2222"],
        },
      ],
    },
  ],
  allCommits: [
    { hash: "abc1234", subject: "feat(explore): adaptive bounds per query" },
    { hash: "aaa1111", subject: "refactor(explore): move helper" },
  ],
};

describe("renderChangelogSection", () => {
  it("emits version header with compare link", () => {
    expect(renderChangelogSection(DATA)).toContain(
      "## [1.30.0](https://github.com/artk0de/TeaRAGs-MCP/compare/v1.29.0...v1.30.0) (2026-06-06)",
    );
  });
  it("renders domain group headers", () => {
    expect(renderChangelogSection(DATA)).toContain("### explore");
    expect(renderChangelogSection(DATA)).toContain(
      "### small fixes and improvements",
    );
  });
  it("appends inline hash links per item, no full commit list", () => {
    const out = renderChangelogSection(DATA);
    expect(out).toContain(
      "rerank presets resolve adaptive bounds per query ([abc1234](https://github.com/artk0de/TeaRAGs-MCP/commit/abc1234), [def5678](https://github.com/artk0de/TeaRAGs-MCP/commit/def5678))",
    );
    expect(out).not.toContain("<details>");
    expect(out).not.toContain("refactor(explore): move helper");
  });
});

describe("renderReleaseNotes", () => {
  it("renders declarative groups identical to changelog body", () => {
    expect(renderReleaseNotes(DATA)).toContain("### explore");
  });
  it("wraps full commit list in a Full Commits spoiler", () => {
    const out = renderReleaseNotes(DATA);
    expect(out).toContain("<details>");
    expect(out).toContain("<summary>Full Commits</summary>");
    expect(out).toContain("- abc1234 feat(explore): adaptive bounds per query");
    expect(out).toContain("- aaa1111 refactor(explore): move helper");
  });
});
```

- [ ] **Step 2: Run, verify fail.**

Run: `npx vitest run tests/scripts/render-changelog.test.mjs` Expected: FAIL —
module not found.

- [ ] **Step 3: Implement renderers.**

```javascript
// scripts/lib/render-changelog.mjs
function hashLinks(commits, repoUrl) {
  return commits.map((h) => `[${h}](${repoUrl}/commit/${h})`).join(", ");
}

function renderGroups(data) {
  return data.groups
    .map((g) => {
      const lines = g.items
        .map(
          (it) =>
            `* ${it.description} (${hashLinks(it.commits, data.repoUrl)})`,
        )
        .join("\n");
      return `### ${g.domain}\n\n${lines}`;
    })
    .join("\n\n");
}

export function renderChangelogSection(data) {
  const header = `## [${data.version}](${data.compareUrl}) (${data.date})`;
  return `${header}\n\n${renderGroups(data)}\n`;
}

export function renderReleaseNotes(data) {
  const body = renderGroups(data);
  const commits = data.allCommits
    .map((c) => `- ${c.hash} ${c.subject}`)
    .join("\n");
  const spoiler = `<details>\n<summary>Full Commits</summary>\n\n${commits}\n\n</details>`;
  return `${body}\n\n${spoiler}\n`;
}
```

- [ ] **Step 4: Run, verify pass.**

Run: `npx vitest run tests/scripts/render-changelog.test.mjs` Expected: PASS (5
tests).

- [ ] **Step 5: Commit.**

```bash
git add scripts/lib/render-changelog.mjs tests/scripts/render-changelog.test.mjs
git commit -m "feat(ci): dual-format changelog renderers (section + release notes)"
```

---

## Task 3: Artifact builder CLI + CHANGELOG splice

**Files:**

- Create: `scripts/build-changelog-artifacts.mjs`
- Modify: `scripts/lib/render-changelog.mjs` (add `spliceVersionSection`)
- Test: `tests/scripts/render-changelog.test.mjs` (extend with splice test)

- [ ] **Step 1: Add failing splice test** to the existing test file.

```javascript
import { spliceVersionSection } from "../../scripts/lib/render-changelog.mjs";

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
    const newSection =
      "## [1.30.0](url-c) (2026-06-06)\n\n### explore\n\n* declarative ([abc1234](z))\n";
    const out = spliceVersionSection(CHANGELOG, "1.30.0", newSection);
    expect(out).toContain("### explore");
    expect(out).not.toContain("old conventional line");
    expect(out).toContain("## [1.29.0](url-b) (2026-06-05)");
    expect(out).toContain("* prior version stays");
  });

  it("prepends when the version is not yet present", () => {
    const newSection =
      "## [2.0.0](url-d) (2026-07-01)\n\n### api\n\n* new ([zzz9999](z))\n";
    const out = spliceVersionSection(CHANGELOG, "2.0.0", newSection);
    expect(out.indexOf("## [2.0.0]")).toBeLessThan(out.indexOf("## [1.30.0]"));
  });
});
```

- [ ] **Step 2: Run, verify fail.**

Run:
`npx vitest run tests/scripts/render-changelog.test.mjs -t spliceVersionSection`
Expected: FAIL — `spliceVersionSection` not exported.

- [ ] **Step 3: Implement splice in `render-changelog.mjs`.**

```javascript
// append to scripts/lib/render-changelog.mjs
export function spliceVersionSection(changelog, version, newSection) {
  const lines = changelog.split("\n");
  const headerRe = /^## \[/;
  const startRe = new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\]`);
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (start === -1 && startRe.test(lines[i])) {
      start = i;
      continue;
    }
    if (start !== -1 && headerRe.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (start === -1) {
    // version not present (first ever) → prepend
    return `${newSection.trimEnd()}\n\n${changelog}`;
  }
  const before = lines.slice(0, start);
  const after = lines.slice(end);
  return [...before, newSection.trimEnd(), "", ...after].join("\n");
}
```

- [ ] **Step 4: Run, verify pass.**

Run: `npx vitest run tests/scripts/render-changelog.test.mjs` Expected: PASS (7
tests).

- [ ] **Step 5: Implement builder CLI** (thin orchestration, no logic — tested
      funcs do the work).

```javascript
// scripts/build-changelog-artifacts.mjs
import { readFileSync, writeFileSync } from "node:fs";

import {
  renderChangelogSection,
  renderReleaseNotes,
  spliceVersionSection,
} from "./lib/render-changelog.mjs";

const data = JSON.parse(readFileSync("release-notes.json", "utf8"));

const section = renderChangelogSection(data);
writeFileSync("release-notes.md", renderReleaseNotes(data));

const changelog = readFileSync("CHANGELOG.md", "utf8");
writeFileSync(
  "CHANGELOG.md",
  spliceVersionSection(changelog, data.version, section),
);

console.error(`built artifacts for v${data.version}`);
```

- [ ] **Step 6: Commit.**

```bash
git add scripts/build-changelog-artifacts.mjs scripts/lib/render-changelog.mjs tests/scripts/render-changelog.test.mjs
git commit -m "feat(ci): changelog artifact builder with version-section splice"
```

---

## Task 4: Forward workflow (`release: published`)

**Files:**

- Create: `.github/workflows/release-changelog.yml`

- [ ] **Step 1: Write the workflow.**

```yaml
name: Declarative Changelog

on:
  release:
    types: [published]

permissions:
  contents: write

concurrency:
  group: release-changelog
  cancel-in-progress: false

jobs:
  declarative-changelog:
    runs-on: [self-hosted, tea-rags]
    steps:
      - name: Checkout main
        uses: actions/checkout@v4
        with:
          ref: main
          fetch-depth: 0
          token: ${{ secrets.RELEASE_TOKEN }}

      - name: Compute commit range
        id: range
        run: |
          CURR="${{ github.event.release.tag_name }}"
          PREV=$(git describe --tags --abbrev=0 "${CURR}^" 2>/dev/null || echo "")
          RANGE=$([ -n "$PREV" ] && echo "${PREV}..${CURR}" || echo "$CURR")
          echo "range=$RANGE" >> "$GITHUB_OUTPUT"

      - name: Build commits.json
        run: |
          git log --no-merges --format='%H%x1f%s%x1f%b%x1e' ${{ steps.range.outputs.range }} \
            | node scripts/git-log-to-json.mjs > commits.json

      - name: Generate declarative notes (agent)
        uses: anthropics/claude-code-action@v1
        with:
          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          prompt: |
            Read scripts/release-changelog-prompt.md and follow it exactly.
            Version is ${{ github.event.release.tag_name }} without the leading v.
            Write release-notes.json to the working directory. Use tea-rags MCP.
          claude_args:
            "--mcp-config .mcp.json --allowedTools
            mcp__tea-rags__hybrid_search,mcp__tea-rags__find_similar,Read,Write"

      - name: Build artifacts
        run: node scripts/build-changelog-artifacts.mjs

      - name: Mirror to website
        run: bash scripts/prepare-changelog.sh

      - name: Update GitHub release notes
        env:
          GH_TOKEN: ${{ secrets.RELEASE_TOKEN }}
        run:
          gh release edit "${{ github.event.release.tag_name }}" --notes-file
          release-notes.md

      - name: Commit declarative changelog
        run: |
          git config user.name "tea-rags-bot"
          git config user.email "bot@tea-rags"
          git add CHANGELOG.md website/docs/changelog.md
          git commit -m "chore(release): ${{ github.event.release.tag_name }} declarative changelog" || exit 0
          git push origin main
```

- [ ] **Step 2: Validate YAML.**

Run: `npx --yes @action-validator/cli .github/workflows/release-changelog.yml`
(or `actionlint`) Expected: no errors.

- [ ] **Step 3: Commit.**

```bash
git add .github/workflows/release-changelog.yml
git commit -m "feat(ci): release:published declarative changelog workflow"
```

---

## Task 5: Anti-retrigger guard

The Task 4 commit `chore(release): … declarative changelog` pushes to `main`,
which fires `release.yml` (`on: push: main`). Its existing guard
`if: !startsWith(...'chore(release)')` already **skips the release job** for
this prefix, and `deploy-docs` (`if: always()`) **redeploys** the website with
the declarative changelog. So the default path already works — we rely on it for
the website redeploy.

**Files:**

- Modify: `.github/workflows/release.yml` (comment only)

- [ ] **Step 1: Verify guard covers the new commit prefix.** Read `release.yml`
      `if:` line, assert the bot commit message starts with `chore(release):`.
      No logic change needed.
- [ ] **Step 2: Add a clarifying comment** above the `if:` guard documenting
      that the declarative-changelog bot commit intentionally lands here to
      drive `deploy-docs`. Commit:

```bash
git commit -am "docs(ci): note declarative-changelog redeploy via deploy-docs"
```

---

## Task 6: Retrospective migration

**Files:**

- Create: `scripts/retro-changelog.mjs`

One-time run on the local tea-rags machine (not CI — needs the same LAN MCP
access). Iterates existing versions, reuses the Task 2/3 renderers, rebuilds the
whole `CHANGELOG.md`, and edits each existing GitHub release.

- [ ] **Step 1: Write the migration driver.**

```javascript
// scripts/retro-changelog.mjs — run: node scripts/retro-changelog.mjs [--since vX.Y.Z]
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

import {
  renderChangelogSection,
  renderReleaseNotes,
  spliceVersionSection,
} from "./lib/render-changelog.mjs";

const sinceIdx = process.argv.indexOf("--since");
const since = sinceIdx > -1 ? process.argv[sinceIdx + 1] : null;

const tags = execFileSync("git", ["tag", "--sort=creatordate"], {
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .filter(Boolean);
const start = since ? tags.indexOf(since) : 1;

for (let i = Math.max(start, 1); i < tags.length; i++) {
  const prev = tags[i - 1];
  const curr = tags[i];
  const range = `${prev}..${curr}`;
  console.error(`retro ${curr} (${range})`);

  const log = execFileSync(
    "git",
    ["log", "--no-merges", "--format=%H%x1f%s%x1f%b%x1e", range],
    { encoding: "utf8" },
  );
  writeFileSync(
    "commits.json",
    execFileSync("node", ["scripts/git-log-to-json.mjs"], {
      input: log,
      encoding: "utf8",
    }),
  );

  execFileSync(
    "claude",
    [
      "-p",
      `Read scripts/release-changelog-prompt.md, follow it. Version ${curr.replace(/^v/, "")}. Write release-notes.json.`,
      "--mcp-config",
      ".mcp.json",
      "--allowedTools",
      "mcp__tea-rags__hybrid_search,mcp__tea-rags__find_similar,Read,Write",
    ],
    { stdio: "inherit" },
  );

  const data = JSON.parse(readFileSync("release-notes.json", "utf8"));
  const changelog = readFileSync("CHANGELOG.md", "utf8");
  writeFileSync(
    "CHANGELOG.md",
    spliceVersionSection(changelog, data.version, renderChangelogSection(data)),
  );
  writeFileSync("release-notes.md", renderReleaseNotes(data));
  execFileSync(
    "gh",
    ["release", "edit", curr, "--notes-file", "release-notes.md"],
    { stdio: "inherit" },
  );
}
```

- [ ] **Step 2: Dry-run on the newest tag only** (`--since v1.28.0`), inspect
      diff before committing.

Run: `node scripts/retro-changelog.mjs --since v1.28.0` Expected: `CHANGELOG.md`
v1.29.0 section becomes declarative; `gh release view v1.29.0` shows spoiler.
`git diff CHANGELOG.md` reviewed by user.

- [ ] **Step 3: Full retro run** after dry-run approved (confirm scope with user
      — see Open parameter).

Run: `node scripts/retro-changelog.mjs` Then:
`bash scripts/prepare-changelog.sh` to mirror, review full diff.

- [ ] **Step 4: Commit migration result.**

```bash
git add scripts/retro-changelog.mjs CHANGELOG.md website/docs/changelog.md
git commit -m "chore(release): retrospective declarative changelog migration"
```

---

## Self-Review

**Spec coverage:**

- releases = declarative + full commits spoiler → Task 2 `renderReleaseNotes` +
  Task 4 `gh release edit`. ✓
- changelogs = declarative only + inline hash links → Task 2
  `renderChangelogSection` + Task 3 splice + `prepare-changelog.sh` mirror. ✓
- noise → "small fixes and improvements" → Task 1 rule #3. ✓
- semantic-release first, agent post-processes → Task 4 `release: published`
  (fires after publish). ✓
- retrospective → Task 6. ✓
- tea-rags semantic search → Task 1 rule #6, Task 4 agent allowedTools. ✓

**Open parameter (resolve at execution):** retro depth — default all 23
CHANGELOG versions + all `gh release list` entries; `--since` narrows. Confirm
with user before Task 6 Step 3 full run (cost: ~23-68 agent passes).

**Type consistency:** `renderChangelogSection` / `renderReleaseNotes` /
`spliceVersionSection` signatures identical across Tasks 2, 3, 4, 6. JSON
contract fields (`version`, `date`, `compareUrl`, `repoUrl`, `groups[].domain`,
`groups[].items[].{description,commits}`, `allCommits[].{hash,subject}`)
consistent in prompt (Task 1) and renderers (Task 2).

**Risk flagged:** if `release-notes.json` is malformed (agent error), builder
throws and the workflow fails loud before any push — no partial corruption of
`CHANGELOG.md` (splice runs only after successful parse).
