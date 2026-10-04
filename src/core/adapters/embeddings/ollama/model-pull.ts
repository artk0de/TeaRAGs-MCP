// Copyright (c) 2026 Arthur Korochansky
// SPDX-License-Identifier: MIT

/**
 * Auto-pull of a missing Ollama embedding model (EMBEDDING_AUTO_PULL).
 *
 * A fresh Ollama box answers every embed with 404 "model not found" until the
 * operator runs `ollama pull`. This module closes that gap at startup: probe
 * `/api/show`, and only on a definite 404 stream `/api/pull` to completion,
 * logging progress. Anything other than a 404 — a transport failure, a 5xx —
 * says nothing about whether the model exists, so it is left to the embed
 * path, which owns unavailability (recovery wait, failover).
 */

import { OllamaModelPullFailedError } from "./errors.js";

export interface OllamaModelPullDeps {
  fetch: typeof fetch;
  /** One human-readable progress line per call. */
  log: (line: string) => void;
}

interface OllamaPullLine {
  status?: string;
  digest?: string;
  total?: number;
  completed?: number;
  error?: string;
}

/**
 * Ensure `model` exists on the Ollama server at `baseUrl`, pulling it when the
 * server reports it missing. Throws `OllamaModelPullFailedError` (hint names
 * `ollama pull <model>`) when the pull does not reach `success`.
 */
export async function ensureOllamaModelPresent(
  baseUrl: string,
  model: string,
  deps: OllamaModelPullDeps,
): Promise<"present" | "pulled"> {
  let show: Response;
  try {
    show = await deps.fetch(`${baseUrl}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });
  } catch {
    return "present";
  }
  if (show.status !== 404) return "present";

  deps.log(`model ${model} missing at ${baseUrl} — pulling (EMBEDDING_AUTO_PULL)`);
  const pull = await requestPull(baseUrl, model, deps);
  await drainPullStream(pull, baseUrl, model, deps);
  deps.log(`model ${model} pulled`);
  return "pulled";
}

async function requestPull(baseUrl: string, model: string, deps: OllamaModelPullDeps): Promise<Response> {
  let pull: Response;
  try {
    pull = await deps.fetch(`${baseUrl}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, stream: true }),
    });
  } catch (error) {
    throw new OllamaModelPullFailedError(model, baseUrl, error instanceof Error ? error.message : "request failed");
  }
  if (!pull.ok) {
    throw new OllamaModelPullFailedError(model, baseUrl, await refusalReason(pull));
  }
  return pull;
}

/** The server's own `{"error": ...}` when it sent one, else the status. */
async function refusalReason(response: Response): Promise<string> {
  try {
    const parsed = JSON.parse(await response.text()) as { error?: string };
    if (parsed.error) return parsed.error;
  } catch {
    // Non-JSON body — keep the status form.
  }
  return `status ${response.status}`;
}

/**
 * Read the NDJSON progress stream to its end. Draining IS the wait for the
 * pull to finish; a stream that ends without `success`, or carries an
 * `error` line, is a failed pull.
 */
async function drainPullStream(
  response: Response,
  baseUrl: string,
  model: string,
  deps: OllamaModelPullDeps,
): Promise<void> {
  const loggedDecile = new Map<string, number>();
  let succeeded = false;

  const handle = (raw: string): void => {
    const text = raw.trim();
    if (text === "") return;
    let line: OllamaPullLine;
    try {
      line = JSON.parse(text) as OllamaPullLine;
    } catch {
      return;
    }
    if (line.error) throw new OllamaModelPullFailedError(model, baseUrl, line.error);
    if (line.status === "success") succeeded = true;
    if (line.digest && line.total && line.total > 0 && line.completed !== undefined) {
      const decile = Math.floor((line.completed / line.total) * 10);
      if (decile > (loggedDecile.get(line.digest) ?? -1)) {
        loggedDecile.set(line.digest, decile);
        deps.log(`pulling ${model}: ${decile * 10}% of ${formatMiB(line.total)}`);
      }
    }
  };

  const decoder = new TextDecoder();
  let buffered = "";
  if (response.body) {
    for await (const piece of response.body as AsyncIterable<Uint8Array>) {
      buffered += decoder.decode(piece, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      lines.forEach(handle);
    }
  }
  handle(buffered + decoder.decode());

  if (!succeeded) {
    throw new OllamaModelPullFailedError(model, baseUrl, "pull stream ended without success");
  }
}

function formatMiB(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MiB`;
}
