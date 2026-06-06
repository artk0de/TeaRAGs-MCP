import { describe, expect, it } from "vitest";

import {
  classifyQdrant,
  formatProjectsTable,
  humanCount,
  relativeAge,
  wrapName,
} from "../../../src/cli/commands/projects-format.js";
import { createColorizer } from "../../../src/cli/infra/color.js";
import type { CollectionEntry } from "../../../src/core/api/public/index.js";

const NOW = new Date("2026-06-06T12:00:00Z");
const plain = createColorizer({ env: { NO_COLOR: "1" }, isTTY: false });

function entry(over: Partial<CollectionEntry>): CollectionEntry {
  return {
    collectionName: "code_x",
    path: "/home/u/proj",
    embeddingModel: "m",
    embeddingDimensions: 768,
    qdrantUrl: "http://127.0.0.1:50000",
    indexedAt: NOW.toISOString(),
    teaRagsVersion: "1.28.0",
    chunksCount: 100,
    name: "proj",
    ...over,
  } as CollectionEntry;
}

describe("cli/commands/projects-format", () => {
  describe("humanCount", () => {
    it.each([
      [9, "9"],
      [999, "999"],
      [1000, "1.0k"],
      [1500, "1.5k"],
      [11541, "11.5k"],
      [117028, "117.0k"],
    ])("formats %i as %s", (n, expected) => {
      expect(humanCount(n)).toBe(expected);
    });
  });

  describe("relativeAge", () => {
    it("renders minutes under an hour", () => {
      expect(relativeAge(new Date(NOW.getTime() - 5 * 60_000).toISOString(), NOW)).toBe("5m ago");
    });
    it("renders hours under a day", () => {
      expect(relativeAge(new Date(NOW.getTime() - 11 * 3_600_000).toISOString(), NOW)).toBe("11h ago");
    });
    it("renders days", () => {
      expect(relativeAge(new Date(NOW.getTime() - 15 * 86_400_000).toISOString(), NOW)).toBe("15d ago");
    });
    it("returns (never) for missing or unparseable", () => {
      expect(relativeAge(undefined, NOW)).toBe("(never)");
      expect(relativeAge("not-a-date", NOW)).toBe("(never)");
    });
  });

  describe("classifyQdrant", () => {
    it("classifies localhost:6333 as local", () => {
      expect(classifyQdrant("http://localhost:6333").kind).toBe("local");
    });
    it("classifies 127.0.0.1 ephemeral port as embedded", () => {
      expect(classifyQdrant("http://127.0.0.1:57331").kind).toBe("embedded");
    });
    it("classifies IPv6 loopback :6333 as local", () => {
      expect(classifyQdrant("http://[::1]:6333").kind).toBe("local");
    });
    it("classifies a non-loopback host as remote and exposes the host", () => {
      const r = classifyQdrant("https://qdrant.internal:6333");
      expect(r.kind).toBe("remote");
      expect(r.host).toBe("qdrant.internal");
    });
    it("falls back to remote for an unparseable url", () => {
      expect(classifyQdrant("::::garbage").kind).toBe("remote");
    });
  });

  describe("wrapName", () => {
    it("returns a single centered line when it fits", () => {
      const lines = wrapName("tea-rags", 14);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toHaveLength(14);
      expect(lines[0].trim()).toBe("tea-rags");
    });
    it("wraps on separators, keeping the separator and centering each line", () => {
      const lines = wrapName("commons-lang-java", 14);
      expect(lines.map((l) => l.trim())).toEqual(["commons-lang-", "java"]);
      expect(lines.every((l) => l.length === 14)).toBe(true);
    });
    it("leaves a too-long separator-less segment intact", () => {
      const lines = wrapName("supercalifragilistic", 10);
      expect(lines).toEqual(["supercalifragilistic"]);
    });
  });

  describe("formatProjectsTable (plain)", () => {
    const out = formatProjectsTable(
      [
        entry({ name: "alpha", path: "/home/u/dup", qdrantUrl: "http://localhost:6333", chunksCount: 11541 }),
        entry({ name: "beta", path: "/home/u/dup", teaRagsVersion: "1.27.0", chunksCount: 9 }),
        entry({ name: null, path: "/home/u/anon", indexedAt: new Date(NOW.getTime() - 20 * 86_400_000).toISOString() }),
      ],
      { now: NOW, colorizer: plain, home: "/home/u" },
    );

    it("emits no ANSI escape codes when the colorizer is disabled", () => {
      expect(out).not.toContain("\x1b");
    });
    it("renders a header row", () => {
      expect(out).toMatch(/NAME/);
      expect(out).toMatch(/CHUNKS/);
      expect(out).toMatch(/QDRANT/);
    });
    it("classifies qdrant per row", () => {
      expect(out).toMatch(/local/);
      expect(out).toMatch(/embedded/);
    });
    it("marks duplicate paths with ⧉", () => {
      expect(out).toContain("⧉");
    });
    it("renders anonymous entries as (no name)", () => {
      expect(out).toContain("(no name)");
    });
    it("flags stale version with ⚠ and shows a footer legend", () => {
      expect(out).toContain("⚠");
      expect(out).toMatch(/duplicate path/);
    });
    it("collapses the home directory to ~", () => {
      expect(out).toMatch(/~\/dup/);
    });
  });
});
