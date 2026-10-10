import type { PayloadSignalDescriptor } from "../../../contracts/types/trajectory.js";

/**
 * Flat payload keys every chunk carries. `level: "file"` marks the ones that
 * describe the whole file (the same value on every chunk of it); the rest
 * describe the chunk and are stripped from `level: "file"` search results.
 */
export const BASE_PAYLOAD_SIGNALS: PayloadSignalDescriptor[] = [
  {
    key: "relativePath",
    treeDependence: "tree-content",
    type: "string",
    description: "File path relative to project root",
    level: "file",
  },
  {
    key: "fileExtension",
    treeDependence: "tree-content",
    type: "string",
    description: "File extension (e.g. '.ts')",
    level: "file",
  },
  {
    key: "language",
    treeDependence: "tree-content",
    type: "string",
    description: "Programming language",
    level: "file",
  },
  { key: "startLine", treeDependence: "tree-content", type: "number", description: "Start line of chunk in file" },
  { key: "endLine", treeDependence: "tree-content", type: "number", description: "End line of chunk in file" },
  { key: "chunkIndex", treeDependence: "tree-content", type: "number", description: "Chunk position within file" },
  {
    key: "isDocumentation",
    treeDependence: "tree-content",
    type: "boolean",
    description: "Whether chunk is documentation",
    level: "file",
  },
  {
    key: "isTest",
    treeDependence: "tree-content",
    type: "boolean",
    description: "Whether the file is a test/spec file (detected by naming convention per language)",
    level: "file",
  },
  {
    key: "chunkType",
    treeDependence: "tree-content",
    type: "string",
    description: "Chunk type (function, class, block, etc.)",
  },
  { key: "name", treeDependence: "tree-content", type: "string", description: "Symbol name (class, function, etc.)" },
  { key: "parentSymbolId", treeDependence: "tree-content", type: "string", description: "Parent symbol name" },
  { key: "parentType", treeDependence: "tree-content", type: "string", description: "Parent symbol type" },
  {
    key: "imports",
    treeDependence: "tree-content",
    type: "string[]",
    description: "File-level imports inherited by all chunks",
    level: "file",
  },
  {
    key: "symbolId",
    treeDependence: "tree-content",
    type: "string",
    description: "Unique symbol identifier (e.g. 'MyClass.processData')",
  },
  {
    key: "methodLines",
    treeDependence: "tree-content",
    type: "number",
    description: "Original method/block line count before splitting",
    stats: { labels: { p50: "small", p75: "large", p95: "decomposition_candidate" }, chunkTypeFilter: "function" },
  },
  {
    key: "methodDensity",
    treeDependence: "tree-content",
    type: "number",
    description: "Code density: characters per line (contentSize / methodLines)",
    stats: { labels: { p50: "sparse", p95: "dense" }, chunkTypeFilter: "function" },
  },
  {
    key: "contentSize",
    treeDependence: "tree-content",
    type: "number",
    description: "Character count of chunk content",
  },
  {
    key: "memberCount",
    treeDependence: "tree-content",
    type: "number",
    // No chunkTypeFilter: the value exists only on the chunk the symbol-mass
    // pass elected to represent each container, so one class contributes one
    // value and the sample needs no further narrowing. Filtering on
    // `chunkType: "class"` used to be that narrowing and instead selected only
    // member-LESS classes — see the module docblock of `symbol-mass.ts`.
    description: "Distinct direct members (methods, nested classes) declared by this class",
    stats: { labels: { p50: "typical", p75: "large", p95: "god-module" } },
  },
  {
    key: "moduleLines",
    treeDependence: "tree-content",
    type: "number",
    description: "Physical line count of the file (stamped on every code chunk of the file)",
    level: "file",
    stats: { labels: { p50: "small", p75: "large", p95: "god-module" }, dedupeByFile: true },
  },
  {
    key: "moduleMethodCount",
    treeDependence: "tree-content",
    type: "number",
    description: "Distinct callables — functions, methods, tests — declared in this file",
    level: "file",
    // File-scoped value repeated on every chunk of the file: percentiles must
    // be taken over distinct files, or a many-chunk file outvotes every other
    // file in its own distribution.
    stats: { labels: { p50: "typical", p75: "busy", p95: "god-module" }, dedupeByFile: true },
  },
];
