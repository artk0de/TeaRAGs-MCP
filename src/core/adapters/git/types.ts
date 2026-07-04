/**
 * Temporary re-export shim — the neutral git data types relocated to
 * `adapters/vcs/types.ts` (vcs adapter seam, w2dlu). Deleted in T7 once every
 * consumer imports from the vcs contracts instead.
 */

export type { BlameLine, CommitInfo, FileChurnData, RawNumstatEntry } from "../vcs/types.js";
