import { describe, expect, it } from "vitest";

import * as gitParsers from "../../../../src/core/adapters/git/parsers.js";
import type { FileChurnData } from "../../../../src/core/adapters/git/types.js";

describe("parsePathspecOutput (via private method)", () => {
  it("should skip binary files with '-\\t-\\t' in numstat output", () => {
    // Simulate git log output with binary file entries
    const sha = "a".repeat(40);
    // Format: \0SHA\0PARENTS\0author\0email\0timestamp\0body\0numstat_section
    const stdout = [
      "", // leading empty
      sha, // SHA
      "", // parents (empty = root)
      "Alice", // author
      "alice@example.com", // email
      String(Math.floor(Date.now() / 1000)), // timestamp
      "feat: add images", // body
      "-\t-\tbinary.png\n10\t5\treadme.md\n-\t-\tphoto.jpg", // numstat with binaries
    ].join("\0");

    const result = gitParsers.parsePathspecOutput(stdout);

    expect(result).toHaveLength(1);
    expect(result[0].changedFiles).toEqual(["readme.md"]);
    // binary.png and photo.jpg should be skipped
    expect(result[0].changedFiles).not.toContain("binary.png");
    expect(result[0].changedFiles).not.toContain("photo.jpg");
  });

  it("should return empty when all files are binary", () => {
    const sha = "b".repeat(40);
    const stdout = [
      "",
      sha,
      "", // parents
      "Bob",
      "bob@example.com",
      String(Math.floor(Date.now() / 1000)),
      "feat: add image",
      "-\t-\tbinary.png",
    ].join("\0");

    const result = gitParsers.parsePathspecOutput(stdout);
    // No non-binary changed files → no entries
    expect(result).toHaveLength(0);
  });

  it("should handle empty stdout", () => {
    const result = gitParsers.parsePathspecOutput("");
    expect(result).toHaveLength(0);
  });

  it("should skip malformed SHA entries", () => {
    const stdout = ["", "not-a-sha", "", "Alice", "alice@example.com", "12345", "feat: stuff", "10\t5\tfile.ts"].join(
      "\0",
    );

    const result = gitParsers.parsePathspecOutput(stdout);
    expect(result).toHaveLength(0);
  });
});

describe("parseNumstatOutput — parent parsing", () => {
  it("should parse parent SHAs from %P field", () => {
    const sha = "a".repeat(40);
    const parent1 = "b".repeat(40);
    const parent2 = "c".repeat(40);
    // Format: \0SHA\0PARENTS\0author\0email\0timestamp\0body\0numstat
    const stdout = [
      "",
      sha,
      `${parent1} ${parent2}`, // two parents = merge commit
      "Alice",
      "alice@example.com",
      String(Math.floor(Date.now() / 1000)),
      "Merge branch 'fix/TD-123' into 'master'",
      "10\t5\tapp/models/user.rb",
    ].join("\0");
    const result = gitParsers.parseNumstatOutput(stdout);
    const { commits } = result.get("app/models/user.rb")!;
    expect(commits[0].parents).toEqual([parent1, parent2]);
  });

  it("should parse single parent for non-merge commits", () => {
    const sha = "a".repeat(40);
    const parent = "b".repeat(40);
    const stdout = [
      "",
      sha,
      parent,
      "Alice",
      "alice@example.com",
      String(Math.floor(Date.now() / 1000)),
      "[TD-456] Fix validation",
      "3\t1\tapp/services/auth.rb",
    ].join("\0");
    const result = gitParsers.parseNumstatOutput(stdout);
    const { commits } = result.get("app/services/auth.rb")!;
    expect(commits[0].parents).toEqual([parent]);
  });

  it("should handle root commit with no parents", () => {
    const sha = "a".repeat(40);
    const stdout = [
      "",
      sha,
      "", // empty parents = root commit
      "Alice",
      "alice@example.com",
      String(Math.floor(Date.now() / 1000)),
      "Initial commit",
      "1\t0\tREADME.md",
    ].join("\0");
    const result = gitParsers.parseNumstatOutput(stdout);
    const { commits } = result.get("README.md")!;
    expect(commits[0].parents).toEqual([]);
  });
});

describe("parseNumstatOutput (via private method)", () => {
  it("should skip binary files (NaN added/deleted) in numstat output", () => {
    const sha = "c".repeat(40);
    const stdout = [
      "",
      sha,
      "", // parents
      "Alice",
      "alice@example.com",
      String(Math.floor(Date.now() / 1000)),
      "feat: add image",
      "-\t-\tbinary.png\n20\t10\tcode.ts",
    ].join("\0");

    const result: Map<string, FileChurnData> = gitParsers.parseNumstatOutput(stdout);

    // binary.png should be skipped (NaN from parseInt("-"))
    expect(result.has("binary.png")).toBe(false);
    // code.ts should be present
    expect(result.has("code.ts")).toBe(true);
    expect(result.get("code.ts")!.linesAdded).toBe(20);
    expect(result.get("code.ts")!.linesDeleted).toBe(10);
  });

  it("should handle lines with fewer than 3 tab-separated parts", () => {
    const sha = "d".repeat(40);
    const stdout = [
      "",
      sha,
      "", // parents
      "Alice",
      "alice@example.com",
      String(Math.floor(Date.now() / 1000)),
      "feat: something",
      "incomplete\tline\n5\t3\tvalid.ts",
    ].join("\0");

    const result: Map<string, FileChurnData> = gitParsers.parseNumstatOutput(stdout);
    expect(result.has("valid.ts")).toBe(true);
    expect(result.size).toBe(1);
  });

  it("should handle empty stdout", () => {
    const result: Map<string, FileChurnData> = gitParsers.parseNumstatOutput("");
    expect(result.size).toBe(0);
  });

  it("should aggregate multiple commits for the same file", () => {
    const sha1 = "a".repeat(40);
    const sha2 = "b".repeat(40);
    const ts = String(Math.floor(Date.now() / 1000));
    const stdout = [
      "",
      sha1,
      "", // parents
      "Alice",
      "alice@ex.com",
      ts,
      "fix: first",
      "10\t5\tshared.ts",
      sha2,
      "", // parents
      "Bob",
      "bob@ex.com",
      ts,
      "feat: second",
      "20\t15\tshared.ts",
    ].join("\0");

    const result: Map<string, FileChurnData> = gitParsers.parseNumstatOutput(stdout);
    const entry = result.get("shared.ts");
    expect(entry).toBeDefined();
    expect(entry!.commits).toHaveLength(2);
    expect(entry!.linesAdded).toBe(30);
    expect(entry!.linesDeleted).toBe(20);
  });
});

describe("parseNumstatOutput — SHA validation edge cases", () => {
  it("should skip sections with too-short SHA", () => {
    // SHA is only 10 chars instead of 40
    const stdout = [
      "",
      "abc1234567", // too short
      "", // parents
      "Alice",
      "alice@ex.com",
      "12345",
      "feat: stuff",
      "10\t5\tfile.ts",
    ].join("\0");

    const result: Map<string, FileChurnData> = gitParsers.parseNumstatOutput(stdout);
    expect(result.size).toBe(0);
  });

  it("should skip sections with non-hex SHA characters", () => {
    // SHA has uppercase letters (git uses lowercase hex)
    const stdout = [
      "",
      `AAAA${"a".repeat(36)}`, // uppercase chars — fails /^[a-f0-9]+$/ test
      "", // parents
      "Alice",
      "alice@ex.com",
      "12345",
      "feat: stuff",
      "10\t5\tfile.ts",
    ].join("\0");

    const result: Map<string, FileChurnData> = gitParsers.parseNumstatOutput(stdout);
    expect(result.size).toBe(0);
  });

  it("should handle interleaved valid and invalid SHAs", () => {
    const validSha = "a".repeat(40);
    const ts = String(Math.floor(Date.now() / 1000));
    const stdout = [
      "",
      "garbage-not-a-sha", // invalid
      "more garbage",
      "", // empty
      validSha,
      "", // parents
      "Alice",
      "alice@ex.com",
      ts,
      "feat: valid",
      "10\t5\tfile.ts",
    ].join("\0");

    const result: Map<string, FileChurnData> = gitParsers.parseNumstatOutput(stdout);
    expect(result.has("file.ts")).toBe(true);
    expect(result.get("file.ts")!.commits).toHaveLength(1);
  });
});
