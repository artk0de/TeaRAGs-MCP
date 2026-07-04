/**
 * Parses `Diff.print({ format: "Patch" })` output (generated with
 * `contextLines: 0`) into ordered per-file numstat sections.
 *
 * es-git 0.7 `print` emits hunk CONTENT lines without their origin prefix
 * (`+` / `-` / ` `), so added/deleted counts cannot be recovered from line
 * prefixes the way `git diff` output is normally parsed. With zero context
 * lines the counts come directly from the `@@ -a,b +c,d @@` hunk headers
 * instead: `b` is the deleted-line count, `d` the added-line count (an
 * omitted count means 1). Hunk bodies are then skipped by exact line budget
 * (b + d), so file content that *looks* like a diff header can never derail
 * section splitting or the counters.
 */

/** `@@ -a[,b] +c[,d] @@[ heading]` — captures the optional old/new counts. */
const HUNK_HEADER_RE = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/** Per-file slice of one printed patch, in diff (delta) order. */
export interface PatchNumstatSection {
  added: number;
  deleted: number;
  /** CLI numstat emits `-\t-` for binary files; the CLI parsers skip them. */
  binary: boolean;
}

export function parsePatchNumstatSections(patchText: string): PatchNumstatSection[] {
  const sections: PatchNumstatSection[] = [];
  let current: PatchNumstatSection | null = null;
  let budget = 0; // content lines still owed to the current hunk

  for (const line of patchText.split("\n")) {
    if (budget > 0) {
      // "\ No newline at end of file" markers ride on top of the b+d budget:
      // marker lines are not content, so they do not consume it.
      if (!line.startsWith("\\ ")) budget--;
      continue;
    }
    if (line.startsWith("diff --git ")) {
      current = { added: 0, deleted: 0, binary: false };
      sections.push(current);
      continue;
    }
    if (current === null) continue;
    const hunk = HUNK_HEADER_RE.exec(line);
    if (hunk !== null) {
      const deleted = hunk[1] === undefined ? 1 : parseInt(hunk[1], 10);
      const added = hunk[2] === undefined ? 1 : parseInt(hunk[2], 10);
      current.deleted += deleted;
      current.added += added;
      budget = deleted + added;
      continue;
    }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      current.binary = true;
    }
  }

  return sections;
}
