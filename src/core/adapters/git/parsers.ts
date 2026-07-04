/**
 * Temporary re-export shim — the git CLI parsers relocated to
 * `adapters/vcs/git/git-cli/parsers.ts` (vcs adapter seam, w2dlu). Deleted in T7
 * once every consumer imports the VcsGitAdapter surface instead.
 */

export * from "../vcs/git/git-cli/parsers.js";
