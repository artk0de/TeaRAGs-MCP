/**
 * One level of an indexed directory (agent turn economy N2): find_symbol's
 * answer when `relativePath` names no indexed file but prefixes indexed files.
 * The files themselves are the answer's `results` rows (`relativePath`,
 * `language`, top-level `symbols`); this frame says what they are a listing of
 * and what lies one level deeper.
 */
export interface DirectoryOutline {
  kind: "directory";
  /** The directory listed, repo-relative, without a trailing `/`. */
  dir: string;
  /** Subdirectories one level down, each with the indexed files it holds at any depth. */
  subdirs: DirectoryOutlineSubdir[];
  /** Indexed files directly in `dir`. */
  total: number;
  /** True when `results` holds fewer files than `total`. */
  truncated: boolean;
}

export interface DirectoryOutlineSubdir {
  dir: string;
  fileCount: number;
}
