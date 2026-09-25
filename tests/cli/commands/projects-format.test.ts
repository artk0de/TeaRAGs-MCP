import { describe, expect, it } from "vitest";

import {
  classifyQdrant,
  formatOrphansTable,
  formatProjectInfo,
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
  };
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
    it("classifies the 'embedded' sentinel as embedded (2nfdm registry persistence model)", () => {
      expect(classifyQdrant("embedded").kind).toBe("embedded");
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

describe("formatProjectInfo", () => {
  const colored = createColorizer({ env: { FORCE_COLOR: "1" }, isTTY: true });
  const full = entry({
    name: "alpha",
    collectionName: "code_abc",
    path: "/home/u/alpha",
    qdrantUrl: "http://localhost:6333",
    embeddingModel: "jina",
    embeddingDimensions: 768,
    chunksCount: 42,
    indexedAt: "2026-06-06T12:00:00.000Z",
    teaRagsVersion: "1.28.0",
  });

  it("renders an aligned key: value block (color off)", () => {
    expect(formatProjectInfo(full, "/home/u/alpha", plain)).toBe(
      [
        "name:                alpha",
        "collectionName:      code_abc",
        "path:                /home/u/alpha",
        "qdrantUrl:           http://localhost:6333",
        "embeddingModel:      jina",
        "embeddingDimensions: 768",
        "chunksCount:         42",
        "indexedAt:           2026-06-06T12:00:00.000Z",
        "teaRagsVersion:      1.28.0",
        "",
      ].join("\n"),
    );
  });

  it("adds the realpath and a re-register hint when the path resolves elsewhere", () => {
    const out = formatProjectInfo(full, "/mnt/alpha", plain);
    expect(out).toContain("realpath:            /mnt/alpha\n");
    expect(out).toContain("                     (symlink or moved mount — re-register to refresh)\n");
  });

  it("renders placeholders for a missing directory and empty fields", () => {
    const out = formatProjectInfo(
      entry({
        name: null,
        qdrantUrl: "",
        embeddingModel: "",
        embeddingDimensions: 0,
        indexedAt: "",
        teaRagsVersion: "",
      }),
      null,
      plain,
    );
    expect(out).toContain("name:                (no name)\n");
    expect(out).toContain("realpath:            (missing on disk)\n");
    expect(out).toContain("qdrantUrl:           (none)\n");
    expect(out).toContain("embeddingModel:      (none)\n");
    expect(out).toContain("embeddingDimensions: 0\n");
    expect(out).toContain("indexedAt:           (never)\n");
    expect(out).toContain("teaRagsVersion:      (unknown)\n");
  });

  it("emits no ANSI escape codes when the colorizer is disabled", () => {
    expect(formatProjectInfo(full, null, plain)).not.toContain("\x1b");
  });

  it("paints the name as brand, keys dim, a missing directory as alert, placeholders dim", () => {
    const out = formatProjectInfo(entry({ name: "alpha", indexedAt: "" }), null, colored);
    expect(out).toContain(colored.bold(colored.brand("alpha")));
    expect(out).toContain(colored.dim("collectionName:     "));
    expect(out).toContain(colored.alert("(missing on disk)"));
    expect(out).toContain(colored.dim("(never)"));
  });

  it("paints an unnamed entry and a moved mount as warnings", () => {
    const out = formatProjectInfo(entry({ name: null }), "/mnt/elsewhere", colored);
    expect(out).toContain(colored.bold(colored.warn("(no name)")));
    expect(out).toContain(colored.warn("/mnt/elsewhere"));
    expect(out).toContain(colored.warn("(symlink or moved mount — re-register to refresh)"));
  });
});

describe("formatOrphansTable", () => {
  const colored = createColorizer({ env: { FORCE_COLOR: "1" }, isTTY: true });
  const rows = [
    { collectionName: "code_orphan_1", chunksCount: 11541 },
    { collectionName: "code_b", chunksCount: 9 },
  ];

  it("renders an aligned COLLECTION / CHUNKS table (color off)", () => {
    expect(formatOrphansTable(rows, plain)).toBe(
      ["COLLECTION       CHUNKS", "code_orphan_1     11.5k", "code_b                9", ""].join("\n"),
    );
  });

  it("widens the collection column to the header when every name is shorter", () => {
    expect(formatOrphansTable([{ collectionName: "c", chunksCount: 0 }], plain)).toBe(
      ["COLLECTION    CHUNKS", "c                  0", ""].join("\n"),
    );
  });

  it("emits no ANSI escape codes when the colorizer is disabled", () => {
    expect(formatOrphansTable(rows, plain)).not.toContain("\x1b");
  });

  it("paints the header as bold brand and each orphan name as a warning", () => {
    const out = formatOrphansTable(rows, colored);
    expect(out.split("\n")[0]).toBe(colored.bold(colored.brand("COLLECTION       CHUNKS")));
    expect(out).toContain(colored.warn("code_orphan_1"));
  });
});
