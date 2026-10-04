/**
 * llama-server `GET /props` — the server's own description of what it serves.
 *
 * Measured on llama-server (homebrew build, 2026-10-03) started with
 * `-c 32768 -np 4`: `total_slots` = 4 and `default_generation_settings.n_ctx`
 * = 8192, i.e. the per-slot window is reported directly. Only when an older
 * build reports a bare top-level `n_ctx` (the whole KV budget) is it divided by
 * the slot count. Every field is optional: a build that lacks one leaves it
 * unset, and `/props` answering 404 means "no description" altogether.
 */

export interface LlamaServerProps {
  /** Context window of ONE slot, in tokens — the largest single input the server embeds. */
  nCtx?: number;
  /** Parallel request slots (`-np`). */
  totalSlots?: number;
  /** Path of the GGUF the server loaded. */
  modelPath?: string;
}

const PROPS_TIMEOUT_MS = 3_000;

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function parseLlamaServerProps(body: unknown): LlamaServerProps {
  if (typeof body !== "object" || body === null) return {};
  const raw = body as Record<string, unknown>;
  const props: LlamaServerProps = {};

  const totalSlots = positiveNumber(raw.total_slots);
  const settings = raw.default_generation_settings;
  const slotContext =
    typeof settings === "object" && settings !== null
      ? positiveNumber((settings as Record<string, unknown>).n_ctx)
      : undefined;
  const totalContext = positiveNumber(raw.n_ctx);

  if (slotContext !== undefined) props.nCtx = slotContext;
  else if (totalContext !== undefined) props.nCtx = Math.floor(totalContext / (totalSlots ?? 1));
  if (totalSlots !== undefined) props.totalSlots = totalSlots;
  if (typeof raw.model_path === "string" && raw.model_path.length > 0) props.modelPath = raw.model_path;
  return props;
}

export interface FetchLlamaServerPropsOptions {
  fetch: typeof fetch;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/** GET `<url>/props`. Undefined on 404, on any other failure, and on a non-JSON body. */
export async function fetchLlamaServerProps(
  url: string,
  options: FetchLlamaServerPropsOptions,
): Promise<LlamaServerProps | undefined> {
  try {
    const response = await options.fetch(`${url}/props`, {
      method: "GET",
      headers: options.headers ?? {},
      signal: AbortSignal.timeout(options.timeoutMs ?? PROPS_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    return parseLlamaServerProps(await response.json());
  } catch {
    return undefined;
  }
}
