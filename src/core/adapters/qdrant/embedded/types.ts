export interface DaemonPaths {
  pidFile: string;
  portFile: string;
  refsFile: string;
  lockFile: string;
  startedAtFile: string;
  storagePath: string;
}

export type StartupPhase = "starting" | "recovering";

export interface DaemonHandle {
  url: string;
  release: () => void;
  /**
   * Fully re-resolve the daemon URL: re-read daemon.port if the daemon is alive,
   * or respawn a fresh daemon if it is gone. Returns the new URL, or null if the
   * live daemon kept the same port. Async because respawn spawns a process.
   */
  reconnect: () => Promise<string | null>;
  /**
   * Returns the current startup phase of the embedded daemon:
   *  - "starting" — spawned recently, HTTP not bound yet, expect <15s window
   *  - "recovering" — past initial boot, recovering shards / optimizing
   *  - null — daemon process is not alive
   */
  startupPhase: () => StartupPhase | null;
  /** Child process PID (for diagnostic messages). */
  pid: number;
  /** Storage directory of this daemon (for diagnostic messages). */
  storagePath: string;
}

export type QdrantResolution =
  | { mode: "external"; url: string }
  | {
      mode: "embedded";
      url: string;
      release: () => void;
      reconnect: () => Promise<string | null>;
      startupPhase: () => StartupPhase | null;
      pid: number;
      storagePath: string;
    };
