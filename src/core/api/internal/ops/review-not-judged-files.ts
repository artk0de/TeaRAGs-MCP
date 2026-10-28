/**
 * One list of the files a review did not judge (bd tea-rags-mcp-56fax).
 *
 * Every section provider answers its own `notJudged` entries, and the naming
 * section its `notJudgedNames` — and the same unjudged files (docs, configs,
 * tests) then repeated once per section: 27% of a measured 51 KB review answer.
 * The review block lists each file ONCE, grouped by the reasons every section
 * gave for it; a section keeps only its count (naming keeps `notJudged` +
 * `notJudgedBy`), so nothing an agent acts on is lost.
 */
import type {
  ReviewNotJudgedFiles,
  ReviewSectionId,
  ReviewSectionNotJudgedEntry,
  ReviewSectionResult,
} from "../../public/dto/review.js";

type ReviewSections = Partial<Record<ReviewSectionId, ReviewSectionResult>>;

interface NotJudgedNamesCarrier {
  notJudgedNames?: readonly { relPath: string; kind: string; reason: string }[];
}

interface FileVerdicts {
  reasons: Partial<Record<ReviewSectionId, string>>;
  details?: Partial<Record<ReviewSectionId, string>>;
}

type NoteNotJudged = (id: ReviewSectionId, relPath: string, reason: string, detail?: string) => void;

export function hoistNotJudgedFiles(sections: ReviewSections): {
  sections: ReviewSections;
  notJudged?: ReviewNotJudgedFiles[];
} {
  const files = new Map<string, FileVerdicts>();
  const note: NoteNotJudged = (id, relPath, reason, detail) => {
    const file = files.get(relPath) ?? { reasons: {} };
    file.reasons[id] = reason;
    if (detail !== undefined) file.details = { ...file.details, [id]: detail };
    files.set(relPath, file);
  };
  const hoisted: ReviewSections = {};
  for (const [id, section] of Object.entries(sections) as [ReviewSectionId, ReviewSectionResult][]) {
    hoisted[id] = withoutFileEntries(id, section, note);
  }
  return files.size === 0 ? { sections } : { sections: hoisted, notJudged: groupByVerdicts(files) };
}

/** Files with the same per-section reasons (and details) share one group, in first-seen order. */
function groupByVerdicts(files: ReadonlyMap<string, FileVerdicts>): ReviewNotJudgedFiles[] {
  const groups = new Map<string, ReviewNotJudgedFiles>();
  for (const [relPath, verdicts] of files) {
    const key = JSON.stringify(verdicts);
    const group = groups.get(key) ?? { ...verdicts, relPaths: [] };
    group.relPaths.push(relPath);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function withoutFileEntries(
  id: ReviewSectionId,
  section: ReviewSectionResult,
  note: NoteNotJudged,
): ReviewSectionResult {
  let reviewSectionResult: ReviewSectionResult = section;
  if (Array.isArray(section.notJudged)) {
    const entries = section.notJudged as readonly ReviewSectionNotJudgedEntry[];
    for (const entry of entries) note(id, entry.relPath, entry.reason, entry.detail);
    reviewSectionResult = { ...reviewSectionResult, notJudged: entries.length };
  }
  const names = (section as NotJudgedNamesCarrier).notJudgedNames;
  if (names !== undefined) {
    for (const entry of names) if (entry.kind === "file") note(id, entry.relPath, entry.reason);
    const { notJudgedNames: _moved, ...rest } = reviewSectionResult as ReviewSectionResult & NotJudgedNamesCarrier;
    const kept = names.filter((entry) => entry.kind !== "file");
    reviewSectionResult = (kept.length > 0 ? { ...rest, notJudgedNames: kept } : rest) as ReviewSectionResult;
  }
  return reviewSectionResult;
}
