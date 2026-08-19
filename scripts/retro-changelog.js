// scripts/retro-changelog.mjs
// One-time retrospective migration. Run on the local tea-rags machine (NOT CI —
// needs the same LAN MCP access). Iterates existing tags, reuses the unit-tested
// renderers, rebuilds CHANGELOG.md per version, and edits each GitHub release.
//
//   node scripts/retro-changelog.js [--since vX.Y.Z] [--dry-run]
//
// Default scope: every tag from the second-oldest forward (range needs a prev).
// --since narrows to tags at/after the given one.
// --dry-run rewrites CHANGELOG.md + release-notes.md locally but SKIPS the
//   `gh release edit` step — nothing is published to GitHub. Use for review.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  blogPostFilename,
  collectContributors,
  renderChangelogSection,
  renderReleaseNotes,
  spliceVersionSection,
} from "./lib/render-changelog.js";

const sinceIdx = process.argv.indexOf("--since");
const since = sinceIdx > -1 ? process.argv[sinceIdx + 1] : null;
const dryRun = process.argv.includes("--dry-run");

const tags = execFileSync("git", ["tag", "--sort=creatordate"], { encoding: "utf8" })
  .trim()
  .split("\n")
  .filter(Boolean);

const start = since ? tags.indexOf(since) : 1;
if (since && start === -1) {
  console.error(`--since ${since}: tag not found`);
  process.exit(1);
}

for (let i = Math.max(start, 1); i < tags.length; i++) {
  const prev = tags[i - 1];
  const curr = tags[i];
  const range = `${prev}..${curr}`;
  console.error(`retro ${curr} (${range})`);

  const log = execFileSync("git", ["log", "--no-merges", "--format=%H%x1f%s%x1f%an%x1f%ae%x1f%b%x1e", range], {
    encoding: "utf8",
  });
  writeFileSync("commits.json", execFileSync("node", ["scripts/git-log-to-json.js"], { input: log, encoding: "utf8" }));

  execFileSync(
    "claude",
    [
      "-p",
      `Read scripts/release-changelog-prompt.md, follow it. Version ${curr.replace(/^v/, "")}. Write release-notes.json.`,
      "--allowedTools",
      "Read,Write",
    ],
    { stdio: "inherit" },
  );

  const data = JSON.parse(readFileSync("release-notes.json", "utf8"));
  const contributors = collectContributors(JSON.parse(readFileSync("commits.json", "utf8")));
  // This script does NOT write blog posts — it only rebuilds notes for tags that
  // already shipped, most of them cut before the blog existed. Link the post
  // only where one is actually on disk, so historical sections carry no 404.
  const opts = { blogPostPublished: existsSync(join("website", "blog", blogPostFilename(data))) };
  const changelog = readFileSync("CHANGELOG.md", "utf8");
  writeFileSync("CHANGELOG.md", spliceVersionSection(changelog, data.version, renderChangelogSection(data, opts)));
  writeFileSync("release-notes.md", renderReleaseNotes(data, contributors, opts));
  if (dryRun) {
    console.error(`  [dry-run] skipped gh release edit ${curr}`);
  } else {
    execFileSync("gh", ["release", "edit", curr, "--notes-file", "release-notes.md"], {
      stdio: "inherit",
    });
  }
}
