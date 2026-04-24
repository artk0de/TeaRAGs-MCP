/**
 * Qdrant adapter errors.
 */

import { InfraError } from "../errors.js";

export class QdrantUnavailableError extends InfraError {
  constructor(url: string, cause?: Error) {
    super({
      code: "INFRA_QDRANT_UNAVAILABLE",
      message: `Qdrant is not reachable at ${url}`,
      hint: `Start Qdrant: docker compose up -d, or verify QDRANT_URL=${url}`,
      httpStatus: 503,
      cause,
    });
  }
}

export interface StartupDetails {
  pid?: number;
  storagePath?: string;
}

function buildObservabilityHint(details: StartupDetails | undefined): string {
  const pid = details?.pid;
  const storage = details?.storagePath;
  const { platform } = process;

  const lines: string[] = [];
  if (pid !== undefined) {
    if (platform === "darwin") {
      lines.push(`ps -o pid,etime,time,command -p ${pid}`);
      lines.push(`lsof -p ${pid} 2>/dev/null | grep -oE 'segments/[0-9a-f-]{36}' | sort -u | wc -l`);
    } else if (platform === "linux") {
      lines.push(`ps -o pid,etime,time,command -p ${pid}`);
      lines.push(
        `ls /proc/${pid}/fd 2>/dev/null | xargs -I{} readlink /proc/${pid}/fd/{} 2>/dev/null | ` +
          `grep -oE 'segments/[0-9a-f-]{36}' | sort -u | wc -l`,
      );
    } else if (platform === "win32") {
      lines.push(`Get-Process -Id ${pid} | Format-List Name,Id,CPU,StartTime`);
    }
  }
  if (storage) {
    if (platform === "win32") {
      lines.push(`Get-ChildItem '${storage}/collections' -Recurse -Directory -Filter segments`);
    } else {
      lines.push(`find '${storage}/collections' -maxdepth 4 -type d -name segments -exec ls {} \\; | wc -l`);
    }
  }
  return lines.length > 0 ? `To observe progress externally, run:\n  ${lines.join("\n  ")}` : "";
}

/**
 * Embedded Qdrant daemon was spawned very recently. HTTP port is not
 * bound yet because the process is still in its initial boot phase
 * (config parsing, raft/alias load, jemalloc init). This is a short
 * window — usually a few seconds. Retry fast.
 */
export class QdrantStartingError extends InfraError {
  constructor(url: string, details?: StartupDetails, cause?: Error) {
    const obs = buildObservabilityHint(details);
    super({
      code: "INFRA_QDRANT_STARTING",
      message: `Qdrant daemon at ${url} is starting up`,
      hint:
        `The embedded Qdrant daemon was spawned a moment ago and the HTTP ` +
        `server has not bound the port yet. Retry the same operation in 3-10 seconds.${obs ? `\n\n${obs}` : ""}`,
      httpStatus: 503,
      cause,
    });
  }
}

/**
 * Embedded Qdrant daemon is alive and has passed the initial boot window,
 * but HTTP is still unreachable — the process is recovering shards or
 * running a background segment optimization that blocks the HTTP bind.
 * Can last tens of seconds to several minutes on large collections.
 */
export class QdrantRecoveringError extends InfraError {
  constructor(url: string, details?: StartupDetails, cause?: Error) {
    const obs = buildObservabilityHint(details);
    super({
      code: "INFRA_QDRANT_RECOVERING",
      message: `Qdrant daemon at ${url} is recovering shards`,
      hint:
        `The daemon is alive (pid running) but the HTTP port is still not ` +
        `bound — it is loading shards from disk or merging segments. Large ` +
        `collections can take 1-5 minutes. Retry in 30-120 seconds.${obs ? `\n\n${obs}` : ""}`,
      httpStatus: 503,
      cause,
    });
  }
}

export class QdrantTimeoutError extends InfraError {
  constructor(url: string, operation: string, cause?: Error) {
    super({
      code: "INFRA_QDRANT_TIMEOUT",
      message: `Qdrant operation "${operation}" timed out at ${url}`,
      hint: `Check Qdrant health at ${url}/healthz and consider increasing timeout`,
      httpStatus: 504,
      cause,
    });
  }
}

export class AliasOperationError extends InfraError {
  constructor(operation: string, detail: string, cause?: Error) {
    super({
      code: "INFRA_ALIAS_OPERATION",
      message: `Alias operation "${operation}" failed: ${detail}`,
      hint: "Check Qdrant server status and collection names",
      httpStatus: 500,
      cause,
    });
  }
}

export class QdrantOperationError extends InfraError {
  constructor(operation: string, detail: string, cause?: Error) {
    super({
      code: "INFRA_QDRANT_OPERATION_FAILED",
      message: `Qdrant ${operation} failed: ${detail}`,
      hint: "Check Qdrant logs for details",
      httpStatus: 500,
      cause,
    });
  }
}

export class QdrantPointNotFoundError extends InfraError {
  constructor(pointId: string, collectionName: string, cause?: Error) {
    super({
      code: "INFRA_QDRANT_POINT_NOT_FOUND",
      message: `Point "${pointId}" not found in collection "${collectionName}"`,
      hint: "The point ID may be stale after a reindex. Run a new search to get current IDs.",
      httpStatus: 404,
      cause,
    });
  }
}

export class CollectionAlreadyExistsError extends InfraError {
  constructor(collectionName: string, cause?: Error) {
    super({
      code: "INFRA_COLLECTION_ALREADY_EXISTS",
      message: `Collection "${collectionName}" already exists`,
      hint:
        `Another session may be indexing into this collection. ` +
        `Wait for it to finish, or restart the MCP server to release stale locks. ` +
        `If the collection is orphaned, use clear_index to remove it.`,
      httpStatus: 409,
      cause,
    });
  }
}

export class QdrantOptimizationInProgressError extends InfraError {
  constructor(collectionName: string, cause?: Error) {
    super({
      code: "INFRA_QDRANT_OPTIMIZATION_IN_PROGRESS",
      message: `Qdrant collection "${collectionName}" is optimizing`,
      hint:
        `Collection is under background optimization (status=yellow). ` +
        `Wait 1-5 minutes and retry, or run /tea-rags:force-reindex to build ` +
        `a new collection in parallel without waiting.`,
      httpStatus: 503,
      cause,
    });
  }
}
