/**
 * Temporary re-export shim — the git CLI errors relocated to
 * `adapters/vcs/git/git-cli/errors.ts` (vcs adapter seam, w2dlu). Deleted in T7
 * once every consumer imports from the vcs adapter instead.
 */

export * from "../vcs/git/git-cli/errors.js";
