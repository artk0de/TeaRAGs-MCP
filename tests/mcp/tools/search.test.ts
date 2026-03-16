import { describe, expect, it } from "vitest";

import { globToTextFilter } from "../../../src/core/adapters/qdrant/filters/glob.js";
import { staticFilters } from "../../../src/core/domains/trajectory/static/filters.js";

describe("Search tools glob pre-filter", () => {
  describe("globToTextFilter", () => {
    it("strips wildcards and keeps path with trailing slash", () => {
      const result = globToTextFilter("src/core/domains/explore/**");
      expect(result.must).toEqual([{ key: "relativePath", match: { text: "src/core/domains/explore/" } }]);
    });

    it("handles middle wildcard pattern", () => {
      const result = globToTextFilter("**/workflow/**");
      expect(result.must).toEqual([{ key: "relativePath", match: { text: "workflow/" } }]);
    });

    it("handles extension pattern", () => {
      const result = globToTextFilter("**/*.ts");
      expect(result.must).toEqual([{ key: "relativePath", match: { text: ".ts" } }]);
    });

    it("handles brace expansion with should", () => {
      const result = globToTextFilter("{app/services/**,app/helpers/**}");
      // Should produce OR conditions
      expect(result.must).toBeDefined();
      expect(result.must).toHaveLength(1);
    });

    it("returns empty for pure wildcard", () => {
      const result = globToTextFilter("**/*");
      expect(result).toEqual({});
    });

    it("negation produces must_not", () => {
      const result = globToTextFilter("!**/explore/**");
      expect(result.must_not).toEqual([{ key: "relativePath", match: { text: "explore/" } }]);
      expect(result.must).toBeUndefined();
    });

    it("brace with negation splits into must (should) + must_not", () => {
      const result = globToTextFilter("{src/core/adapters/**,!**/filters/**}");
      expect(result.must).toBeDefined();
      expect(result.must_not).toEqual([{ key: "relativePath", match: { text: "filters/" } }]);
    });

    it("multi-brace without negation produces should", () => {
      const result = globToTextFilter("{src/bootstrap/**,src/mcp/**,src/core/**}");
      expect(result.must).toBeDefined();
      expect(result.must).toHaveLength(1); // single should wrapper
      expect(result.must_not).toBeUndefined();
    });

    it("deep path preserves all segments", () => {
      const result = globToTextFilter("src/core/domains/ingest/pipeline/**");
      expect(result.must).toEqual([{ key: "relativePath", match: { text: "src/core/domains/ingest/pipeline/" } }]);
    });

    it("single dir wildcard with extension", () => {
      const result = globToTextFilter("src/core/adapters/qdrant/*.ts");
      expect(result.must).toEqual([{ key: "relativePath", match: { text: "src/core/adapters/qdrant/.ts" } }]);
    });
  });

  describe("pathPattern FilterDescriptor", () => {
    const pathFilter = staticFilters.find((f) => f.param === "pathPattern")!;

    it("exists in static filters", () => {
      expect(pathFilter).toBeDefined();
    });

    it("builds text match condition from glob pattern", () => {
      const result = pathFilter.toCondition("src/core/**");
      expect(result.must).toEqual([{ key: "relativePath", match: { text: "src/core/" } }]);
    });
  });
});
