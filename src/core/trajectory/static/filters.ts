import type { FilterDescriptor } from "../../contracts/types/provider.js";

export const staticFilters: FilterDescriptor[] = [
  {
    param: "language",
    description: "Filter by programming language",
    type: "string",
    toCondition: (value: unknown) => [{ key: "language", match: { value: value as string } }],
  },
  {
    param: "fileExtension",
    description: "Filter by file extension (e.g. '.ts')",
    type: "string",
    toCondition: (value: unknown) => [{ key: "fileExtension", match: { value: value as string } }],
  },
  {
    param: "chunkType",
    description: "Filter by chunk type (function, class, interface, block)",
    type: "string",
    toCondition: (value: unknown) => [{ key: "chunkType", match: { value: value as string } }],
  },
  {
    param: "isDocumentation",
    description: "Filter documentation chunks",
    type: "boolean",
    toCondition: (value: unknown) => [{ key: "isDocumentation", match: { value: value as boolean } }],
  },
];
