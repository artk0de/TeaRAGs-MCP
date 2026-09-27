import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { generateNotes } from "@semantic-release/release-notes-generator";
import { describe, expect, it } from "vitest";

// Renders release notes through the release-notes-generator config that
// semantic-release actually runs, so the section a commit lands in is asserted
// against .releaserc.json itself, not against a copy of it.
const releaserc = JSON.parse(readFileSync(resolve(__dirname, "../../.releaserc.json"), "utf8")) as {
  plugins: [string, Record<string, unknown>][];
};
const notesConfig = releaserc.plugins.find(([name]) => name === "@semantic-release/release-notes-generator")![1];

async function notesFor(messages: string[]): Promise<string> {
  return generateNotes(notesConfig, {
    cwd: process.cwd(),
    options: { repositoryUrl: "https://github.com/artk0de/TeaRAGs-MCP.git" },
    lastRelease: { gitTag: "v1.0.0", version: "1.0.0" },
    nextRelease: { gitTag: "v1.1.0", version: "1.1.0" },
    commits: messages.map((message, i) => ({
      hash: `${i}`.padStart(7, "a"),
      commit: { short: `${i}`.padStart(7, "a") },
      message,
    })),
    logger: { log: () => {} },
  });
}

function section(notes: string, title: string): string {
  const start = notes.indexOf(`### ${title}`);
  if (start < 0) return "";
  const next = notes.indexOf("\n### ", start + 1);
  return notes.slice(start, next < 0 ? undefined : next);
}

describe(".releaserc.json release notes — Plugin vs Documentation", () => {
  const MESSAGES = [
    "docs(plugin): explore skill routes by intent",
    "fix(plugin): search cascade names the right tool",
    "feat(dinopowers): wrapper for code review",
    "improve(skills): tighter bug-hunt recipe",
    "docs(website): document failover retry",
    "docs(readme): indexing speed section",
    "fix(embedding): split a crashed batch",
  ];

  it("puts every plugin-scoped commit under Plugin, whatever its type", async () => {
    const plugin = section(await notesFor(MESSAGES), "Plugin");
    expect(plugin).toContain("explore skill routes by intent");
    expect(plugin).toContain("search cascade names the right tool");
    expect(plugin).toContain("wrapper for code review");
    expect(plugin).toContain("tighter bug-hunt recipe");
  });

  it("keeps Documentation to the documentation site and README", async () => {
    const docs = section(await notesFor(MESSAGES), "Documentation");
    expect(docs).toContain("document failover retry");
    expect(docs).toContain("indexing speed section");
    expect(docs).not.toContain("explore skill routes by intent");
  });

  it("keeps plugin fixes out of Bug Fixes", async () => {
    const fixes = section(await notesFor(MESSAGES), "Bug Fixes");
    expect(fixes).toContain("split a crashed batch");
    expect(fixes).not.toContain("search cascade names the right tool");
  });

  it("orders Plugin before Documentation", async () => {
    const notes = await notesFor(MESSAGES);
    expect(notes.indexOf("### Plugin")).toBeGreaterThan(-1);
    expect(notes.indexOf("### Plugin")).toBeLessThan(notes.indexOf("### Documentation"));
  });
});
