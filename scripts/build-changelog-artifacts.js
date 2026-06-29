// scripts/build-changelog-artifacts.js
// Reads release-notes.json (emitted by the agent), renders the two divergent
// artifacts, and splices the declarative section into CHANGELOG.md.
// All logic lives in scripts/lib/render-changelog.js (unit-tested); this is
// thin orchestration only.
import { readFileSync, writeFileSync } from "node:fs";

import {
  collectContributors,
  renderChangelogSection,
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

console.error(`built artifacts for v${data.version}`);
