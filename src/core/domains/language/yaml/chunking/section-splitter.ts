/**
 * Cuts a YAML file along its key paths (bd tea-rags-mcp-q1g6s.7). Config YAML
 * (Rails `config/*.yml`, CI workflows) is read like a document: the unit a
 * reader asks for is "the `production` block", so a section is a key and its
 * `headingPath` the key path the doc-id pass hashes.
 *
 * Order of cuts, each applied only while the previous one leaves a section
 * over `maxChunkSize`:
 *   1. the whole file;
 *   2. one section per top-level key — the comment lines directly above a key
 *      belong to it, anything above the first key belongs to the first;
 *      consecutive small pairs merge while the merge fits;
 *   3. a top-level pair whose value is a map → one section per second-level
 *      key, the first child also carrying the `top:` line;
 *   4. line windows sharing the section's `headingPath` (one doc id).
 * A file that does not parse as exactly one mapping document → line windows
 * with no key path.
 */

import { isMap, isScalar, LineCounter, parseAllDocuments, type Pair, type YAMLMap } from "yaml";

import type { DocumentSection, DocumentSectionSplitter } from "../../../../contracts/types/chunker.js";

/** A section under this many characters merges with a small neighbour. */
const SMALL_SECTION_SIZE = 300;

type HeadingPath = DocumentSection["headingPath"];

interface KeySpan {
  key: string;
  startLine: number;
  endLine: number;
  value: unknown;
}

export class YamlSectionSplitter implements DocumentSectionSplitter {
  split(code: string, options: { maxChunkSize: number }): DocumentSection[] {
    const lines = code.split("\n");
    const lastLine = lastContentLine(lines, 1, lines.length);
    if (lastLine === 0) return [];
    const whole = section(lines, 1, lastLine, []);
    if (whole.content.length <= options.maxChunkSize) return [whole];

    const lineCounter = new LineCounter();
    const root = parseMappingRoot(code, lineCounter);
    if (!root) return windows(lines, 1, lastLine, [], undefined, options.maxChunkSize);

    const level: KeyLevel = {
      lines,
      maxChunkSize: options.maxChunkSize,
      lineOf: (offset) => lineCounter.linePos(offset).line,
    };
    return cutLevel(level, keySpans(root.items, level, 1, lastLine), []);
  }
}

/** What every level of the cut shares. */
interface KeyLevel {
  lines: string[];
  maxChunkSize: number;
  lineOf: (offset: number) => number;
}

/** Deepest key level cut into sections; below it an oversized section is windowed. */
const MAX_KEY_DEPTH = 2;

/**
 * One section per span under `parentPath`, small neighbours merged; a section
 * still over the limit is cut one key level deeper when its value is a map and
 * the depth allows, else into line windows.
 */
function cutLevel(level: KeyLevel, spans: KeySpan[], parentPath: HeadingPath): DocumentSection[] {
  const depth = parentPath.length + 1;
  const spanAt = new Map(spans.map((span) => [span.startLine, span]));
  const sections = spans.map((span) =>
    section(level.lines, span.startLine, span.endLine, [...parentPath, { depth, text: span.key }], span.key),
  );
  return mergeSmall(sections, level).flatMap((own) => {
    if (own.content.length <= level.maxChunkSize) return [own];
    const span = spanAt.get(own.startLine);
    const children =
      span && depth < MAX_KEY_DEPTH && isMap(span.value)
        ? keySpans(span.value.items, level, span.startLine, span.endLine)
        : [];
    return children.length > 0
      ? cutLevel(level, children, own.headingPath)
      : windows(level.lines, own.startLine, own.endLine, own.headingPath, own.name, level.maxChunkSize);
  });
}

/** The root mapping of a single-document, error-free file; else undefined. */
function parseMappingRoot(code: string, lineCounter: LineCounter): YAMLMap | undefined {
  try {
    const docs = parseAllDocuments(code, { lineCounter });
    if (!Array.isArray(docs) || docs.length !== 1) return undefined;
    const [doc] = docs;
    if (doc.errors.length > 0 || !isMap(doc.contents)) return undefined;
    return doc.contents;
  } catch {
    return undefined;
  }
}

/**
 * Line spans of `pairs` inside `[fromLine, toLine]`: each pair starts at its
 * key, pulled up over the comment lines directly above it (the first pair
 * starts at `fromLine`), and ends right before the next pair's start.
 */
function keySpans(pairs: readonly Pair[], level: KeyLevel, fromLine: number, toLine: number): KeySpan[] {
  const { lines, lineOf } = level;
  const keyed = pairs.flatMap((pair) => {
    const offset = isScalar(pair.key) ? pair.key.range?.[0] : undefined;
    if (offset === undefined || !isScalar(pair.key)) return [];
    return [{ key: String(pair.key.value), keyLine: lineOf(offset), value: pair.value }];
  });
  const starts = keyed.map(({ keyLine }, i) => (i === 0 ? fromLine : withCommentsAbove(lines, keyLine)));
  return keyed.map(({ key, value }, i) => ({
    key,
    value,
    startLine: starts[i],
    endLine: lastContentLine(lines, starts[i], i + 1 < starts.length ? starts[i + 1] - 1 : toLine),
  }));
}

function withCommentsAbove(lines: string[], keyLine: number): number {
  let start = keyLine;
  while (start > 1 && lines[start - 2].trim().startsWith("#")) start--;
  return start;
}

/** Last non-blank 1-based line in `[from, to]`, or `from - 1` when all are blank. */
function lastContentLine(lines: string[], from: number, to: number): number {
  let end = to;
  while (end >= from && lines[end - 1].trim() === "") end--;
  return end;
}

function section(
  lines: string[],
  startLine: number,
  endLine: number,
  headingPath: HeadingPath,
  name?: string,
): DocumentSection {
  return {
    content: lines.slice(startLine - 1, endLine).join("\n"),
    startLine,
    endLine,
    headingPath,
    ...(name !== undefined ? { name } : {}),
  };
}

/** Consecutive line windows of `[fromLine, toLine]`, each within `maxChunkSize`. */
function windows(
  lines: string[],
  fromLine: number,
  toLine: number,
  headingPath: HeadingPath,
  name: string | undefined,
  maxChunkSize: number,
): DocumentSection[] {
  const out: DocumentSection[] = [];
  let start = fromLine;
  let size = 0;
  for (let line = fromLine; line <= toLine; line++) {
    const added = lines[line - 1].length + (line > start ? 1 : 0);
    if (line > start && size + added > maxChunkSize) {
      const end = lastContentLine(lines, start, line - 1);
      if (end >= start) out.push(section(lines, start, end, headingPath, name));
      start = line;
      size = lines[line - 1].length;
      continue;
    }
    size += added;
  }
  const end = lastContentLine(lines, start, toLine);
  if (end >= start) out.push(section(lines, start, end, headingPath, name));
  return out;
}

/**
 * Merges each run of adjacent small sections (under {@link SMALL_SECTION_SIZE})
 * into one, while the merged span still fits. The merged section keeps the
 * first key's name; its `headingPath` lists every merged key, so its doc id
 * differs from each part's.
 */
function mergeSmall(sections: DocumentSection[], level: KeyLevel): DocumentSection[] {
  const out: DocumentSection[] = [];
  let runOpen = false;
  for (const next of sections) {
    const prev = out.at(-1);
    const key = next.headingPath.at(-1);
    if (prev && runOpen && key && isSmall(next)) {
      const merged = section(level.lines, prev.startLine, next.endLine, [...prev.headingPath, key], prev.name);
      if (merged.content.length <= level.maxChunkSize) {
        out[out.length - 1] = merged;
        continue;
      }
    }
    out.push(next);
    runOpen = isSmall(next);
  }
  return out;
}

function isSmall(s: DocumentSection): boolean {
  return s.content.length < SMALL_SECTION_SIZE;
}
