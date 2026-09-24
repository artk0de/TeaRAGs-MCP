import { globToTextFilter } from "../../../adapters/qdrant/filters/glob.js";
import type { FilterDescriptor } from "../../../contracts/types/provider.js";

export const staticFilters: FilterDescriptor[] = [
  {
    param: "language",
    description: "Filter by programming language",
    type: "string",
    toCondition: (value: unknown) => ({
      must: [{ key: "language", match: { value: value as string } }],
    }),
  },
  {
    param: "fileExtension",
    description: "Filter by file extension(s) — single string or array",
    type: "string",
    toCondition: (value: unknown) => {
      if (Array.isArray(value)) {
        if (value.length === 0) return {};
        return { must: [{ key: "fileExtension", match: { any: value as string[] } }] };
      }
      return { must: [{ key: "fileExtension", match: { value: value as string } }] };
    },
  },
  {
    param: "chunkType",
    description: "Filter by chunk type (function, class, interface, block)",
    type: "string",
    toCondition: (value: unknown) => ({
      must: [{ key: "chunkType", match: { value: value as string } }],
    }),
  },
  {
    param: "documentation",
    description: "Documentation filter: 'only' | 'exclude' | 'include'",
    type: "string",
    toCondition: (value: unknown) => {
      if (value === "only") return { must: [{ key: "isDocumentation", match: { value: true } }] };
      if (value === "exclude") return { must_not: [{ key: "isDocumentation", match: { value: true } }] };
      return {};
    },
  },
  {
    param: "testFile",
    description: "Test file filter: 'only' | 'exclude' | 'include'",
    type: "string",
    toCondition: (value: unknown) => {
      if (value === "only") return { must: [{ key: "isTest", match: { value: true } }] };
      // `codegraph.symbols.file.skippedAs = "test"` is a bridge (bd
      // tea-rags-mcp-9ty5z): indexes built before `isTest` became path-aware
      // lack it on test-root support files, which the codegraph policy already
      // stamped. A `must_not` on an absent key excludes nothing, so a
      // codegraph-disabled index is unaffected. Drop once indexes are rebuilt.
      if (value === "exclude") {
        return {
          must_not: [
            { key: "isTest", match: { value: true } },
            { key: "codegraph.symbols.file.skippedAs", match: { value: "test" } },
          ],
        };
      }
      return {};
    },
  },
  {
    param: "pathPattern",
    description: "Glob pattern for filtering by file path — converts to Qdrant text filter",
    type: "string",
    toCondition: (value: unknown) => globToTextFilter(value as string),
  },
  {
    param: "symbolId",
    description:
      "Filter by symbol ID (partial text match). Format: 'Class.method' for class methods, " +
      "'functionName' for top-level functions. Supports partial match: 'ClassName' finds all " +
      "methods of that class, 'methodName' finds that method in any class.",
    type: "string",
    toCondition: (value: unknown) => ({
      must: [{ key: "symbolId", match: { text: value as string } }],
    }),
  },
];
