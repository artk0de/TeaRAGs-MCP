/**
 * Fingerprint of the `.mailmap` git applies to a working tree (bd
 * tea-rags-mcp-nsxzh). The git readers report authors AFTER the mailmap
 * (`author-identity.ts`), so every persisted cache holding author names or
 * emails — the commit and file-churn discovery snapshots, the OID-keyed blame
 * cache — is only valid for the mailmap it was written under. Each stamps
 * this value on save and treats a different one on load as a miss.
 *
 * "" when the tree has no `.mailmap`: a repo without one reads the same
 * identities raw or mapped, so a snapshot written before the stamp existed
 * (no field) stays valid there and only a repo that HAS a mailmap rebuilds.
 *
 * Scope: the top-level `.mailmap` of the working tree — the file git reads by
 * default. `mailmap.file` / `mailmap.blob` config is not fingerprinted.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function readMailmapFingerprint(repoRoot: string): string {
  let content: Buffer;
  try {
    content = readFileSync(join(repoRoot, ".mailmap"));
  } catch {
    return "";
  }
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/** A persisted snapshot's stamp matches the tree's current mailmap (absent stamp = no mailmap). */
export function mailmapStampMatches(stamp: unknown, fingerprint: string): boolean {
  return (stamp === undefined ? "" : stamp) === fingerprint;
}
