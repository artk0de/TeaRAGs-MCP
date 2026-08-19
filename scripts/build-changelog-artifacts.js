// scripts/build-changelog-artifacts.js
// Reads release-notes.json (emitted by the agent), renders the three divergent
// artifacts, and splices the declarative section into CHANGELOG.md.
// All logic lives in scripts/lib/render-changelog.js (unit-tested); this is
// thin orchestration only.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  blogPostFilename,
  collectContributors,
  renderChangelogSection,
  renderReleaseBlogPost,
  renderReleaseNotes,
  spliceVersionSection,
} from "./lib/render-changelog.js";

const data = JSON.parse(readFileSync("release-notes.json", "utf8"));
// Contributors come from git (commits.json), NOT the agent — a deterministic
// fact, never an LLM guess. Built by the same workflow step before the agent.
const contributors = collectContributors(JSON.parse(readFileSync("commits.json", "utf8")));

const section = renderChangelogSection(data);
writeFileSync("release-notes.md", renderReleaseNotes(data, contributors));

const changelog = readFileSync("CHANGELOG.md", "utf8");
writeFileSync("CHANGELOG.md", spliceVersionSection(changelog, data.version, section));

// Third artifact: the release post. Rendered from the same JSON — no second
// agent pass — so the blog can never disagree with the release notes.
const postPath = join("website", "blog", blogPostFilename(data));
writeFileSync(postPath, renderReleaseBlogPost(data, contributors));

console.error(`built artifacts for v${data.version} (+ ${postPath})`);
