import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * Finds a live embedded Qdrant daemon whose `daemon.pid` / `daemon.port` files
 * were lost (bd tea-rags-mcp-k6sy2). Without it `ensureDaemon` cold-spawns a
 * second qdrant over the SAME storage, which dies on the held storage lock, and
 * the live daemon is never re-adopted — every caller fails until a restart.
 *
 * Identification reads the process table WITH environments (`ps axeww`, which
 * BSD/macOS and procps-ng Linux both support for the caller's own processes):
 * our daemon is the process whose command starts with our binary path and whose
 * environment carries `QDRANT__STORAGE__STORAGE_PATH=<this storage>` — both set
 * by `buildDaemonEnv` at spawn, with `QDRANT__SERVICE__HTTP_PORT` naming the port
 * it listens on. Any failure (no `ps`, a `ps` without `e`, restricted env
 * visibility) degrades to "nothing found", i.e. the pre-existing cold spawn.
 */

const PS_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const PS_TIMEOUT_MS = 5000;
const STORAGE_PATH_ENV = "QDRANT__STORAGE__STORAGE_PATH";
const HTTP_PORT_PATTERN = /(?:^|\s)QDRANT__SERVICE__HTTP_PORT=(\d+)(?:\s|$)/;

export interface ProcessTableRow {
  pid: number;
  /** Command with its arguments, followed by the process environment. */
  commandLine: string;
}

export interface OrphanedDaemon {
  pid: number;
  port: number;
}

export interface OrphanedDaemonDiscoveryDeps {
  /** `undefined` when the table cannot be read on this platform. */
  readProcessTable: () => Promise<readonly ProcessTableRow[] | undefined>;
  isAlive: (pid: number) => boolean;
}

export function parseProcessTable(stdout: string): ProcessTableRow[] {
  const rows: ProcessTableRow[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match) rows.push({ pid: parseInt(match[1], 10), commandLine: match[2] });
  }
  return rows;
}

export async function readProcessTable(): Promise<readonly ProcessTableRow[] | undefined> {
  try {
    // promisify at call time, not module load: importing this module must not
    // touch child_process (callers' tests mock it partially).
    const { stdout } = await promisify(execFile)("ps", ["axeww", "-o", "pid=,command="], {
      maxBuffer: PS_MAX_BUFFER_BYTES,
      timeout: PS_TIMEOUT_MS,
    });
    return parseProcessTable(stdout);
  } catch {
    return undefined;
  }
}

function servesStorage(commandLine: string, storagePath: string): boolean {
  const needle = ` ${STORAGE_PATH_ENV}=${storagePath}`;
  let from = commandLine.indexOf(needle);
  while (from !== -1) {
    const boundary = commandLine.charAt(from + needle.length);
    if (boundary === "" || /\s/.test(boundary)) return true;
    from = commandLine.indexOf(needle, from + 1);
  }
  return false;
}

function isOurBinary(commandLine: string, binaryPath: string): boolean {
  return commandLine === binaryPath || commandLine.startsWith(`${binaryPath} `);
}

export async function findOrphanedDaemon(
  storagePath: string,
  binaryPath: string,
  deps: OrphanedDaemonDiscoveryDeps,
): Promise<OrphanedDaemon | undefined> {
  const rows = await deps.readProcessTable();
  if (rows === undefined) return undefined;
  for (const row of rows) {
    if (!isOurBinary(row.commandLine, binaryPath)) continue;
    if (!servesStorage(row.commandLine, storagePath)) continue;
    const port = HTTP_PORT_PATTERN.exec(row.commandLine);
    if (!port) continue;
    if (!deps.isAlive(row.pid)) continue;
    return { pid: row.pid, port: parseInt(port[1], 10) };
  }
  return undefined;
}
