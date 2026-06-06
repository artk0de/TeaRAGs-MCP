// scripts/build-changelog-artifacts.js
// Reads release-notes.json (emitted by the agent), renders the two divergent
// artifacts, and splices the declarative section into CHANGELOG.md.
// All logic lives in scripts/lib/render-changelog.js (unit-tested); this is
// thin orchestration only.
import { readFileSync, writeFileSync } from "node:fs";

import { renderChangelogSection, renderReleaseNotes, spliceVersionSection } from "./lib/render-changelog.js";

const data = JSON.parse(readFileSync("release-notes.json", "utf8"));

const section = renderChangelogSection(data);
writeFileSync("release-notes.md", renderReleaseNotes(data));

const changelog = readFileSync("CHANGELOG.md", "utf8");
writeFileSync("CHANGELOG.md", spliceVersionSection(changelog, data.version, section));

console.error(`built artifacts for v${data.version}`);
