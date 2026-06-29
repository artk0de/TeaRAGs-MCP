import { describe, expect, it } from "vitest";

import { parseGitLog } from "../../scripts/git-log-to-json.js";

// Field separator \x1f, record separator \x1e — matches the git log
// `--format=%H%x1f%s%x1f%an%x1f%ae%x1f%b%x1e` emitted by the changelog workflow.
const US = "\x1f";
const RS = "\x1e";

describe("parseGitLog", () => {
  it("parses hash, subject, author {name,email}, and body from a record", () => {
    const raw = `abc1234def${US}feat: x${US}artk0de${US}art2rik.desperado@gmail.com${US}Co-Authored-By: Claude <noreply@anthropic.com>${RS}`;
    expect(parseGitLog(raw)).toEqual([
      {
        hash: "abc1234",
        subject: "feat: x",
        author: { name: "artk0de", email: "art2rik.desperado@gmail.com" },
        body: "Co-Authored-By: Claude <noreply@anthropic.com>",
      },
    ]);
  });

  it("defaults body to empty string when the commit has no body", () => {
    const raw = `abc1234${US}fix: y${US}artk0de${US}a@b.com${US}${RS}`;
    expect(parseGitLog(raw)[0].body).toBe("");
  });

  it("truncates the hash to 7 chars and trims surrounding whitespace", () => {
    const raw = `abcdef1234567${US}  feat: z  ${US} artk0de ${US} a@b.com ${US} body ${RS}`;
    const r = parseGitLog(raw)[0];
    expect(r.hash).toBe("abcdef1");
    expect(r.subject).toBe("feat: z");
    expect(r.author).toEqual({ name: "artk0de", email: "a@b.com" });
    expect(r.body).toBe("body");
  });

  it("splits multiple records and drops empty trailing ones", () => {
    const raw = `h1${US}s1${US}n1${US}e1${US}${RS}h2${US}s2${US}n2${US}e2${US}${RS}`;
    expect(parseGitLog(raw).map((c) => c.hash)).toEqual(["h1", "h2"]);
  });
});
