export interface DaemonPaths {
  pidFile: string;
  portFile: string;
  refsFile: string;
  storagePath: string;
}

export interface DaemonHandle {
  url: string;
  release: () => void;
}

export type QdrantResolution =
  | { mode: "external"; url: string }
  | { mode: "embedded"; url: string; release: () => void };
