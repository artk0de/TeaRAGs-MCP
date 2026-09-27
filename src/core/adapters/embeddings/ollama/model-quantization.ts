// Copyright (c) 2026 Arthur Korochansky
// SPDX-License-Identifier: MIT

/**
 * Server-side model quantization for the Ollama embedding path.
 *
 * The embedding model's gguf quantization level is a SERVER property, not a
 * request parameter — a quantized copy has to exist on the box as its own
 * model tag. This module owns the whole lifecycle: resolving the requested
 * level (`OLLAMA_QUANTIZATION`, where `turbo` names the most aggressive
 * level, mirroring Qdrant's turbo quantization vocabulary), deriving the
 * quantized tag, and provisioning it over the HTTP API (`/api/show` probe,
 * `/api/create` with `quantize`). A server that cannot quantize (too old,
 * unsupported source format) degrades to the unquantized base model with a
 * visible warning — never a hard failure of the indexing run.
 */

/** Concrete gguf quantization levels tea-rags will provision. */
export type OllamaQuantizationLevel = "off" | "q8_0" | "q5_K_M" | "q4_K_M";

/** `turbo` — the most aggressive level, by analogy with Qdrant turbo quantization. */
export const TURBO_OLLAMA_QUANTIZATION_LEVEL: OllamaQuantizationLevel = "q4_K_M";

export interface QuantizedModelProvision {
  /** The model name embed calls should carry — the quantized tag, or the base when not quantized. */
  effectiveModel: string;
  /** Whether the effective model is a quantized copy. */
  quantized: boolean;
  /** Present when quantization was requested but could not be established. */
  warning?: string;
}

/**
 * Map a raw config value to a concrete level. Unknown values degrade to
 * `off` rather than throwing: the schema-level enum is the validation
 * boundary, and a typo silently disabling quantization is recoverable, while
 * a thrown constructor error is not.
 */
export function resolveOllamaQuantizationLevel(requested: string | undefined): OllamaQuantizationLevel {
  if (requested === "turbo") return TURBO_OLLAMA_QUANTIZATION_LEVEL;
  if (requested === "q8_0" || requested === "q5_K_M" || requested === "q4_K_M") return requested;
  return "off";
}

/**
 * Derive the quantized copy's tag from the base model name. The level is
 * appended to the base's own tag (`a/b:latest` → `a/b:latest-q4_K_M`) so the
 * copy never collides with a tag the publisher might ship; a tagless base
 * gets the level as its tag.
 */
export function quantizedOllamaModelTag(baseModel: string, level: OllamaQuantizationLevel): string {
  const lastColon = baseModel.lastIndexOf(":");
  // A colon after the last slash separates the tag; otherwise the base has none.
  const lastSlash = baseModel.lastIndexOf("/");
  if (lastColon > lastSlash) return `${baseModel}-${level}`;
  return `${baseModel}:${level}`;
}

/**
 * Ensure the quantized copy exists on the server and report which model to
 * embed with. `off` short-circuits without touching the network.
 */
export async function provisionQuantizedOllamaModel(deps: {
  baseUrl: string;
  baseModel: string;
  level: OllamaQuantizationLevel;
  fetchImpl?: typeof fetch;
}): Promise<QuantizedModelProvision> {
  if (deps.level === "off") return { effectiveModel: deps.baseModel, quantized: false };

  const fetchImpl = deps.fetchImpl ?? fetch;
  const tag = quantizedOllamaModelTag(deps.baseModel, deps.level);

  try {
    const show = await fetchImpl(`${deps.baseUrl}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: tag }),
    });
    if (show.ok) return { effectiveModel: tag, quantized: true };
  } catch {
    // Fall through to the create attempt — a probe transport error says
    // nothing about whether the server can quantize.
  }

  try {
    const create = await fetchImpl(`${deps.baseUrl}/api/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: tag, from: deps.baseModel, quantize: deps.level }),
    });
    // /api/create streams NDJSON progress lines; draining the body IS the
    // wait for completion.
    if (create.ok) {
      await create.text();
      return { effectiveModel: tag, quantized: true };
    }
    // Surface the server's own reason — "create-time quantization is only
    // supported for safetensors imports" (a GGUF base) is actionable; a bare
    // "refused" is not.
    let refusal = `status ${create.status}`;
    try {
      const body = await create.text();
      const parsed = JSON.parse(body) as { error?: string };
      if (parsed.error) refusal = parsed.error;
    } catch {
      // Non-JSON body — keep the status form.
    }
    return {
      effectiveModel: deps.baseModel,
      quantized: false,
      warning: `Ollama quantization ${deps.level} unavailable (${refusal}) — embedding with unquantized ${deps.baseModel}`,
    };
  } catch (error) {
    return {
      effectiveModel: deps.baseModel,
      quantized: false,
      warning: `Ollama quantization ${deps.level} unavailable (${error instanceof Error ? error.message : "request failed"}) — embedding with unquantized ${deps.baseModel}`,
    };
  }
}
