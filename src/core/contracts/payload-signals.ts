import type { PayloadSignalDescriptor } from "./types/trajectory.js";

/** Static payload signals present on every indexed point, regardless of trajectory. */
export const BASE_PAYLOAD_SIGNALS: PayloadSignalDescriptor[] = [
  { key: "relativePath", type: "string", description: "File path relative to project root" },
  { key: "fileExtension", type: "string", description: "File extension (e.g. '.ts')" },
  { key: "language", type: "string", description: "Programming language" },
  { key: "startLine", type: "number", description: "Start line of chunk in file" },
  { key: "endLine", type: "number", description: "End line of chunk in file" },
  { key: "chunkIndex", type: "number", description: "Chunk position within file" },
  { key: "isDocumentation", type: "boolean", description: "Whether chunk is documentation" },
  { key: "chunkType", type: "string", description: "Chunk type (function, class, block, etc.)" },
  { key: "name", type: "string", description: "Symbol name (class, function, etc.)" },
  { key: "parentName", type: "string", description: "Parent symbol name" },
  { key: "parentType", type: "string", description: "Parent symbol type" },
  { key: "imports", type: "string[]", description: "File-level imports inherited by all chunks" },
];
