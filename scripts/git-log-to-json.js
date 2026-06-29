// scripts/git-log-to-json.js
// Reads `git log --format=%H%x1f%s%x1f%an%x1f%ae%x1f%b%x1e` from stdin, emits a
// JSON array of { hash, subject, author: { name, email }, body }. Fields are
// \x1f-delimited; records are \x1e-delimited. The author fields feed the release
// Contributors credit (collectContributors in lib/render-changelog.js).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function parseGitLog(raw) {
  return raw
    .split("\x1e")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [hash, subject, name = "", email = "", body = ""] = r.split("\x1f");
      return {
        hash: hash.slice(0, 7),
        subject: subject.trim(),
        author: { name: name.trim(), email: email.trim() },
        body: body.trim(),
      };
    });
}

// CLI entry only when run directly (importing for tests must not read stdin).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(parseGitLog(readFileSync(0, "utf8")), null, 2));
}
