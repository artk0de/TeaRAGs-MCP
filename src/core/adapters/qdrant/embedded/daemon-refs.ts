import { readFileSync, writeFileSync } from "node:fs";

/**
 * Who holds the embedded Qdrant daemon. `holders` is a multiset of pids, one
 * entry per attach, so a holder that exits without releasing is pruned on the
 * next read. `anonymous` counts refs with no recorded pid — those written by a
 * build that kept a bare integer — and is never pruned.
 *
 * On disk: the live count on the first line, then one pid per line. An integer
 * reader (`parseInt(content)`) therefore sees the same count this module does.
 */
interface DaemonRefs {
  anonymous: number;
  holders: number[];
}

type HolderLiveness = (pid: number) => boolean;

/** Exit hooks of the current process; injected in tests. */
export interface ExitHooks {
  on: (listener: () => void) => void;
  off: (listener: () => void) => void;
}

const processExitHooks: ExitHooks = {
  on: (listener) => process.once("exit", listener),
  off: (listener) => process.off("exit", listener),
};

/** EPERM means the pid runs under another user — still a holder. */
function isHolderAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseDaemonRefs(content: string): DaemonRefs {
  const [first = "", ...rest] = content.trim().split("\n");
  const count = parseInt(first, 10) || 0;
  const holders = rest.map((line) => parseInt(line, 10)).filter((pid) => pid > 0);
  return { anonymous: Math.max(0, count - holders.length), holders };
}

function liveCount(refs: DaemonRefs): number {
  return refs.anonymous + refs.holders.length;
}

function readLiveRefs(refsFile: string, isAlive: HolderLiveness): DaemonRefs {
  let refs: DaemonRefs;
  try {
    refs = parseDaemonRefs(readFileSync(refsFile, "utf-8"));
  } catch {
    return { anonymous: 0, holders: [] };
  }
  return { anonymous: refs.anonymous, holders: refs.holders.filter(isAlive) };
}

function writeDaemonRefs(refsFile: string, refs: DaemonRefs): number {
  const count = liveCount(refs);
  writeFileSync(refsFile, [String(count), ...refs.holders.map(String)].join("\n"), "utf-8");
  return count;
}

/** Live refs on the daemon: anonymous refs plus every holder still running. */
export function countLiveDaemonRefs(refsFile: string, isAlive: HolderLiveness = isHolderAlive): number {
  return liveCount(readLiveRefs(refsFile, isAlive));
}

/** Record one more ref for `pid`; returns the live count. Caller holds the daemon lock. */
export function attachDaemonRef(
  refsFile: string,
  pid: number = process.pid,
  isAlive: HolderLiveness = isHolderAlive,
): number {
  const refs = readLiveRefs(refsFile, isAlive);
  return writeDaemonRefs(refsFile, { anonymous: refs.anonymous, holders: [...refs.holders, pid] });
}

/**
 * Drop one ref of `pid`; returns the live count. A pid with no recorded ref
 * takes one anonymous ref instead — an integer writer folded its pid into the
 * count. Caller holds the daemon lock.
 */
export function detachDaemonRef(
  refsFile: string,
  pid: number = process.pid,
  isAlive: HolderLiveness = isHolderAlive,
): number {
  const refs = readLiveRefs(refsFile, isAlive);
  const index = refs.holders.indexOf(pid);
  if (index === -1) {
    return writeDaemonRefs(refsFile, { anonymous: Math.max(0, refs.anonymous - 1), holders: refs.holders });
  }
  const holders = refs.holders.filter((_, i) => i !== index);
  return writeDaemonRefs(refsFile, { anonymous: refs.anonymous, holders });
}

/** A freshly spawned daemon has exactly one holder: the spawner. */
export function seedDaemonRefs(refsFile: string, pid: number = process.pid): void {
  writeDaemonRefs(refsFile, { anonymous: 0, holders: [pid] });
}

/**
 * Wrap `detach` into a release that runs at most once — on an explicit call or
 * on process exit, whichever comes first. A crash or a signal skips both and
 * leaves the ref to pruning.
 */
export function bindDaemonRefRelease(
  detach: () => number,
  exitHooks: ExitHooks = processExitHooks,
): () => number | undefined {
  let released = false;
  const release = (): number | undefined => {
    if (released) return undefined;
    released = true;
    exitHooks.off(onExit);
    return detach();
  };
  const onExit = (): void => {
    release();
  };
  exitHooks.on(onExit);
  return release;
}
