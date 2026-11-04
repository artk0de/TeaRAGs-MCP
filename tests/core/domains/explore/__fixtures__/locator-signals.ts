import type { PayloadSignalDescriptor } from "../../../../../src/core/contracts/types/trajectory.js";

export const LOCATOR_SIGNALS: PayloadSignalDescriptor[] = [
  { key: "relativePath", type: "string", treeDependence: "history-only", description: "File path", level: "file" },
  { key: "symbolId", type: "string", treeDependence: "history-only", description: "Symbol address" },
  { key: "startLine", type: "number", treeDependence: "history-only", description: "Start line" },
  { key: "endLine", type: "number", treeDependence: "history-only", description: "End line" },
];
