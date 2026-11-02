// Copyright (c) 2026 Arthur Korochansky
// SPDX-License-Identifier: MIT

/**
 * Ports for managed llama-server instances: random, distinct, free, inside a
 * fixed loopback range that stays clear of the 8080/8081 a hand-run
 * llama-server usually takes.
 */

import { createServer } from "node:net";

import { LlamaServerPoolStartError } from "./errors.js";

export const LLAMA_SERVER_POOL_PORT_MIN = 20000;
export const LLAMA_SERVER_POOL_PORT_MAX = 29999;

const PORT_RANGE_SIZE = LLAMA_SERVER_POOL_PORT_MAX - LLAMA_SERVER_POOL_PORT_MIN + 1;
const ATTEMPTS_PER_PORT = 200;

/** `count` distinct free ports in 20000–29999; `random` returns [0, 1). */
export async function pickFreePorts(
  count: number,
  deps: { isFree: (port: number) => Promise<boolean>; random: () => number },
): Promise<number[]> {
  const ports: number[] = [];
  for (let attempt = 0; ports.length < count && attempt < count * ATTEMPTS_PER_PORT; attempt++) {
    const port = LLAMA_SERVER_POOL_PORT_MIN + Math.floor(deps.random() * PORT_RANGE_SIZE);
    if (ports.includes(port) || !(await deps.isFree(port))) continue;
    ports.push(port);
  }
  if (ports.length < count) {
    throw new LlamaServerPoolStartError(
      `No free port for llama-server in ${LLAMA_SERVER_POOL_PORT_MIN}–${LLAMA_SERVER_POOL_PORT_MAX} after ${count * ATTEMPTS_PER_PORT} tries`,
      "Stop unused llama-server pools (tea-rags llama-server stop) or free ports in that range",
    );
  }
  return ports;
}

/** True when `port` can be bound on 127.0.0.1 right now — the probe listens and closes at once. */
export async function isLoopbackPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => {
      resolve(false);
    });
    server.listen(port, "127.0.0.1", () => {
      server.close(() => {
        resolve(true);
      });
    });
  });
}
