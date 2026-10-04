/**
 * Which Qdrant backend a registry entry addresses.
 *
 * An entry records its backend twice — as `qdrantUrl` and as the
 * `qdrantEmbedded` flag — and whether those two records agree depends on which
 * release wrote them:
 *
 * | writer          | qdrantUrl        | qdrantEmbedded | agree? |
 * | --------------- | ---------------- | -------------- | ------ |
 * | <= 1.31.1       | frozen port      | absent         | n/a    |
 * | 1.33.0          | frozen port      | independent    | NO     |
 * | >= 1.34.0       | `embedded`       | derived        | always |
 *
 * From 1.34.0 the pipeline derives both from ONE `isEmbedded` read
 * (`ingest/pipeline/base.ts`), so the pair is self-consistent by construction
 * and the flag is authoritative. The 1.33.0 line wrote them from separate
 * reads, and the local registry has the receipts: on the same day, against the
 * same daemon on `127.0.0.1:51269`, it stored `false` for `octokit` and
 * `huginn-sd-val` and `true` for `bench-graphql-ruby`. Trusting a flag from
 * that window is how a run ends up pinned to a port the daemon abandoned.
 *
 * So the writer's version — already stored per entry — is the discriminator:
 * believe the flag from 1.34.0 on, fall back to reading the URL's shape below
 * it. That keeps the shape heuristic confined to a closed historical window
 * instead of letting it second-guess entries the current write path produced.
 */

import { EMBEDDED_MARKER } from "../../../adapters/qdrant/embedded/daemon.js";
import type { CollectionEntry, RegistryQdrantBackend } from "../../../contracts/types/registry.js";
import { RegistryQdrantBackendUnresolvedError } from "./errors.js";

// `RegistryQdrantBackend` is defined in contracts (bd tea-rags-mcp-0qaht.36);
// re-exported here unchanged for this domain's consumers.
export type { RegistryQdrantBackend };
/**
 * First release whose write path derives `qdrantUrl` and `qdrantEmbedded` from
 * a single `isEmbedded` read, making the pair self-consistent. Shipped as
 * `7db5e88d`, first tagged `v1.34.0`.
 */
const EMBEDDED_FLAG_TRUSTED_SINCE: readonly [number, number, number] = [1, 34, 0];

/**
 * Lowest port any mainstream OS hands out from its ephemeral range: Linux
 * defaults to 32768-60999, macOS and Windows to 49152-65535. The embedded
 * daemon always asks the OS for a free port, so it can only ever land at or
 * above this floor.
 *
 * The floor is what separates the daemon from an external Qdrant published on
 * loopback: `docker run -p 7000:6333` picks a memorable low port, never one out
 * of the OS pool. Reading the shape without it would swallow that user whole.
 */
const EPHEMERAL_PORT_FLOOR = 32768;

/** Numeric `major.minor.patch` core of a version string, or null if unreadable. */
function parseVersionCore(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Whether the release that wrote this entry stored `qdrantEmbedded` and
 * `qdrantUrl` as an agreeing pair.
 *
 * An absent or unreadable version means a writer old enough to predate the
 * field entirely (1.31.1-era entries carry no version at all), so it reads as
 * untrusted and the URL's shape decides instead.
 */
function writerStoresAgreeingBackendPair(teaRagsVersion: string | undefined): boolean {
  if (teaRagsVersion === undefined) return false;
  const core = parseVersionCore(teaRagsVersion);
  if (core === null) return false;
  for (let i = 0; i < 3; i++) {
    if (core[i] !== EMBEDDED_FLAG_TRUSTED_SINCE[i]) return core[i] > EMBEDDED_FLAG_TRUSTED_SINCE[i];
  }
  return true;
}

/**
 * Whether this URL has the embedded daemon's exact shape: loopback `127.0.0.1`
 * on a port out of the OS ephemeral pool. Nothing else binds that combination —
 * an external Qdrant sits on its 6333 default or on a port a human chose.
 */
function isEmbeddedDaemonAddress(qdrantUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(qdrantUrl);
  } catch {
    return false;
  }
  if (parsed.hostname !== "127.0.0.1" || parsed.port === "") return false;
  return Number(parsed.port) >= EPHEMERAL_PORT_FLOOR;
}

/** External backend when an address is on record, `unaddressed` when it is not. */
function addressedBackend(qdrantUrl: string): RegistryQdrantBackend {
  return qdrantUrl ? { kind: "external", url: qdrantUrl } : { kind: "unaddressed" };
}

/** The two entry fields that record a backend, as a writer must persist them. */
export interface RegistryQdrantBackendFields {
  qdrantUrl: string;
  qdrantEmbedded: boolean;
}

/**
 * Encode a live Qdrant connection into the entry fields the current write path
 * persists — the inverse of `resolveRegistryQdrantBackend`.
 *
 * The embedded daemon is stored as the sentinel, never as its
 * `http://127.0.0.1:<port>` URL: the daemon rebinds a fresh ephemeral port on
 * every restart, so a frozen URL points at a dead socket after the first one
 * (bd tea-rags-mcp-lzynm). The pipeline writer (`ingest/pipeline/base.ts`)
 * applies the same rule inline because ingest may not import this domain.
 */
export function registryQdrantBackendFields(qdrant: {
  readonly url: string;
  readonly isEmbedded: boolean;
}): RegistryQdrantBackendFields {
  return { qdrantUrl: qdrant.isEmbedded ? EMBEDDED_MARKER : qdrant.url, qdrantEmbedded: qdrant.isEmbedded };
}

/**
 * Resolve the backend a registry entry addresses.
 *
 * @throws RegistryQdrantBackendUnresolvedError when an untrusted writer left a
 *   flag claiming embedded next to an address that is demonstrably not the
 *   daemon's. Both facts are then worthless and guessing either way sends the
 *   run to the wrong backend, so the operator is told to re-register instead.
 */
export function resolveRegistryQdrantBackend(entry: CollectionEntry): RegistryQdrantBackend {
  // The sentinel is unambiguous at any age — it names no port to go stale.
  if (entry.qdrantUrl === EMBEDDED_MARKER) return { kind: "embedded" };

  if (writerStoresAgreeingBackendPair(entry.teaRagsVersion) && entry.qdrantEmbedded !== undefined) {
    return entry.qdrantEmbedded ? { kind: "embedded" } : addressedBackend(entry.qdrantUrl);
  }

  // Untrusted writer: the URL's shape is the only evidence worth reading.
  if (isEmbeddedDaemonAddress(entry.qdrantUrl)) return { kind: "embedded" };
  if (entry.qdrantEmbedded === true) throw new RegistryQdrantBackendUnresolvedError(entry);
  return addressedBackend(entry.qdrantUrl);
}
