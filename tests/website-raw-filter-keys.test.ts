/**
 * Website raw-filter examples only name payload keys that exist (bd tea-rags-mcp-pn0sw).
 *
 * The website's raw-filter examples drifted to pre-split keys (`git.commitCount`,
 * `git.ageDays`, `git.chunkCommitCount`, ...) after the payload became
 * `git.{file,chunk}.*`. A `must` range on a missing key silently returns nothing
 * and a `must_not` is a silent no-op, so a reader who copies such an example gets
 * an unfiltered or empty search with no error pointing at the cause. Every
 * `"key": "git.…"` in `website/docs/**` must name a real payload key.
 *
 * Real payload keys are the git trajectory's payload signal descriptors. The
 * last-commit timestamps are declared too since bd tea-rags-mcp-9ot33 (their
 * percentiles feed the now-relative age floor and label bands), so no
 * written-but-undeclared exemption remains here.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { gitPayloadSignalDescriptors } from "../src/core/domains/trajectory/git/index.js";

const ROOT = join(import.meta.dirname, "..");

/** Payload keys the git trajectory really writes but does not declare as descriptors. */
const UNDECLARED_BUT_REAL = new Set<string>();

const REAL_KEYS = new Set([...gitPayloadSignalDescriptors.map((descriptor) => descriptor.key), ...UNDECLARED_BUT_REAL]);

/** `{"key": "git.file.commitCount", ...}` — a raw Qdrant condition in a doc example. */
const RAW_GIT_KEY_PATTERN = /"key":\s*"(git\.[^"]+)"/g;

interface RawKeyOffense {
  /** Repo-relative doc path with POSIX separators. */
  file: string;
  /** 1-based line inside the doc. */
  line: number;
  /** The key the example names. */
  key: string;
}

/** Every `"key": "git.…"` occurrence in the website docs, in walk order. */
function findRawGitKeys(): RawKeyOffense[] {
  return readdirSync(join(ROOT, "website/docs"), { recursive: true, encoding: "utf8" })
    .map((entry) => entry.split(/[\\/]/).join("/"))
    .filter((file) => file.endsWith(".md"))
    .sort()
    .flatMap((file) =>
      readFileSync(join(ROOT, "website/docs", file), "utf8")
        .split("\n")
        .flatMap((content, index) =>
          [...content.matchAll(RAW_GIT_KEY_PATTERN)].map((match) => ({
            file,
            line: index + 1,
            key: match[1],
          })),
        ),
    );
}

describe("website raw-filter keys exist in the git payload schema", () => {
  it("every raw-filter git key in the website docs is a real payload key", () => {
    const offenses = findRawGitKeys();
    // Guard against a silently-empty walk: the docs do carry raw-filter examples.
    expect(offenses.length).toBeGreaterThan(0);
    const stale = offenses.filter((offense) => !REAL_KEYS.has(offense.key));
    expect(
      stale.map((offense) => `${offense.file}:${offense.line} "${offense.key}"`),
      "docs name payload keys that do not exist",
    ).toEqual([]);
  });
});
