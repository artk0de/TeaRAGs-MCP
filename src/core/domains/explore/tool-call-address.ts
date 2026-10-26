import type { ToolCallAddress } from "../../contracts/types/suggested-tool-call.js";
import type { WorkingTreeMarker } from "../../contracts/types/working-tree.js";

/**
 * The `{ project, path }` every emitted call carries: the alias of the index
 * that answered and the tree it answered for. The single builder of that pair —
 * no tool assembles it by hand, so a hint can never fall back to the registered
 * checkout while the caller addressed another tree.
 */
export function toolCallAddressFromWorkingTree(
  marker: Pick<WorkingTreeMarker, "tree" | "project"> | undefined,
): ToolCallAddress {
  if (!marker) return {};
  return marker.project ? { project: marker.project, path: marker.tree } : { path: marker.tree };
}
