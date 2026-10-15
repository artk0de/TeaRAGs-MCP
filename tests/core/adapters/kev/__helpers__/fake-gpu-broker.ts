/**
 * In-process stand-in for the nucbox GPU session broker (kev-rocm-serving
 * `broker/`): one lease at a time, the same routes and status codes. Each
 * route's answer can be overridden to script 409 / 503 / 404 cases.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface BrokerRequest {
  method: string;
  path: string;
  token?: string;
  body?: unknown;
}

export interface BrokerReply {
  status: number;
  body: unknown;
}

export interface FakeGpuBroker {
  url: string;
  requests: BrokerRequest[];
  /** Kev URL handed out with every lease. */
  kevUrl: string;
  kevRun: string;
  /** Lease the broker currently honours; `undefined` = EMBED. */
  lease: string | undefined;
  /** Scripted answer for the next POST /v1/session; default grants a lease. */
  onAcquire: ((body: unknown) => BrokerReply) | undefined;
  /** Scripted answer for heartbeats; default 200 for the live lease, 404 otherwise. */
  onHeartbeat: ((lease: string) => BrokerReply) | undefined;
  close: () => Promise<void>;
}

const readBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text.length > 0 ? JSON.parse(text) : undefined;
};

const send = (res: ServerResponse, reply: BrokerReply): void => {
  res.writeHead(reply.status, { "content-type": "application/json" });
  res.end(JSON.stringify(reply.body));
};

export async function startFakeGpuBroker(options: { token?: string } = {}): Promise<FakeGpuBroker> {
  let leaseCount = 0;
  const broker: FakeGpuBroker = {
    url: "",
    requests: [],
    kevUrl: "http://kev-host:8009",
    kevRun: "jaredpalmer/kev-4b@v1.0",
    lease: undefined,
    onAcquire: undefined,
    onHeartbeat: undefined,
    close: async () => undefined,
  };

  const route = (method: string, path: string, body: unknown): BrokerReply => {
    if (method === "GET" && path === "/v1/state") {
      return {
        status: 200,
        body: {
          state: broker.lease ? "KEV" : "EMBED",
          lease: broker.lease ?? null,
          kev: { healthy: broker.lease !== undefined, run: broker.kevRun, url: broker.kevUrl, sharedMb: 0 },
        },
      };
    }
    if (method === "POST" && path === "/v1/session") {
      if (broker.onAcquire) return broker.onAcquire(body);
      if (broker.lease) return { status: 409, body: { holder: "someone-else:1", state: "KEV" } };
      broker.lease = `lease-${++leaseCount}`;
      return { status: 200, body: { lease: broker.lease, kevUrl: broker.kevUrl, expiresAt: 1_900_000_000 } };
    }
    const heartbeat = /^\/v1\/session\/([^/]+)\/heartbeat$/.exec(path);
    if (method === "POST" && heartbeat) {
      if (broker.onHeartbeat) return broker.onHeartbeat(heartbeat[1]);
      return heartbeat[1] === broker.lease
        ? { status: 200, body: { lease: broker.lease, expiresAt: 1_900_000_120 } }
        : { status: 404, body: { error: "unknown lease" } };
    }
    const release = /^\/v1\/session\/([^/]+)$/.exec(path);
    if (method === "DELETE" && release) {
      if (release[1] !== broker.lease) return { status: 404, body: { error: "unknown lease" } };
      broker.lease = undefined;
      return { status: 202, body: { state: "SWITCHING_TO_EMBED" } };
    }
    return { status: 404, body: { error: "no route" } };
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const method = req.method ?? "GET";
      const path = req.url ?? "/";
      const body = await readBody(req);
      const token = req.headers["x-broker-token"];
      broker.requests.push({
        method,
        path,
        ...(typeof token === "string" ? { token } : {}),
        ...(body !== undefined ? { body } : {}),
      });
      if (options.token !== undefined && token !== options.token) {
        send(res, { status: 401, body: { error: "bad token" } });
        return;
      }
      send(res, route(method, path, body));
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  broker.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  broker.close = async () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
  return broker;
}
