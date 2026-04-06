import { describe, expect, it } from "vitest";

import type { PresetDescriptors } from "../../../src/core/api/public/dto/explore.js";
import type { PayloadSignalDescriptor } from "../../../src/core/contracts/types/trajectory.js";
import {
  buildFiltersDoc,
  buildIndexingGuide,
  buildOverview,
  buildPresetsDoc,
  buildSearchGuide,
  buildSignalLabelsGuide,
  buildSignalsDoc,
} from "../../../src/mcp/resources/index.js";

const mockPayloadSignals: PayloadSignalDescriptor[] = [
  {
    key: "git.file.commitCount",
    type: "number",
    description: "Total commits touching this file",
    stats: { labels: { p25: "low", p50: "typical", p75: "high", p95: "extreme" } },
  },
  {
    key: "git.file.ageDays",
    type: "number",
    description: "Days since last modification",
    stats: { labels: { p25: "recent", p50: "typical", p75: "old", p95: "legacy" } },
  },
  {
    key: "git.chunk.bugFixRate",
    type: "number",
    description: "Percentage of bug-fix commits",
    stats: { labels: { p50: "healthy", p75: "concerning", p95: "critical" } },
  },
  {
    key: "methodLines",
    type: "number",
    description: "Lines in method",
    stats: { labels: { p50: "small", p75: "large", p95: "decomposition_candidate" } },
  },
  // Signal without labels — should be excluded
  {
    key: "git.file.dominantAuthor",
    type: "string",
    description: "Primary file author",
  },
  // Signal with empty labels — should be excluded
  {
    key: "git.file.lastModifiedAt",
    type: "timestamp",
    description: "Last modification time",
    stats: { labels: {} },
  },
];

const mockDescriptors: PresetDescriptors = {
  presetNames: {
    semantic_search: ["relevance", "techDebt"],
    search_code: ["relevance", "recent"],
  },
  presetDetails: {
    semantic_search: [
      {
        name: "relevance",
        description: "Pure similarity",
        weights: ["similarity"],
        tools: ["semantic_search", "hybrid_search"],
      },
      {
        name: "techDebt",
        description: "Legacy code finder",
        weights: ["age", "churn", "similarity"],
        tools: ["semantic_search", "hybrid_search"],
      },
    ],
    search_code: [
      { name: "relevance", description: "Pure similarity", weights: ["similarity"], tools: ["search_code"] },
      { name: "recent", description: "Recent code", weights: ["recency", "similarity"], tools: ["search_code"] },
    ],
  },
  signalDescriptors: [
    { name: "similarity", description: "Semantic similarity score" },
    { name: "recency", description: "Inverse of age" },
    { name: "age", description: "Direct age signal" },
    { name: "churn", description: "Commit frequency" },
  ],
  payloadSignals: mockPayloadSignals,
};

describe("Resource builders", () => {
  describe("buildOverview", () => {
    it("lists all schema resource URIs", () => {
      const md = buildOverview();
      expect(md).toContain("tea-rags://schema/presets");
      expect(md).toContain("tea-rags://schema/signals");
      expect(md).toContain("tea-rags://schema/filters");
    });

    it("lists all tools in quick reference", () => {
      const md = buildOverview();
      expect(md).toContain("search_code");
      expect(md).toContain("semantic_search");
      expect(md).toContain("hybrid_search");
      expect(md).toContain("rank_chunks");
      expect(md).toContain("find_similar");
    });

    it("lists guide resource URIs in Guides section", () => {
      const md = buildOverview();
      expect(md).toContain("## Guides");
      expect(md).toContain("tea-rags://schema/search-guide");
      expect(md).toContain("tea-rags://schema/indexing-guide");
    });
  });

  describe("buildPresetsDoc", () => {
    it("contains all preset names with descriptions", () => {
      const md = buildPresetsDoc(mockDescriptors);
      expect(md).toContain("relevance");
      expect(md).toContain("Pure similarity");
      expect(md).toContain("techDebt");
      expect(md).toContain("Legacy code finder");
      expect(md).toContain("recent");
      expect(md).toContain("Recent code");
    });

    it("lists weight keys for each preset", () => {
      const md = buildPresetsDoc(mockDescriptors);
      expect(md).toContain("age");
      expect(md).toContain("churn");
      expect(md).toContain("similarity");
    });

    it("lists available tools for each preset", () => {
      const md = buildPresetsDoc(mockDescriptors);
      expect(md).toContain("semantic_search");
      expect(md).toContain("search_code");
    });

    it("handles empty presets for a tool gracefully", () => {
      const empty: PresetDescriptors = {
        presetNames: { some_tool: [] },
        presetDetails: { some_tool: [] },
        signalDescriptors: [],
      };
      const md = buildPresetsDoc(empty);
      expect(md).toBeDefined();
      expect(typeof md).toBe("string");
    });
  });

  describe("buildSignalsDoc", () => {
    it("contains all signal names with descriptions", () => {
      const md = buildSignalsDoc(mockDescriptors);
      expect(md).toContain("similarity");
      expect(md).toContain("Semantic similarity score");
      expect(md).toContain("recency");
      expect(md).toContain("Inverse of age");
    });
  });

  describe("buildSearchGuide", () => {
    it("contains parameter examples for each tool", () => {
      const md = buildSearchGuide();
      expect(md).toContain("search_code Examples");
      expect(md).toContain("semantic_search Examples");
      expect(md).toContain("hybrid_search Examples");
      expect(md).toContain("find_symbol Examples");
      expect(md).toContain("rank_chunks Examples");
    });

    it("contains search_code examples", () => {
      const md = buildSearchGuide();
      expect(md).toContain("minAgeDays");
      expect(md).toContain("author");
      expect(md).toContain("taskId");
    });

    it("contains semantic_search examples", () => {
      const md = buildSearchGuide();
      expect(md).toContain("ownership");
      expect(md).toContain("techDebt");
      expect(md).toContain("metaOnly");
    });

    it("contains find_symbol relativePath examples", () => {
      const md = buildSearchGuide();
      expect(md).toContain("relativePath");
      expect(md).toContain("Reranker#rerank");
    });
  });

  describe("buildIndexingGuide", () => {
    it("contains index_codebase options", () => {
      const md = buildIndexingGuide();
      expect(md).toContain("`path`");
      expect(md).toContain("forceReindex");
      expect(md).toContain("extensions");
      expect(md).toContain("ignorePatterns");
    });

    it("contains git metadata section", () => {
      const md = buildIndexingGuide();
      expect(md).toContain("CODE_ENABLE_GIT_METADATA");
      expect(md).toContain("dominantAuthor");
      expect(md).toContain("ISO 8601");
    });

    it("contains reindex workflow", () => {
      const md = buildIndexingGuide();
      expect(md).toContain("index_codebase");
      expect(md).toContain("reindex_changes");
      expect(md).toContain("get_index_status");
      expect(md).toContain("clear_index");
    });
  });

  describe("buildSignalLabelsGuide", () => {
    it("contains header and how-it-works section", () => {
      const md = buildSignalLabelsGuide(mockPayloadSignals);
      expect(md).toContain("# Signal Labels");
      expect(md).toContain("get_index_metrics");
      expect(md).toContain("ranking overlay");
    });

    it("includes all signals with stats.labels in output", () => {
      const md = buildSignalLabelsGuide(mockPayloadSignals);
      expect(md).toContain("git.file.commitCount");
      expect(md).toContain("git.file.ageDays");
      expect(md).toContain("git.chunk.bugFixRate");
      expect(md).toContain("methodLines");
    });

    it("excludes signals without labels", () => {
      const md = buildSignalLabelsGuide(mockPayloadSignals);
      // dominantAuthor has no stats.labels
      expect(md).not.toContain("git.file.dominantAuthor");
      // lastModifiedAt has empty labels
      expect(md).not.toContain("git.file.lastModifiedAt");
    });

    it("groups signals by domain prefix", () => {
      const md = buildSignalLabelsGuide(mockPayloadSignals);
      expect(md).toContain("## Git File Signals");
      expect(md).toContain("## Git Chunk Signals");
      expect(md).toContain("## Static Signals");
    });

    it("generates valid Markdown tables with percentile labels", () => {
      const md = buildSignalLabelsGuide(mockPayloadSignals);
      // Check table header
      expect(md).toContain("| Signal | Labels (percentile → name) |");
      expect(md).toContain("|--------|---------------------------|");
      // Check specific label entries in sorted percentile order
      expect(md).toContain("p25: low, p50: typical, p75: high, p95: extreme");
      expect(md).toContain("p50: healthy, p75: concerning, p95: critical");
      expect(md).toContain("p50: small, p75: large, p95: decomposition_candidate");
    });

    it("contains label resolution algorithm", () => {
      const md = buildSignalLabelsGuide(mockPayloadSignals);
      expect(md).toContain("## Label Resolution Algorithm");
      expect(md).toContain("ascending percentile order");
    });

    it("handles empty payload signals array", () => {
      const md = buildSignalLabelsGuide([]);
      expect(md).toContain("# Signal Labels");
      expect(md).toContain("## Label Resolution Algorithm");
      // No group sections when no signals with labels
      expect(md).not.toContain("## Git File Signals");
    });
  });

  describe("buildFiltersDoc", () => {
    it("contains Qdrant operator syntax", () => {
      const md = buildFiltersDoc();
      expect(md).toContain("match");
      expect(md).toContain("range");
      expect(md).toContain("must");
      expect(md).toContain("should");
      expect(md).toContain("must_not");
    });

    it("contains threshold guidance referencing get_index_metrics", () => {
      const md = buildFiltersDoc();
      expect(md).toContain("get_index_metrics");
      expect(md).toContain("signal-labels");
    });

    it("contains available fields with level prefix", () => {
      const md = buildFiltersDoc();
      expect(md).toContain("relativePath");
      expect(md).toContain("git.file.");
      expect(md).toContain("git.chunk.");
      expect(md).toContain("imports");
    });

    it("warns about filter level for time-based filters", () => {
      const md = buildFiltersDoc();
      expect(md).toContain("level");
      expect(md).toContain("ageDays=0");
    });
  });
});
