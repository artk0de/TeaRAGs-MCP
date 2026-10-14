/**
 * Cross-process "endpoint down" verdicts for embedding endpoints (bd
 * tea-rags-mcp-w1bz7).
 *
 * An `EmbeddingEndpointPool` learns that an endpoint is dead only inside one
 * process. Every fresh process — each `tea-rags call`, each hook-spawned CLI —
 * would otherwise pay the discovery again: a `/props` timeout plus a connect
 * timeout on the first post, 3-29 s measured against an unreachable LAN GPU
 * host. One process that saw a CONNECT-class failure leaves a short-lived
 * verdict here, keyed by endpoint URL, and the next process starts with that
 * endpoint already failed over.
 *
 * The verdict is an optimisation, never a source of truth: a missing,
 * unreadable or corrupt file is "no verdict", writes never throw, and a verdict
 * expires after `EMBEDDING_ENDPOINT_DOWN_VERDICT_TTL_MS`. Concurrent writers may
 * lose each other's entries (last rename wins); that costs one more discovery,
 * never a wrong answer.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * How long a fresh process trusts another process's "down" verdict. Long
 * enough to cover a burst of back-to-back CLI calls (an agent fires several a
 * minute) and at least one 30 s failback-probe period of a long-lived server,
 * so a recovered primary has had a chance to withdraw the verdict; short
 * enough that a primary which came back without any process noticing is
 * skipped by fresh processes for at most a minute.
 */
export const EMBEDDING_ENDPOINT_DOWN_VERDICT_TTL_MS = 60_000;

const VERDICT_FILE_VERSION = 1;

export interface EmbeddingEndpointDownVerdict {
  url: string;
  /** Epoch ms the connect-class failure was observed. */
  downAt: number;
  /** Operator-facing cause (`describeConnectFailure`). */
  reason: string;
}

interface VerdictFileEntry {
  downAt: number;
  reason: string;
}

export interface EmbeddingEndpointDownVerdictStoreOptions {
  now?: () => number;
  ttlMs?: number;
}

export class EmbeddingEndpointDownVerdictStore {
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(
    private readonly filePath: string,
    options: EmbeddingEndpointDownVerdictStoreOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? EMBEDDING_ENDPOINT_DOWN_VERDICT_TTL_MS;
  }

  /** Verdicts younger than the TTL. A verdict stamped in the future (clock skew) is not trusted. */
  liveVerdicts(): EmbeddingEndpointDownVerdict[] {
    const now = this.now();
    return [...this.readEntries()]
      .filter(([, entry]) => entry.downAt <= now && now - entry.downAt < this.ttlMs)
      .map(([url, entry]) => ({ url, downAt: entry.downAt, reason: entry.reason }));
  }

  markDown(url: string, reason: string): void {
    const entries = this.liveEntries();
    entries.set(url, { downAt: this.now(), reason });
    this.writeEntries(entries);
  }

  /** Withdraw `url`'s verdict; no write when it has none. */
  clear(url: string): void {
    const entries = this.readEntries();
    if (!entries.delete(url)) return;
    this.writeEntries(this.dropExpired(entries));
  }

  private liveEntries(): Map<string, VerdictFileEntry> {
    return this.dropExpired(this.readEntries());
  }

  private dropExpired(entries: Map<string, VerdictFileEntry>): Map<string, VerdictFileEntry> {
    const now = this.now();
    return new Map([...entries].filter(([, entry]) => now - entry.downAt < this.ttlMs));
  }

  private readEntries(): Map<string, VerdictFileEntry> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf-8"));
    } catch {
      return new Map();
    }
    const endpoints = (parsed as { endpoints?: unknown } | null)?.endpoints;
    if (typeof endpoints !== "object" || endpoints === null) return new Map();
    return new Map(
      Object.entries(endpoints as Record<string, unknown>).filter((pair): pair is [string, VerdictFileEntry] =>
        isVerdictFileEntry(pair[1]),
      ),
    );
  }

  /** tmp + rename, so a reader sees the old file or the new one, never a torn write. */
  private writeEntries(entries: Map<string, VerdictFileEntry>): void {
    const tmp = `${this.filePath}.tmp-${process.pid}-${this.now()}`;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(
        tmp,
        JSON.stringify({ version: VERDICT_FILE_VERSION, endpoints: Object.fromEntries(entries) }),
        "utf-8",
      );
      renameSync(tmp, this.filePath);
    } catch {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // Nothing was written where nothing can be written.
      }
    }
  }
}

function isVerdictFileEntry(value: unknown): value is VerdictFileEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.downAt === "number" && Number.isFinite(entry.downAt) && typeof entry.reason === "string";
}
