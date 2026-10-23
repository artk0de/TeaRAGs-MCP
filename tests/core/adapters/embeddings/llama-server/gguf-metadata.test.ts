import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readGgufContextLength } from "../../../../../src/core/adapters/embeddings/llama-server/gguf-metadata.js";

// GGUF value type ids.
const UINT32 = 4;
const STRING = 8;
const ARRAY = 9;
const UINT64 = 10;
const FLOAT32 = 6;

type GgufValue =
  | { type: typeof UINT32; value: number }
  | { type: typeof UINT64; value: bigint }
  | { type: typeof FLOAT32; value: number }
  | { type: typeof STRING; value: string }
  | { type: typeof ARRAY; of: typeof STRING; value: string[] }
  | { type: typeof ARRAY; of: typeof FLOAT32; value: number[] };

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

function u64(n: bigint | number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

function ggufString(s: string): Buffer {
  const bytes = Buffer.from(s, "utf8");
  return Buffer.concat([u64(bytes.length), bytes]);
}

function f32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeFloatLE(n);
  return b;
}

function encodeValue(v: GgufValue): Buffer {
  switch (v.type) {
    case UINT32:
      return Buffer.concat([u32(UINT32), u32(v.value)]);
    case UINT64:
      return Buffer.concat([u32(UINT64), u64(v.value)]);
    case FLOAT32:
      return Buffer.concat([u32(FLOAT32), f32(v.value)]);
    case STRING:
      return Buffer.concat([u32(STRING), ggufString(v.value)]);
    case ARRAY: {
      const items = v.of === STRING ? v.value.map((s) => ggufString(s)) : v.value.map((n) => f32(n));
      return Buffer.concat([u32(ARRAY), u32(v.of), u64(v.value.length), ...items]);
    }
  }
}

/** A GGUF header: magic, version, tensor count, KV pairs. No tensor data follows. */
function ggufHeader(kv: [string, GgufValue][], version = 3, tensorCount = 3n): Buffer {
  return Buffer.concat([
    Buffer.from("GGUF", "ascii"),
    u32(version),
    u64(tensorCount),
    u64(kv.length),
    ...kv.map(([key, value]) => Buffer.concat([ggufString(key), encodeValue(value)])),
  ]);
}

const TOKENS: GgufValue = { type: ARRAY, of: STRING, value: ["[PAD]", "def", "class", "fn"] };

describe("readGgufContextLength", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gguf-meta-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function file(name: string, bytes: Buffer): string {
    const path = join(dir, name);
    writeFileSync(path, bytes);
    return path;
  }

  it("reads <general.architecture>.context_length from a v3 header, skipping arrays before it", async () => {
    const path = file(
      "coderank.gguf",
      ggufHeader([
        ["general.architecture", { type: STRING, value: "nomic-bert" }],
        ["tokenizer.ggml.tokens", TOKENS],
        ["tokenizer.ggml.scores", { type: ARRAY, of: FLOAT32, value: [0.5, -1, 2] }],
        ["nomic-bert.embedding_length", { type: UINT32, value: 768 }],
        ["nomic-bert.context_length", { type: UINT32, value: 2048 }],
      ]),
    );
    await expect(readGgufContextLength(path)).resolves.toBe(2048);
  });

  it("finds the context length when it precedes the architecture key", async () => {
    const path = file(
      "early.gguf",
      ggufHeader([
        ["jina-bert-v2.context_length", { type: UINT32, value: 8192 }],
        ["bert.context_length", { type: UINT32, value: 512 }],
        ["general.architecture", { type: STRING, value: "jina-bert-v2" }],
      ]),
    );
    await expect(readGgufContextLength(path)).resolves.toBe(8192);
  });

  it("reads a v2 header and a uint64 context length", async () => {
    const path = file(
      "v2.gguf",
      ggufHeader(
        [
          ["general.architecture", { type: STRING, value: "bert" }],
          ["bert.context_length", { type: UINT64, value: 512n }],
        ],
        2,
      ),
    );
    await expect(readGgufContextLength(path)).resolves.toBe(512);
  });

  it("returns undefined for a missing file", async () => {
    await expect(readGgufContextLength(join(dir, "absent.gguf"))).resolves.toBeUndefined();
  });

  it("returns undefined for a file that is not GGUF", async () => {
    await expect(readGgufContextLength(file("x.gguf", Buffer.from("not a gguf file at all")))).resolves.toBeUndefined();
  });

  it("returns undefined for an unsupported GGUF version 1", async () => {
    const path = file("v1.gguf", ggufHeader([["general.architecture", { type: STRING, value: "bert" }]], 1));
    await expect(readGgufContextLength(path)).resolves.toBeUndefined();
  });

  it("returns undefined when the header names no context length for its architecture", async () => {
    const path = file(
      "none.gguf",
      ggufHeader([
        ["general.architecture", { type: STRING, value: "bert" }],
        ["llama.context_length", { type: UINT32, value: 4096 }],
      ]),
    );
    await expect(readGgufContextLength(path)).resolves.toBeUndefined();
  });

  it("returns undefined for a header truncated inside the KV section", async () => {
    const whole = ggufHeader([
      ["general.architecture", { type: STRING, value: "bert" }],
      ["tokenizer.ggml.tokens", TOKENS],
      ["bert.context_length", { type: UINT32, value: 512 }],
    ]);
    await expect(
      readGgufContextLength(file("cut.gguf", whole.subarray(0, whole.length - 30))),
    ).resolves.toBeUndefined();
  });
});
