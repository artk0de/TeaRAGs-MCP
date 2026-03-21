import { describe, expect, it } from "vitest";

import type { PresetDescriptors } from "../../../src/core/api/public/dto/explore.js";
import {
  buildFiltersDoc,
  buildIndexingGuide,
  buildOverview,
  buildPresetsDoc,
  buildSearchGuide,
  buildSignalLabelsGuide,
  buildSignalsDoc,
} from "../../../src/mcp/resources/index.js";

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
    it("contains tool routing table", () => {
      const md = buildSearchGuide();
      expect(md).toContain("search_code");
      expect(md).toContain("semantic_search");
      expect(md).toContain("hybrid_search");
      expect(md).toContain("rank_chunks");
      expect(md).toContain("find_similar");
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

    it("contains hybrid_search examples", () => {
      const md = buildSearchGuide();
      expect(md).toContain("TODO");
      expect(md).toContain("FIXME");
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
      const md = buildSignalLabelsGuide();
      expect(md).toContain("# Signal Labels");
      expect(md).toContain("get_index_metrics");
      expect(md).toContain("ranking overlay");
    });

    it("contains git file signal table", () => {
      const md = buildSignalLabelsGuide();
      expect(md).toContain("## Git File Signals");
      expect(md).toContain("git.file.commitCount");
      expect(md).toContain("git.file.ageDays");
      expect(md).toContain("git.file.bugFixRate");
      expect(md).toContain("git.file.dominantAuthorPct");
    });

    it("contains git chunk signal table", () => {
      const md = buildSignalLabelsGuide();
      expect(md).toContain("## Git Chunk Signals");
      expect(md).toContain("git.chunk.commitCount");
      expect(md).toContain("git.chunk.churnRatio");
    });

    it("contains static signal table", () => {
      const md = buildSignalLabelsGuide();
      expect(md).toContain("## Static Signals");
      expect(md).toContain("methodLines");
      expect(md).toContain("methodDensity");
      expect(md).toContain("decomposition_candidate");
    });

    it("contains label resolution algorithm", () => {
      const md = buildSignalLabelsGuide();
      expect(md).toContain("## Label Resolution Algorithm");
      expect(md).toContain("ascending percentile order");
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
