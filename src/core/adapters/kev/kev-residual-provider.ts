/**
 * Kev (`/v1/systemone`) as a residual-resolution model. One request carries
 * questions of one enclosing method (the pass caps how many): `state` is the
 * method source, one `choice` question per call site, the menu is the
 * candidates' classes plus {@link KEV_NONE_OPTION}. Whether the questions of a
 * request share one prefill of the state depends on the server: with state
 * sharing off (`LEAN_SHARE_STATE=0`) the state is re-encoded per question.
 */

import {
  RESIDUAL_NONE_PROBABILITY_KEY,
  type ResidualAnswer,
  type ResidualModelProvider,
  type ResidualQuestion,
  type ResidualQuestionGroup,
} from "../../contracts/types/codegraph-residual.js";
import {
  KevRequestCancelledError,
  KevResponseError,
  KevStateTooLongError,
  KevTimeoutError,
  KevUnavailableError,
} from "./errors.js";

const MODEL_NAME = "kev-latest";
const RESOLVE_TIMEOUT_MS = 300_000;
const MODELS_TIMEOUT_MS = 5_000;

/** The last criterion of every question; Kev normalises its probabilities over the classes and this. */
export const KEV_NONE_OPTION = "none of these — defined outside the project";

export interface KevChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, null>;
}

export interface KevResidualProviderOptions {
  urls: readonly string[];
  threshold: number;
  /** Per-request budget of `POST /v1/systemone`; default 300 s (`CODEGRAPH_RESIDUAL_REQUEST_TIMEOUT_SEC`). */
  resolveTimeoutMs?: number;
}

/** `fetch` is the seam a broker-session wrapper or a test replaces. */
export interface KevResidualProviderDeps {
  fetch?: typeof fetch;
}

interface SystemOneResponse {
  answers?: Record<string, { choice?: string; probabilities?: Record<string, number> }>;
}

interface ModelsResponse {
  models?: { run?: string }[];
}

/** Class part of a candidate method symbolId: `Firm#users` / `Firm.find` → `Firm`. */
export function candidateClass(symbolId: string): string {
  const hash = symbolId.lastIndexOf("#");
  const cut = hash > 0 ? hash : symbolId.lastIndexOf(".");
  return cut > 0 ? symbolId.slice(0, cut) : symbolId;
}

/** `members` — every call on the receiver, for a receiver-group question; absent, the one call on `member`. */
export function kevQuestion(
  receiverText: string,
  member: string,
  classes: readonly string[],
  members?: readonly string[],
): KevChoiceQuestion {
  const calls = members !== undefined && members.length > 1 ? members : [member];
  const named = calls.map((m) => `\`${receiverText}.${m}\``).join(", ");
  return {
    type: "choice",
    instructions:
      `In this Ruby method, \`${receiverText}\` is the receiver of the call${calls.length > 1 ? "s" : ""} ${named}. ` +
      `Which class is the object passed as \`${receiverText}\`?`,
    criteria: Object.fromEntries([...classes, KEV_NONE_OPTION].map((name) => [name, null])),
  };
}

/** The state of a request: the file path, then the method source as the pass built it. */
export function kevState(sourceRelPath: string, methodSource: string): string {
  return `# file: ${sourceRelPath}\n${methodSource}`;
}

/**
 * Every text Kev is asked in, rendered over placeholders — the state, a
 * one-call and a multi-call question with its none option. Built from the same
 * functions a request is, so any wording change changes it.
 */
export const KEV_PROMPT_TEMPLATE = JSON.stringify([
  kevState("{file}", "{source}"),
  kevQuestion("{receiver}", "{member}", ["{class}"]),
  kevQuestion("{receiver}", "{member}", ["{class}"], ["{member}", "{member2}"]),
]);

export class KevResidualProvider implements ResidualModelProvider {
  readonly id = "kev";
  readonly promptTemplate = KEV_PROMPT_TEMPLATE;
  readonly threshold: number;
  private readonly urls: readonly string[];
  private readonly fetchFn: typeof fetch;
  private readonly resolveTimeoutMs: number;
  private nextUrl = 0;

  constructor(options: KevResidualProviderOptions, deps: KevResidualProviderDeps = {}) {
    this.urls = options.urls.map((url) => url.replace(/\/+$/, ""));
    this.threshold = options.threshold;
    this.resolveTimeoutMs = options.resolveTimeoutMs ?? RESOLVE_TIMEOUT_MS;
    this.fetchFn = deps.fetch ?? (async (input, init) => fetch(input, init));
  }

  async version(): Promise<string> {
    const failures: string[] = [];
    for (const url of this.urls) {
      try {
        return await this.readRun(url);
      } catch (error) {
        failures.push(`${url}: ${errorMessage(error)}`);
      }
    }
    throw new KevUnavailableError(this.urls, new Error(failures.join("; ")));
  }

  async health(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const failures: string[] = [];
    for (const url of this.urls) {
      try {
        await this.readRun(url);
        return { ok: true };
      } catch (error) {
        failures.push(`${url}: ${errorMessage(error)}`);
      }
    }
    return { ok: false, reason: failures.join("; ") };
  }

  async resolveGroup(group: ResidualQuestionGroup, signal?: AbortSignal): Promise<ResidualAnswer[]> {
    const menus = group.questions.map((question) =>
      question.subject === "class"
        ? new Map(question.candidates.map((name) => [name, name]))
        : classMenu(question.candidates),
    );
    const questions = group.questions.map((question, i) =>
      kevQuestion(question.receiverText, question.member, [...menus[i].keys()], question.members),
    );
    const body = JSON.stringify({
      model: MODEL_NAME,
      state: kevState(group.sourceRelPath, group.methodSource),
      questions: Object.fromEntries(group.questions.map((question, i) => [question.siteKey, questions[i]])),
    });
    const { url, response } = await this.postAcrossUrls(body, signal);
    return group.questions.map((question, i) => toAnswer(url, question, menus[i], questions[i], response));
  }

  private async readRun(url: string): Promise<string> {
    const response = await this.fetchFn(`${url}/v1/models`, {
      method: "GET",
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    });
    if (!response.ok) throw new KevResponseError(url, `GET /v1/models answered HTTP ${response.status}`);
    const modelRun = ((await response.json()) as ModelsResponse).models?.[0]?.run;
    if (typeof modelRun !== "string" || modelRun.length === 0) {
      throw new KevResponseError(url, "/v1/models lists no model run");
    }
    return modelRun;
  }

  /**
   * Round-robin start, then every other URL once; 4xx (422 = state too long) and malformed bodies are not retried
   * elsewhere. The caller's `signal` cancels the whole ask; only a request every URL let time out is a timeout.
   */
  private async postAcrossUrls(
    body: string,
    signal: AbortSignal | undefined,
  ): Promise<{ url: string; response: SystemOneResponse }> {
    const start = this.nextUrl;
    this.nextUrl = (this.nextUrl + 1) % this.urls.length;
    let lastError: Error | undefined;
    let everyAttemptTimedOut = true;
    for (let attempt = 0; attempt < this.urls.length; attempt++) {
      const url = this.urls[(start + attempt) % this.urls.length];
      if (signal?.aborted) throw new KevRequestCancelledError(url, asError(signal.reason));
      const timeout = AbortSignal.timeout(this.resolveTimeoutMs);
      let response: Response;
      try {
        response = await this.fetchFn(`${url}/v1/systemone`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (error) {
        if (signal?.aborted) throw new KevRequestCancelledError(url, asError(error));
        lastError = asError(error);
        everyAttemptTimedOut &&= timeout.aborted;
        continue;
      }
      everyAttemptTimedOut = false;
      if (response.status >= 500) {
        lastError = new KevResponseError(url, `POST /v1/systemone answered HTTP ${response.status}`);
        continue;
      }
      if (response.status === 422) throw new KevStateTooLongError(url, await response.text());
      if (!response.ok) throw new KevResponseError(url, `HTTP ${response.status}: ${await response.text()}`);
      return { url, response: (await response.json()) as SystemOneResponse };
    }
    if (everyAttemptTimedOut) throw new KevTimeoutError(this.urls, this.resolveTimeoutMs, lastError);
    throw new KevUnavailableError(this.urls, lastError);
  }
}

/** Class → candidate symbolId; the first candidate wins a class shared by two. */
function classMenu(candidates: readonly string[]): Map<string, string> {
  const menu = new Map<string, string>();
  for (const symbolId of candidates) {
    const name = candidateClass(symbolId);
    if (!menu.has(name)) menu.set(name, symbolId);
  }
  return menu;
}

function toAnswer(
  url: string,
  question: ResidualQuestion,
  menu: Map<string, string>,
  payload: KevChoiceQuestion,
  response: SystemOneResponse,
): ResidualAnswer {
  const answer = response.answers?.[question.siteKey];
  const choice = answer?.choice;
  const pick = choice === KEV_NONE_OPTION ? null : choice === undefined ? undefined : menu.get(choice);
  if (choice === undefined || pick === undefined) {
    throw new KevResponseError(url, `site ${question.siteKey}: choice ${String(choice)} is not on the menu`);
  }
  const probabilities: Record<string, number> = {};
  for (const [name, p] of Object.entries(answer?.probabilities ?? {})) {
    const key = name === KEV_NONE_OPTION ? RESIDUAL_NONE_PROBABILITY_KEY : menu.get(name);
    if (key !== undefined) probabilities[key] = p;
  }
  return {
    siteKey: question.siteKey,
    pick,
    p: answer?.probabilities?.[choice] ?? 0,
    probabilities,
    questionPayload: JSON.stringify(payload),
  };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
