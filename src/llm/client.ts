/**
 * The only place that calls a model. Owned by B.
 * Every call is logged to the ledger with tokens and cost, per portal and run,
 * so the README can state "what one portal costs in model usage" from real numbers.
 *
 * Prompt caching (OpenAI chat.completions): prefixes of 1024+ tokens are cached; a hit shows up as
 * `usage.prompt_tokens_details.cached_tokens` and is billed at a discount. Newer models cache at
 * breakpoints (see buildRequest), and only an identical prefix is reused, so callers put what stays the
 * same first (system prompt, then the page view) and append what changes. `prompt_cache_key` routes
 * requests with the same key to the same cache machine; we key on purpose and portal. Caches are per
 * model, so a fast draft does not reuse a smart draft's prefix. LLM_PROMPT_CACHE=0 sends plain requests;
 * a provider that rejects the caching fields with a 400 turns them off by itself.
 */
import OpenAI from "openai";
import { z, type ZodType } from "zod";
import { config } from "../platform/config.js";
import { store } from "../platform/store.js";
import { modelBudget } from "../platform/budget.js";
import { nowWithOffset } from "../shared/time.js";
import type { Llm, ModelTier } from "../shared/modules.js";

export const LLM_TIMEOUT_MS = 90_000;
export const LLM_MAX_RETRIES = 0;
/** 429 rate-limit answers are retried this many times, waiting Retry-After or an exponential backoff. */
export const LLM_RATE_LIMIT_RETRIES = 5;
/** Request timeouts are retried this many times with the same exponential backoff. */
export const LLM_TIMEOUT_RETRIES = 2;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;

/** The SDK's request timeout (APIConnectionTimeoutError): the provider was slow, a later try may answer. */
export function isTimeout(e: unknown): boolean {
  return e instanceof OpenAI.APIConnectionTimeoutError;
}

/** A 429 the provider may lift by waiting: not an exhausted quota, which no wait fixes. */
export function isRetryableRateLimit(e: unknown): boolean {
  const err = e as { status?: number; code?: string | null; error?: { code?: string | null } } | null;
  if (!err || err.status !== 429) return false;
  const code = err.code ?? err.error?.code ?? null;
  return code !== "insufficient_quota";
}

/** How long to wait before retry `attempt` (0-based): the provider's Retry-After when given, else 2 s, 4 s, 8 s ... with jitter. */
export function rateLimitDelayMs(e: unknown, attempt: number, random: () => number = Math.random): number {
  const headers = (e as { headers?: unknown } | null)?.headers;
  const get = (name: string): string | null => {
    if (!headers) return null;
    if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name);
    const v = (headers as Record<string, unknown>)[name];
    return typeof v === "string" ? v : null;
  };
  const ms = Number(get("retry-after-ms"));
  if (Number.isFinite(ms) && ms > 0) return Math.min(ms, BACKOFF_MAX_MS);
  const after = get("retry-after");
  if (after) {
    const secs = Number(after);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, BACKOFF_MAX_MS);
    const at = Date.parse(after);
    if (Number.isFinite(at)) return Math.min(Math.max(0, at - Date.now()), BACKOFF_MAX_MS);
  }
  const base = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
  return Math.round(base * (0.75 + random() * 0.5));
}
const MAX_COMPLETION_TOKENS = 12_000;
const reserveModelSpend = modelBudget();

let client: OpenAI | null = null;
function openai(): OpenAI {
  if (!config.llm.apiKey) throw new Error("OPENAI_API_KEY is not set");
  // Disable automatic provider retries so each submitted request passes the budget gate.
  client ??= new OpenAI({ apiKey: config.llm.apiKey, baseURL: config.llm.baseUrl, timeout: LLM_TIMEOUT_MS, maxRetries: LLM_MAX_RETRIES });
  return client;
}

function modelFor(tier: ModelTier): string {
  const m = tier === "smart" ? config.llm.smartModel : config.llm.fastModel;
  if (!m) throw new Error(`MODEL_${tier.toUpperCase()} is not set`);
  return m;
}

const envNum = (v: string | undefined): number | null => (v && !Number.isNaN(Number(v)) ? Number(v) : null);

export interface Prices {
  /** USD per million uncached input tokens. */
  in: number;
  /** USD per million cached input tokens. */
  cachedIn: number;
  /** USD per million output tokens. */
  out: number;
}

/**
 * Prices for one tier. Cached input comes from PRICE_SMART_CACHED_IN / PRICE_FAST_CACHED_IN; when unset
 * it defaults to half the normal input price. That is a conservative guess: OpenAI bills cached input at
 * 50 % for older models and at 10-25 % for newer ones, so set the env var from the provider's price page.
 */
export function pricesFor(tier: ModelTier, env: NodeJS.ProcessEnv = process.env): Prices {
  const inPrice = config.llm.priceInPerMTok[tier];
  const cached = envNum(tier === "smart" ? env.PRICE_SMART_CACHED_IN : env.PRICE_FAST_CACHED_IN);
  return { in: inPrice, cachedIn: cached ?? inPrice / 2, out: config.llm.priceOutPerMTok[tier] };
}

/** The usage fields we read; `prompt_tokens` includes the cached ones. */
export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number | null } | null;
}

export interface CallCost {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** Cost of one call: uncached input at the input price, cached input at the cached price, output at the output price. */
export function costOf(usage: Usage | null | undefined, p: Prices): CallCost {
  const inputTokens = usage?.prompt_tokens ?? 0;
  const outputTokens = usage?.completion_tokens ?? 0;
  // Never more cached than sent, whatever a provider reports.
  const cachedTokens = Math.min(Math.max(usage?.prompt_tokens_details?.cached_tokens ?? 0, 0), inputTokens);
  const costUsd = ((inputTokens - cachedTokens) * p.in + cachedTokens * p.cachedIn + outputTokens * p.out) / 1e6;
  return { inputTokens, cachedTokens, outputTokens, costUsd };
}

/** Cache key for one portal and purpose; null without a portal (the provider then caches by prefix alone). */
export function cacheKeyFor(purpose: string, portalId: string | null): string | null {
  return portalId ? `watchtower:${purpose}:${portalId}` : null;
}

/** Where callers separate the stable start of a user message from feedback appended later (the Cartographer does). */
export const PART_SEPARATOR = "\n\n---\n\n";

type Body = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
const BREAKPOINT = { mode: "explicit" } as const;

/**
 * The request, laid out for the prompt cache. Newer models cache at breakpoints: one implicit breakpoint
 * at the end of the request, plus explicit ones on content parts. A later request reuses a cached prefix
 * only up to a breakpoint an earlier request wrote, so the end of the system prompt and the end of every
 * part of the user message but the last get one. The user message is split at PART_SEPARATOR with the
 * separator kept at the start of the next part, so the model reads exactly the same text, and the prefix
 * up to the end of draft n's message is identical in draft n+1, which only appends.
 */
export function buildRequest(o: { model: string; system: string; user: string; jsonSchema: Record<string, unknown>; cacheKey: string | null; caching: boolean }): Body {
  const response_format = { type: "json_schema", json_schema: { name: "answer", strict: false, schema: o.jsonSchema } } as const;
  if (!o.caching) {
    return { model: o.model, messages: [{ role: "system", content: o.system }, { role: "user", content: o.user }], response_format };
  }
  const pieces = o.user.split(PART_SEPARATOR).map((t, i) => (i === 0 ? t : PART_SEPARATOR + t));
  const userParts = pieces.map((text, i) => (i < pieces.length - 1 ? { type: "text" as const, text, prompt_cache_breakpoint: BREAKPOINT } : { type: "text" as const, text }));
  return {
    model: o.model,
    messages: [
      { role: "system", content: [{ type: "text", text: o.system, prompt_cache_breakpoint: BREAKPOINT }] },
      { role: "user", content: userParts },
    ],
    response_format,
    ...(o.cacheKey ? { prompt_cache_key: o.cacheKey } : {}),
  };
}

/** A 400 that names the caching fields: the provider or model does not take them. */
function cachingRejected(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  return status === 400 && e instanceof Error && /prompt_cache/i.test(e.message);
}

/** Set once the provider refused the caching fields; later calls send the plain request. */
let cachingOff = process.env.LLM_PROMPT_CACHE === "0";

/** Seams for tests: the chat client and the ledger. */
export interface LlmDeps {
  create: (body: Body) => Promise<{ usage?: Usage | null; choices: { message?: { content?: string | null } }[] }>;
  addLlmCall: typeof store.addLlmCall;
  /** Waits between 429 retries; tests pass a fake. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultDeps: LlmDeps = {
  create: (body) => openai().chat.completions.create(body),
  addLlmCall: (c) => store.addLlmCall(c),
};

export function llmFor(portalId: string | null, runId: string | null, deps: LlmDeps = defaultDeps): Llm {
  return {
    async json<T>({ purpose, model, system, user, schema }: { purpose: string; model: ModelTier; system: string; user: string; schema: ZodType<T> }) {
      const name = modelFor(model);
      const pricing = pricesFor(model);
      const req = (caching: boolean) =>
        buildRequest({ model: name, system, user, jsonSchema: z.toJSONSchema(schema) as Record<string, unknown>, cacheKey: cacheKeyFor(purpose, portalId), caching });
      let res: Awaited<ReturnType<LlmDeps["create"]>>;
      const create = async (body: Body) => {
        const now = nowWithOffset();
        const day = now.slice(0, 10);
        const inputAllowance = Buffer.byteLength(JSON.stringify(body), "utf8") + 1024;
        const allowance = (inputAllowance * Math.max(pricing.in, pricing.cachedIn) + MAX_COMPLETION_TOKENS * pricing.out) / 1e6;
        const release = deps === defaultDeps ? reserveModelSpend(portalId, day, allowance, store.modelSpend(portalId, day), {
          portal: config.llm.maxPortalUsd, day: config.llm.maxDayUsd,
        }) : () => {};
        try {
          const result = await deps.create({ ...body, max_completion_tokens: MAX_COMPLETION_TOKENS });
          const c = costOf(result.usage, pricing);
          deps.addLlmCall({ portalId, runId, purpose, model: name, inputTokens: c.inputTokens, cachedTokens: c.cachedTokens, outputTokens: c.outputTokens, costUsd: c.costUsd, at: now });
          return result;
        } finally { release(); }
      };
      // Many portals attach at once and share one key: a 429 waits and retries instead of failing the portal.
      const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      const createWithRetry = async (body: Body) => {
        let timeouts = 0;
        for (let attempt = 0; ; attempt++) {
          try {
            return await create(body);
          } catch (e) {
            if (isTimeout(e)) {
              if (timeouts >= LLM_TIMEOUT_RETRIES) throw e;
              await sleep(rateLimitDelayMs(null, timeouts++));
              continue;
            }
            if (!isRetryableRateLimit(e) || attempt >= LLM_RATE_LIMIT_RETRIES) throw e;
            await sleep(rateLimitDelayMs(e, attempt));
          }
        }
      };
      if (cachingOff) res = await createWithRetry(req(false));
      else {
        try {
          res = await createWithRetry(req(true));
        } catch (e) {
          if (!cachingRejected(e)) throw e;
          cachingOff = true;
          res = await createWithRetry(req(false));
        }
      }
      const text = res.choices[0]?.message?.content ?? "";
      return schema.parse(JSON.parse(text));
    },
  };
}

/** For tests: turn caching back on after a test made the provider "refuse" it. */
export function resetCachingForTests(on = true): void {
  cachingOff = !on;
}
