import { describe, expect, it } from "vitest";

import {
  alignHead,
  alignQualifiers,
  anchoredHeadCandidates,
  correctedSimilarityFloor,
  establishedModifiers,
  MIN_NULL_SAMPLE_HEADS,
  modifierLift,
  NULL_SIMILARITY_QUANTILE,
  nullHeadSample,
  nullSimilarityDistribution,
  pathTerms,
  perComparisonQuantile,
  sharesWordStem,
  similarityQuantile,
  type ModifierUse,
} from "../../../../../src/core/domains/explore/naming-lexicon/term-alignment.js";

function mod(word: string, heads: string[], dirs: string[], count: number): ModifierUse {
  return { word, heads: new Set(heads), dirs: new Set(dirs), count };
}

describe("alignHead", () => {
  it("aligns the head to the dominant spelling", () => {
    expect(
      alignHead(
        { head: ["document"], qualifiers: [] },
        new Map([
          ["doc", 200],
          ["document", 3],
        ]),
      ),
    ).toBe("doc");
  });

  it("keeps a head that already is the dominant spelling", () => {
    expect(
      alignHead(
        { head: ["doc"], qualifiers: ["calculated"] },
        new Map([
          ["doc", 200],
          ["document", 3],
        ]),
      ),
    ).toBeUndefined();
  });

  it("does not treat an unrelated word as a spelling variant", () => {
    // `preset` / `presenter`: `preset` is not short enough to abbreviate `presenter`.
    expect(
      alignHead(
        { head: ["presenter"], qualifiers: [] },
        new Map([
          ["preset", 90],
          ["presenter", 2],
        ]),
      ),
    ).toBeUndefined();
  });

  it("an empty head aligns to nothing", () => {
    expect(alignHead({ head: [], qualifiers: [] }, new Map([["doc", 1]]))).toBeUndefined();
  });

  // bd tea-rags-mcp-tun7x: live, `FileScanner` got `scan` as the project's spelling of `scanner`.
  // A stem plus an inflection or agent suffix is ANOTHER word (the scan vs what scans), not a spelling.
  it("a word's stem is not its spelling variant: `scan` / `scanner`, `run` / `runner`", () => {
    expect(
      alignHead(
        { head: ["scanner"], qualifiers: ["file"] },
        new Map([
          ["scan", 6],
          ["scanner", 1],
        ]),
      ),
    ).toBeUndefined();
    expect(
      alignHead(
        { head: ["runner"], qualifiers: [] },
        new Map([
          ["run", 6],
          ["runner", 1],
        ]),
      ),
    ).toBeUndefined();
  });

  it("a clipping is still a spelling: `stats` / `statistics`, `metadata` / `meta`", () => {
    expect(
      alignHead(
        { head: ["statistics"], qualifiers: ["signal"] },
        new Map([
          ["stats", 9],
          ["statistics", 1],
        ]),
      ),
    ).toBe("stats");
    expect(
      alignHead(
        { head: ["meta"], qualifiers: ["snapshot"] },
        new Map([
          ["metadata", 5],
          ["meta", 2],
        ]),
      ),
    ).toBe("metadata");
  });
});

// bd tea-rags-mcp-i569j, live on taxdome: `Refusals` was offered `refs` (2 types) as the project's
// spelling of `refusals`. `refs` clips `references` and `refunds` just as well — the project
// writes all three — so it spells none of them in particular.
describe("alignHead — a clipping several project words share spells none of them", () => {
  it("`refs` is no spelling of `refusals` when the project also writes `refunds` and `references`", () => {
    expect(
      alignHead(
        { head: ["refusals"], qualifiers: [] },
        new Map([
          ["refs", 2],
          ["refusals", 1],
          ["refunds", 3],
          ["references", 1],
        ]),
      ),
    ).toBeUndefined();
  });

  it("the draft word's own inflections are one word: `stats` still spells `statistic(s)`", () => {
    expect(
      alignHead(
        { head: ["statistics"], qualifiers: ["signal"] },
        new Map([
          ["stats", 9],
          ["statistics", 1],
          ["statistic", 1],
        ]),
      ),
    ).toBe("stats");
  });
});

// bd tea-rags-mcp-i569j, live on taxdome: `TaxpayerLookupError` was offered `taxes` for
// `taxpayer`, `Refusals` a head `refs`. A candidate sharing the replaced word's stem restates
// it — the embedding scores the pair close BECAUSE of the shared stem — it is no other word.
describe("sharesWordStem — an inflected stem is shared", () => {
  it("one word is the shared prefix plus an inflection: `taxes` / `taxpayer`, `refs` / `refusals`", () => {
    expect(sharesWordStem("taxes", "taxpayer")).toBe(true);
    expect(sharesWordStem("taxpayer", "taxes")).toBe(true);
    expect(sharesWordStem("refs", "refusals")).toBe(true);
  });

  it("a shared prefix under three letters is no stem: `user` / `usage`", () => {
    expect(sharesWordStem("user", "usage")).toBe(false);
  });

  it("words sharing no stem stay apart: `inconsistent` / `refusals`, `staleness` / `freshness`", () => {
    expect(sharesWordStem("inconsistent", "refusals")).toBe(false);
    expect(sharesWordStem("staleness", "freshness")).toBe(false);
  });
});

describe("candidates sharing the replaced word's stem are no alternatives (bd tea-rags-mcp-i569j)", () => {
  it("alignQualifiers never offers a modifier sharing a draft qualifier's stem", () => {
    const established = [
      mod("taxes", ["return", "form"], ["app/a", "app/b"], 12),
      mod("vendor", ["client", "error"], ["app/c", "app/d"], 12),
    ];
    const lift = new Map([
      ["taxes", 40],
      ["vendor", 10],
    ]);
    expect(
      alignQualifiers({ head: ["error"], qualifiers: ["taxpayer", "lookup"] }, established, lift, 2).map((a) => a.word),
    ).toEqual(["vendor"]);
  });

  it("anchoredHeadCandidates never offers a head sharing the draft head's stem", () => {
    const rows = [
      { shortName: "CampaignRefs", relPath: "app/lib/x/campaign_refs.rb" },
      { shortName: "TagRefs", relPath: "app/lib/x/tag_refs.rb" },
      { shortName: "UploadBuffer", relPath: "app/lib/x/upload_buffer.rb" },
      { shortName: "TargetBuffer", relPath: "app/lib/x/target_buffer.rb" },
    ];
    const counts = new Map([
      ["refs", 2],
      ["buffer", 2],
    ]);
    expect(
      anchoredHeadCandidates({ head: ["refusals"], qualifiers: [] }, "app/lib/x", rows, counts).map((c) => c.word),
    ).toEqual(["buffer"]);
  });
});

// bd tea-rags-mcp-tun7x: a token carrying a digit (`v1`, `v11`) names a value, not a concept.
describe("version tokens are not modifier vocabulary", () => {
  it("establishedModifiers drops a token with a digit", () => {
    expect(
      establishedModifiers([
        mod("v1", ["rebuild", "set"], ["a", "b"], 2),
        mod("sparse", ["x", "y"], ["a", "b"], 2),
      ]).map((use) => use.word),
    ).toEqual(["sparse"]);
  });

  it("alignQualifiers does not replace a draft qualifier that carries a digit", () => {
    expect(
      alignQualifiers(
        { head: ["store"], qualifiers: ["v11"] },
        [mod("sparse", ["x", "y"], ["a", "b"], 2)],
        new Map([["sparse", 10]]),
        2,
      ),
    ).toEqual([]);
  });
});

describe("establishedModifiers", () => {
  it("keeps a modifier combining with several heads in several directories", () => {
    const uses = [
      mod("predefined", ["template", "field"], ["src/templates", "src/fields"], 12),
      mod("cached", ["file"], ["src/a", "src/b"], 5),
      mod("local", ["binding", "scope"], ["src/a"], 7),
    ];
    expect(establishedModifiers(uses).map((use) => use.word)).toEqual(["predefined"]);
  });
});

describe("alignQualifiers", () => {
  it("offers an established modifier with lift above the floor", () => {
    const uses = [mod("predefined", ["template", "field"], ["src/templates", "src/fields"], 12)];
    const lift = modifierLift(establishedModifiers(uses), ["PredefinedTemplate", "PredefinedField"], 4000);
    expect(alignQualifiers({ head: ["doc"], qualifiers: ["calculated"] }, establishedModifiers(uses), lift, 2)).toEqual(
      [
        expect.objectContaining({
          word: "predefined",
          heads: ["field", "template"],
        }),
      ],
    );
  });

  it("nothing above the floor is a new concept", () => {
    const uses = [mod("predefined", ["template", "field"], ["src/templates", "src/fields"], 12)];
    const established = establishedModifiers(uses);
    // The concept search returned code where `predefined` never qualifies a name.
    const lift = modifierLift(established, ["CalculatedTotal", "TaxAmount"], 4000);
    expect(lift.get("predefined")).toBe(0);
    expect(alignQualifiers({ head: ["doc"], qualifiers: ["calculated"] }, established, lift, 2)).toEqual([]);
  });

  it("computes lift as concept frequency over project frequency", () => {
    const established = [mod("predefined", ["template", "field"], ["src/templates", "src/fields"], 40)];
    // 1 of 4 concept names (0.25) against 40 of 4000 project types (0.01) → 25.
    const lift = modifierLift(established, ["PredefinedTemplate", "Doc", "TaxDoc", "Field"], 4000);
    expect(lift.get("predefined")).toBeCloseTo(25);
  });

  it("returns alternatives by lift, with heads and domains sorted", () => {
    const established = [
      mod("predefined", ["template", "field"], ["src/templates", "src/fields"], 12),
      mod("shared", ["config", "cache"], ["src/b", "src/a"], 30),
    ];
    const lift = new Map([
      ["predefined", 10],
      ["shared", 40],
    ]);
    expect(alignQualifiers({ head: ["doc"], qualifiers: ["calculated"] }, established, lift, 2)).toEqual([
      { word: "shared", heads: ["cache", "config"], domains: ["src/a", "src/b"], lift: 40 },
      { word: "predefined", heads: ["field", "template"], domains: ["src/fields", "src/templates"], lift: 10 },
    ]);
  });

  it("offers nothing when the draft's qualifier is already established", () => {
    const established = [mod("predefined", ["template", "field"], ["src/templates", "src/fields"], 12)];
    const lift = new Map([["predefined", 50]]);
    expect(alignQualifiers({ head: ["doc"], qualifiers: ["predefined"] }, established, lift, 2)).toEqual([]);
  });

  it("offers nothing to a name without qualifiers", () => {
    const established = [mod("predefined", ["template", "field"], ["src/templates", "src/fields"], 12)];
    expect(alignQualifiers({ head: ["doc"], qualifiers: [] }, established, new Map([["predefined", 50]]), 2)).toEqual(
      [],
    );
  });
});

// bd tea-rags-mcp-433d2: the heads a synonym head could be replaced by — heads of
// the types sharing a qualifier with the draft or living in its directory.
describe("anchoredHeadCandidates", () => {
  const type = (shortName: string, relPath: string) => ({ shortName, relPath });
  const counts = (rows: readonly { shortName: string }[]) => {
    const map = new Map<string, number>();
    for (const { shortName } of rows) {
      const head = shortName.replace(/^.*(?=[A-Z])/, "").toLowerCase();
      map.set(head, (map.get(head) ?? 0) + 1);
    }
    return map;
  };

  it("offers the heads of types sharing a qualifier, with the anchored types as examples", () => {
    const rows = [
      type("IndexMetrics", "src/dto/metrics.ts"),
      type("SignalMetrics", "src/dto/metrics.ts"),
      type("IndexStatus", "src/dto/status.ts"),
      type("RunStatus", "src/run/status.ts"),
      type("FooWidget", "src/widgets/foo.ts"),
      type("BarWidget", "src/widgets/bar.ts"),
    ];
    const candidates = anchoredHeadCandidates(
      { head: ["numbers"], qualifiers: ["index"] },
      "src/api",
      rows,
      counts(rows),
    );
    expect(candidates).toEqual([
      { word: "metrics", examples: ["IndexMetrics"], domains: ["src/dto"] },
      { word: "status", examples: ["IndexStatus"], domains: ["src/dto"] },
    ]);
  });

  it("offers the heads of types in the draft's directory, never a word the draft already carries", () => {
    const rows = [
      type("CodeChunker", "src/chunker/code.ts"),
      type("MarkdownChunker", "src/chunker/markdown.ts"),
      type("ChunkSplitter", "src/other/splitter.ts"),
      type("SplitterChunk", "src/other/chunk.ts"),
      type("TextChunk", "src/chunker/text.ts"),
    ];
    const candidates = anchoredHeadCandidates(
      { head: ["splitter"], qualifiers: ["chunk"] },
      "src/chunker",
      rows,
      counts(rows),
    );
    expect(candidates.map((c) => c.word)).toEqual(["chunker"]);
    expect(candidates[0]).toMatchObject({ examples: ["CodeChunker", "MarkdownChunker"] });
  });

  it("drops a head fewer than two project types carry — a one-off word is not the project's term", () => {
    const rows = [
      type("IndexSite", "src/a/site.ts"),
      type("IndexMetrics", "src/a/m.ts"),
      type("RunMetrics", "src/b/m.ts"),
    ];
    expect(
      anchoredHeadCandidates({ head: ["numbers"], qualifiers: ["index"] }, "src/z", rows, counts(rows)).map(
        (c) => c.word,
      ),
    ).toEqual(["metrics"]);
  });

  it("admits a head only one type ends in when usage establishes it (a central type, not a one-off)", () => {
    const rows = [type("Reranker", "src/explore/reranker.ts"), type("SearchConfidence", "src/explore/confidence.ts")];
    const slots = { head: ["scorer"], qualifiers: ["search"] };
    expect(anchoredHeadCandidates(slots, "src/explore", rows, counts(rows)).map((c) => c.word)).toEqual([]);
    expect(
      anchoredHeadCandidates(slots, "src/explore", rows, counts(rows), new Set(["reranker"])).map((c) => c.word),
    ).toEqual(["reranker"]);
  });

  it("a draft with no qualifier and an empty directory has no candidates", () => {
    const rows = [type("IndexMetrics", "src/a/m.ts"), type("RunMetrics", "src/b/m.ts")];
    expect(anchoredHeadCandidates({ head: ["numbers"], qualifiers: [] }, "src/z", rows, counts(rows))).toEqual([]);
  });
});

// bd tea-rags-mcp-433d2: the floor a head similarity must clear is read off the project's
// own null distribution — similarities of random pairs of its head words.
describe("nullHeadSample", () => {
  const eligible = Array.from({ length: 40 }, (_, i) => [`w${String(i).padStart(2, "0")}`, 2 + (i % 7)] as const);
  const counts = new Map<string, number>([...eligible, ["lonely", 1]]);

  it("draws only heads carried by ≥ 2 types, every one of them when they fit", () => {
    expect(new Set(nullHeadSample(counts))).toEqual(new Set(eligible.map(([word]) => word)));
  });

  it("is deterministic and independent of the order the heads were counted in", () => {
    const reversed = new Map([...counts].reverse());
    expect(nullHeadSample(reversed, 10)).toEqual(nullHeadSample(counts, 10));
    expect(nullHeadSample(counts, 10)).toHaveLength(10);
  });

  it("is not the most-carried heads: frequent words are generic and closer to each other", () => {
    // The 10 most-carried heads (count 8) would bias the null distribution upward.
    const mostCarried = eligible.filter(([, count]) => count === 8).map(([word]) => word);
    expect(nullHeadSample(counts, mostCarried.length).sort()).not.toEqual(mostCarried.sort());
  });
});

describe("similarityQuantile", () => {
  it("interpolates linearly between order statistics", () => {
    expect(similarityQuantile([5, 1, 3, 2, 4], 0.9)).toBeCloseTo(4.6);
    expect(similarityQuantile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(similarityQuantile([0.7], 0.9)).toBe(0.7);
  });

  it("an empty sample has no quantile", () => {
    expect(similarityQuantile([], 0.9)).toBeUndefined();
  });
});

describe("nullSimilarityDistribution", () => {
  const heads = (n: number) => Array.from({ length: n }, (_, i) => `h${i}`);

  it("is the sorted scores of every pair of sampled heads", () => {
    // Score = distance of the two indices / 100: pairs of 10 heads → 45 scores.
    const score = (a: string, b: string) => Math.abs(Number(a.slice(1)) - Number(b.slice(1))) / 100;
    const pairs: number[] = [];
    for (let i = 0; i < 10; i++) for (let j = i + 1; j < 10; j++) pairs.push((j - i) / 100);
    expect(nullSimilarityDistribution(heads(10), score)).toEqual(pairs.sort((a, b) => a - b));
  });

  it("fewer than MIN_NULL_SAMPLE_HEADS heads → no distribution: too small a population to measure", () => {
    expect(nullSimilarityDistribution(heads(MIN_NULL_SAMPLE_HEADS - 1), () => 0.5)).toBeUndefined();
    expect(nullSimilarityDistribution(heads(MIN_NULL_SAMPLE_HEADS), () => 0.5)).toHaveLength(45);
  });
});

// bd tea-rags-mcp-433d2: a draft compared on m pairs gets m chances for a random pair to clear the floor.
describe("perComparisonQuantile — Šidák correction for m comparisons", () => {
  it("one comparison → the family-wise level itself", () => {
    expect(NULL_SIMILARITY_QUANTILE).toBe(0.9);
    expect(perComparisonQuantile(1, 2016)).toBeCloseTo(0.9);
  });

  it("m comparisons → 0.9^(1/m): the chance that ANY random pair clears it stays 10%", () => {
    expect(perComparisonQuantile(5, 2016)).toBeCloseTo(0.9 ** (1 / 5));
    expect(perComparisonQuantile(5, 2016) ** 5).toBeCloseTo(0.9);
  });

  it("never beyond what the sample resolves: at most 1 − 1/pairs", () => {
    expect(perComparisonQuantile(1000, 45)).toBeCloseTo(1 - 1 / 45);
    expect(perComparisonQuantile(50, 2016)).toBeCloseTo(0.9 ** (1 / 50));
  });

  it("no comparison counts as one", () => {
    expect(perComparisonQuantile(0, 2016)).toBeCloseTo(0.9);
  });
});

describe("correctedSimilarityFloor", () => {
  /** 0.000, 0.001, … 1.000 — the q quantile is q. */
  const UNIFORM = Array.from({ length: 1001 }, (_, i) => i / 1000);

  it("one comparison → the null distribution's 0.9 quantile", () => {
    expect(correctedSimilarityFloor(UNIFORM, 1)).toBeCloseTo(0.9);
  });

  it("five comparisons → its 0.9^(1/5) quantile, a stricter floor", () => {
    expect(correctedSimilarityFloor(UNIFORM, 5)).toBeCloseTo(0.9 ** (1 / 5));
    expect(correctedSimilarityFloor(UNIFORM, 5)).toBeGreaterThan(correctedSimilarityFloor(UNIFORM, 1));
  });
});

// bd tea-rags-mcp-433d2: the directory a draft lives in names its concept too
// (`maintenance/freshness/` for `IndexStalenessChecker`).
describe("pathTerms", () => {
  /** Type names in the code nearest the draft's concept. */
  const concept = ["IndexFreshnessCheck", "CommitDriftMonitor", "ChunkerPool"];

  it("offers the draft's directory words a type in the concept code carries", () => {
    expect(
      pathTerms(
        "src/core/domains/maintenance/freshness/staleness-checker.ts",
        ["index", "staleness", "checker"],
        concept,
      ),
    ).toEqual([{ word: "freshness", dir: "src/core/domains/maintenance/freshness" }]);
  });

  it("a directory word no concept type carries is structure, not a term (`core`, `domains`, `maintenance`)", () => {
    // Measured on the self-index: the words of any type or of any directory with ≥ 2 files let
    // `core`, `api`, `static`, `explore`, `ingest`, `maintenance` through — 7 wrong alternatives, 0 hits.
    expect(pathTerms("src/core/domains/maintenance/ops.ts", ["maintenance", "ops"], ["MaintenanceOps"])).toEqual([]);
    expect(pathTerms("src/core/domains/maintenance/x.ts", ["x"], ["CoreThing"])).toEqual([
      { word: "core", dir: "src/core" },
    ]);
  });

  it("never a word the draft already carries", () => {
    expect(pathTerms("src/core/domains/ingest/chunker/pool.ts", ["chunker", "pool"], concept)).toEqual([]);
  });

  it("splits a hyphenated segment into words", () => {
    expect(pathTerms("src/naming-lexicon/draft.ts", ["draft"], ["LexiconEntry"]).map((t) => t.word)).toEqual([
      "lexicon",
    ]);
  });
});
