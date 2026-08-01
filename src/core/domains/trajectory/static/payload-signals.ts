import type { PayloadSignalDescriptor } from "../../../contracts/types/trajectory.js";

export const BASE_PAYLOAD_SIGNALS: PayloadSignalDescriptor[] = [
  { key: "relativePath", type: "string", description: "File path relative to project root" },
  { key: "fileExtension", type: "string", description: "File extension (e.g. '.ts')" },
  { key: "language", type: "string", description: "Programming language" },
  { key: "startLine", type: "number", description: "Start line of chunk in file" },
  { key: "endLine", type: "number", description: "End line of chunk in file" },
  { key: "chunkIndex", type: "number", description: "Chunk position within file" },
  { key: "isDocumentation", type: "boolean", description: "Whether chunk is documentation" },
  {
    key: "isTest",
    type: "boolean",
    description: "Whether the file is a test/spec file (detected by naming convention per language)",
  },
  { key: "chunkType", type: "string", description: "Chunk type (function, class, block, etc.)" },
  { key: "name", type: "string", description: "Symbol name (class, function, etc.)" },
  { key: "parentSymbolId", type: "string", description: "Parent symbol name" },
  { key: "parentType", type: "string", description: "Parent symbol type" },
  { key: "imports", type: "string[]", description: "File-level imports inherited by all chunks" },
  { key: "symbolId", type: "string", description: "Unique symbol identifier (e.g. 'MyClass.processData')" },
  {
    key: "methodLines",
    type: "number",
    description: "Original method/block line count before splitting",
    stats: { labels: { p50: "small", p75: "large", p95: "decomposition_candidate" }, chunkTypeFilter: "function" },
  },
  {
    key: "methodDensity",
    type: "number",
    description: "Code density: characters per line (contentSize / methodLines)",
    stats: { labels: { p50: "sparse", p95: "dense" }, chunkTypeFilter: "function" },
  },
  { key: "contentSize", type: "number", description: "Character count of chunk content" },
  {
    key: "memberCount",
    type: "number",
    description: "Distinct direct members (methods, nested classes) declared by this class",
    stats: { labels: { p50: "typical", p75: "large", p95: "god-class" }, chunkTypeFilter: "class" },
  },
  {
    key: "classLines",
    type: "number",
    description: "Real class span in lines — last member's end line minus the class start line",
    stats: { labels: { p50: "small", p75: "large", p95: "megaclass" }, chunkTypeFilter: "class" },
  },
  {
    key: "fileSymbolCount",
    type: "number",
    description: "Distinct code symbols declared in this file (stamped on every code chunk of the file)",
    // File-scoped value repeated on every chunk of the file: percentiles must
    // be taken over distinct files, or a many-chunk file outvotes every other
    // file in its own distribution.
    stats: { labels: { p50: "typical", p75: "busy", p95: "god-module" }, dedupeByFile: true },
  },
];
