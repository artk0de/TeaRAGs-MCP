/**
 * Pure formatting helpers for the `tea-rags projects` text table.
 *
 * No I/O: every value is derived from the registry entries already returned by
 * `registry.list()`. Coloring is applied through an injected {@link Colorizer}
 * so the layout is identical with or without ANSI — tests assert on plain text.
 */

import type { CollectionEntry } from "../../core/api/public/index.js";
import type { Colorizer } from "../infra/color.js";
import { compareSemver, isValidSemver } from "../update-check/semver.js";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const NAME_SEPARATORS = /(?<=[-_.])/;

const NAME_WIDTH = 14;
const CHUNKS_WIDTH = 8;
const INDEXED_WIDTH = 9;
const VER_WIDTH = 9;
const QDRANT_WIDTH = 9;
const MAX_PATH_WIDTH = 48;
const STALE_AGE_DAYS = 14;
const FRESH_AGE_DAYS = 2;
const GAP = "  ";

export type QdrantKind = "local" | "embedded" | "remote";

export interface QdrantClassification {
  kind: QdrantKind;
  host: string | null;
}

/** Compact count: `9`, `999`, `1.0k`, `11.5k`, `117.0k`. */
export function humanCount(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

/** Relative age of an ISO timestamp vs `now`: `5m ago`, `11h ago`, `15d ago`, `(never)`. */
export function relativeAge(indexedAt: string | null | undefined, now: Date): string {
  if (!indexedAt) return "(never)";
  const then = new Date(indexedAt).getTime();
  if (Number.isNaN(then)) return "(never)";
  const minutes = Math.floor((now.getTime() - then) / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 0)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Classify a stored Qdrant URL by shape (no probing):
 * loopback host + port 6333 → local; loopback + any other port → embedded;
 * non-loopback host → remote. Unparseable → remote.
 */
export function classifyQdrant(url: string | null | undefined): QdrantClassification {
  if (!url) return { kind: "remote", host: null };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: "remote", host: null };
  }
  const host = parsed.hostname;
  if (LOOPBACK.has(host)) {
    return { kind: parsed.port === "6333" ? "local" : "embedded", host: null };
  }
  return { kind: "remote", host: host.replace(/^\[|\]$/g, "") };
}

function center(s: string, width: number): string {
  if (s.length >= width) return s;
  const pad = width - s.length;
  const left = Math.floor(pad / 2);
  return " ".repeat(left) + s + " ".repeat(pad - left);
}

function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function padLeft(s: string, width: number): string {
  return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

/**
 * Wrap a project name into centered lines of `width`, breaking only at
 * separator chars (`-`, `_`, `.`) which stay attached to the preceding segment.
 * A separator-less segment wider than `width` is left intact (not split).
 */
export function wrapName(name: string, width: number): string[] {
  if (name.length <= width) return [center(name, width)];
  const segments = name.split(NAME_SEPARATORS);
  const lines: string[] = [];
  let current = "";
  for (const seg of segments) {
    if (current && current.length + seg.length > width) {
      lines.push(current);
      current = seg;
    } else {
      current += seg;
    }
  }
  if (current) lines.push(current);
  return lines.map((l) => center(l, width));
}

function collapseHome(path: string, home: string): string {
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function truncatePath(path: string): string {
  if (path.length <= MAX_PATH_WIDTH) return path;
  const keep = MAX_PATH_WIDTH - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${path.slice(0, head)}…${path.slice(path.length - tail)}`;
}

function maxVersion(entries: CollectionEntry[]): string | null {
  let max: string | null = null;
  for (const e of entries) {
    const v = e.teaRagsVersion;
    if (!v || !isValidSemver(v)) continue;
    if (max === null || compareSemver(v, max) > 0) max = v;
  }
  return max;
}

function countByPath(entries: CollectionEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.path, (counts.get(e.path) ?? 0) + 1);
  return counts;
}

export interface FormatProjectsOptions {
  now: Date;
  colorizer: Colorizer;
  home: string;
}

/** Render the registry entries as an aligned, colored text table. */
export function formatProjectsTable(entries: CollectionEntry[], opts: FormatProjectsOptions): string {
  const { now, colorizer: c, home } = opts;
  const maxVer = maxVersion(entries);
  const pathCounts = countByPath(entries);

  const header = c.bold(
    c.brand(
      [
        center("NAME", NAME_WIDTH),
        padLeft("CHUNKS", CHUNKS_WIDTH),
        padRight("INDEXED", INDEXED_WIDTH),
        padRight("VER", VER_WIDTH),
        padRight("QDRANT", QDRANT_WIDTH),
        "PATH",
      ].join(GAP),
    ),
  );

  const lines: string[] = [header];
  let anyStale = false;
  let anyDup = false;

  for (const e of entries) {
    const rawName = e.name ?? "";
    const named = rawName !== "";
    const display = named ? rawName : "(no name)";
    const nameLines = wrapName(display, NAME_WIDTH).map((l) => (named ? c.bold(c.brand(l)) : c.bold(c.warn(l))));

    const chunksCell = padLeft(humanCount(e.chunksCount), CHUNKS_WIDTH);

    const ageText = relativeAge(e.indexedAt, now);
    const ageDays = e.indexedAt ? (now.getTime() - new Date(e.indexedAt).getTime()) / 86_400_000 : Number.NaN;
    let indexedCell = padRight(ageText, INDEXED_WIDTH);
    if (ageText === "(never)") indexedCell = c.dim(indexedCell);
    else if (ageDays <= FRESH_AGE_DAYS) indexedCell = c.ok(indexedCell);
    else if (ageDays > STALE_AGE_DAYS) indexedCell = c.warn(indexedCell);

    const ver = e.teaRagsVersion ?? "(unknown)";
    const verStale = maxVer !== null && isValidSemver(ver) && compareSemver(ver, maxVer) < 0;
    if (verStale) anyStale = true;
    const verText = verStale ? `${ver} ⚠` : ver;
    const verCell = verStale ? c.warn(padRight(verText, VER_WIDTH)) : padRight(verText, VER_WIDTH);

    const { kind } = classifyQdrant(e.qdrantUrl);
    const qdrantCell = kind === "remote" ? c.brand(padRight(kind, QDRANT_WIDTH)) : c.dim(padRight(kind, QDRANT_WIDTH));

    const isDup = (pathCounts.get(e.path) ?? 0) > 1;
    if (isDup) anyDup = true;
    const pathText = truncatePath(collapseHome(e.path, home)) + (isDup ? " ⧉" : "");
    const pathCell = isDup ? c.alert(pathText) : c.dim(pathText);

    lines.push([nameLines[0], chunksCell, indexedCell, verCell, qdrantCell, pathCell].join(GAP));
    for (let i = 1; i < nameLines.length; i++) lines.push(nameLines[i]);
  }

  const legend: string[] = [];
  if (anyStale) legend.push("⚠ stale version");
  if (anyDup) legend.push("⧉ duplicate path");
  if (legend.length > 0) {
    lines.push("");
    lines.push(c.dim(legend.join("   ")));
  }

  return `${lines.join("\n")}\n`;
}
