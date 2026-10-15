/**
 * Kev (`/v1/systemone`) as a residual-resolution model. One request per
 * enclosing method: `state` is the method source, one `choice` question per
 * call site, the menu is the candidates' classes. Kev caches the state as a
 * prefix, so the questions of one method cost one prefill.
 */

import type {
  ResidualAnswer,
  ResidualModelProvider,
  ResidualQuestion,
  ResidualQuestionGroup,
} from "../../contracts/types/codegraph-residual.js";
import { KevResponseError, KevUnavailableError } from "./errors.js";

const MODEL_NAME = "kev-latest";
const RESOLVE_TIMEOUT_MS = 120_000;
const MODELS_TIMEOUT_MS = 5_000;

export interface KevChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, null>;
}

export interface KevResidualProviderOptions {
  urls: readonly string[];
  threshold: number;
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

export function kevQuestion(receiverText: string, member: string, classes: readonly string[]): KevChoiceQuestion {
  return {
    type: "choice",
    instructions:
      `In this Ruby method, \`${receiverText}\` is the receiver of the call \`${receiverText}.${member}\`. ` +
      `Which class is the object passed as \`${receiverText}\`?`,
    criteria: Object.fromEntries(classes.map((name) => [name, null])),
  };
}

export class KevResidualProvider implements ResidualModelProvider {
  readonly id = "kev";
  readonly threshold: number;
  private readonly urls: readonly string[];
  private readonly fetchFn: typeof fetch;
  private nextUrl = 0;

  constructor(options: KevResidualProviderOptions, deps: KevResidualProviderDeps = {}) {
    this.urls = options.urls.map((url) => url.replace(/\/+$/, ""));
    this.threshold = options.threshold;
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

  async resolveGroup(group: ResidualQuestionGroup): Promise<ResidualAnswer[]> {
    const menus = group.questions.map((question) => classMenu(question.candidates));
    const questions = group.questions.map((question, i) =>
      kevQuestion(question.receiverText, question.member, [...menus[i].keys()]),
    );
    const body = JSON.stringify({
      model: MODEL_NAME,
      state: `# file: ${group.sourceRelPath}\n${group.methodSource}`,
      questions: Object.fromEntries(group.questions.map((question, i) => [question.siteKey, questions[i]])),
    });
    const { url, response } = await this.postAcrossUrls(body);
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

  /** Round-robin start, then every other URL once; 4xx and malformed bodies are not retried elsewhere. */
  private async postAcrossUrls(body: string): Promise<{ url: string; response: SystemOneResponse }> {
    const start = this.nextUrl;
    this.nextUrl = (this.nextUrl + 1) % this.urls.length;
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < this.urls.length; attempt++) {
      const url = this.urls[(start + attempt) % this.urls.length];
      let response: Response;
      try {
        response = await this.fetchFn(`${url}/v1/systemone`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
        });
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        continue;
      }
      if (response.status >= 500) {
        lastError = new KevResponseError(url, `POST /v1/systemone answered HTTP ${response.status}`);
        continue;
      }
      if (!response.ok) throw new KevResponseError(url, `HTTP ${response.status}: ${await response.text()}`);
      return { url, response: (await response.json()) as SystemOneResponse };
    }
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
  const pick = choice === undefined ? undefined : menu.get(choice);
  if (choice === undefined || pick === undefined) {
    throw new KevResponseError(url, `site ${question.siteKey}: choice ${String(choice)} is not on the menu`);
  }
  const probabilities: Record<string, number> = {};
  for (const [name, p] of Object.entries(answer?.probabilities ?? {})) {
    const symbolId = menu.get(name);
    if (symbolId !== undefined) probabilities[symbolId] = p;
  }
  return {
    siteKey: question.siteKey,
    pick,
    p: answer?.probabilities?.[choice] ?? 0,
    probabilities,
    questionPayload: JSON.stringify(payload),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
