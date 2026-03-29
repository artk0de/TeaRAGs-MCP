export interface DaemonPaths {
  pidFile: string;
  portFile: string;
  refsFile: string;
  lockFile: string;
  storagePath: string;
}

export interface DaemonHandle {
  url: string;
  release: () => void;
  /** Re-read daemon.port and return new URL if daemon restarted on a different port. */
  reconnect: () => string | null;
}

export type QdrantResolution =
  | { mode: "external"; url: string }
  | { mode: "embedded"; url: string; release: () => void; reconnect: () => string | null };
