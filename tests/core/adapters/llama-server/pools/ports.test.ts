import { describe, expect, it } from "vitest";

import {
  LLAMA_SERVER_POOL_PORT_MAX,
  LLAMA_SERVER_POOL_PORT_MIN,
  pickFreePorts,
} from "../../../../../src/core/adapters/llama-server/pools/ports.js";

/** A `random` that replays `values` in order, then repeats the last one. */
function sequence(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

describe("pickFreePorts", () => {
  it("picks distinct ports inside 20000–29999", async () => {
    const ports = await pickFreePorts(3, { isFree: async () => true, random: Math.random });

    expect(ports).toHaveLength(3);
    expect(new Set(ports).size).toBe(3);
    for (const port of ports) {
      expect(port).toBeGreaterThanOrEqual(LLAMA_SERVER_POOL_PORT_MIN);
      expect(port).toBeLessThanOrEqual(LLAMA_SERVER_POOL_PORT_MAX);
    }
    expect(LLAMA_SERVER_POOL_PORT_MIN).toBe(20000);
    expect(LLAMA_SERVER_POOL_PORT_MAX).toBe(29999);
  });

  it("maps the random range edges onto the port range edges", async () => {
    const ports = await pickFreePorts(2, { isFree: async () => true, random: sequence([0, 0.99999]) });

    expect(ports).toEqual([20000, 29999]);
  });

  it("skips busy ports and repeats", async () => {
    const busy = new Set([20000]);
    const ports = await pickFreePorts(2, {
      isFree: async (port) => !busy.has(port),
      random: sequence([0, 0, 0.1, 0.1, 0.2]),
    });

    expect(ports).toEqual([21000, 22000]);
  });

  it("gives up when the range yields no free port", async () => {
    await expect(pickFreePorts(1, { isFree: async () => false, random: Math.random })).rejects.toThrow(/free port/);
  });
});
