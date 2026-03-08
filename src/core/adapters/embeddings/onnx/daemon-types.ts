/** Client → Daemon */
export type DaemonRequest =
  | { type: "connect"; model: string; device: string; cacheDir?: string }
  | { type: "embed"; id: number; texts: string[] }
  | { type: "heartbeat" }
  | { type: "disconnect" }
  | { type: "status" }
  | { type: "shutdown" };

/** Daemon → Client */
export type DaemonResponse =
  | { type: "connected"; model: string; clients: number }
  | { type: "result"; id: number; embeddings: number[][] }
  | { type: "error"; message: string }
  | { type: "pong" }
  | {
      type: "status";
      model: string;
      device: string;
      clients: number;
      idleMs: number;
      uptime: number;
    }
  | { type: "bye" }
  | { type: "log"; level: "error"; message: string };

export function serialize(msg: DaemonRequest | DaemonResponse): string {
  return `${JSON.stringify(msg)  }\n`;
}

export function parseLine(
  line: string,
): (DaemonRequest | DaemonResponse) | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as DaemonRequest | DaemonResponse;
  } catch {
    return null;
  }
}
