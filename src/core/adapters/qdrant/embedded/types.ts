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
  /** Re-read daemon.port and return new URL if daemon restarted on a different port. */
  reconnect: () => string | null;
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
      reconnect: () => string | null;
      startupPhase: () => StartupPhase | null;
      pid: number;
      storagePath: string;
    };
