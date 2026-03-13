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
    description: "Filter by file extension (e.g. '.ts')",
    type: "string",
    toCondition: (value: unknown) => ({
      must: [{ key: "fileExtension", match: { value: value as string } }],
    }),
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
    param: "isDocumentation",
    description: "Filter documentation chunks",
    type: "boolean",
    toCondition: (value: unknown) => ({
      must: [{ key: "isDocumentation", match: { value: value as boolean } }],
    }),
  },
  {
    param: "excludeDocumentation",
    description: "Exclude documentation chunks from results",
    type: "boolean",
    toCondition: (value: unknown) => {
      if (!value) return {};
      return {
        must_not: [{ key: "isDocumentation", match: { value: true } }],
      };
    },
  },
  {
    param: "fileTypes",
    description: "Filter by file extensions array (e.g. ['.ts', '.py'])",
    type: "string[]",
    toCondition: (value: unknown) => {
      const arr = value as string[];
      if (!arr || arr.length === 0) return {};
      return {
        must: [{ key: "fileExtension", match: { any: arr } }],
      };
    },
  },
  {
    param: "documentationOnly",
    description: "Search only in documentation files (markdown, READMEs)",
    type: "boolean",
    toCondition: (value: unknown) => {
      if (!value) return {};
      return {
        must: [{ key: "isDocumentation", match: { value: true } }],
      };
    },
  },
];
