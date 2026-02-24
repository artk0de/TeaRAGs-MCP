/**
 * Basic git data types used across the application.
 * Low-level — no enrichment concepts.
 */

/** Raw numstat entry from `git log --numstat` */
export interface RawNumstatEntry {
  added: number;
  deleted: number;
  filePath: string;
}
