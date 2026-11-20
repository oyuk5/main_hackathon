/**
 * The only place that calls a model. Owned by B.
 * Every call is logged to the ledger with tokens and cost, per portal and run,
 * so the README can state "what one portal costs in model usage" from real numbers.
 */
import OpenAI from "openai";
import { z, type ZodType } from "zod";
import { config } from "../platform/config.js";
import { store } from "../platform/store.js";
import { nowWithOffset } from "../shared/time.js";
import type { Llm, ModelTier } from "../shared/modules.js";

export const LLM_TIMEOUT_MS = 90_000;
export const LLM_MAX_RETRIES = 2;

let client: OpenAI | null = null;
function openai(): OpenAI {
  if (!config.llm.apiKey) throw new Error("OPENAI_API_KEY is not set");
  // A hung call must not keep a portal in "integrating" forever: 90 s per attempt, and the SDK retries
  // twice on connection errors, 408/409/429 and 5xx (with backoff). Failed calls are not billed.
  client ??= new OpenAI({ apiKey: config.llm.apiKey, baseURL: config.llm.baseUrl, timeout: LLM_TIMEOUT_MS, maxRetries: LLM_MAX_RETRIES });
  return client;
}

function modelFor(tier: ModelTier): string {
  const m = tier === "smart" ? config.llm.smartModel : config.llm.fastModel;
  if (!m) throw new Error(`MODEL_${tier.toUpperCase()} is not set`);
  return m;
}

export function llmFor(portalId: string | null, runId: string | null): Llm {
  return {
    async json<T>({ purpose, model, system, user, schema }: { purpose: string; model: ModelTier; system: string; user: string; schema: ZodType<T> }) {
      const name = modelFor(model);
      const res = await openai().chat.completions.create({
        model: name,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "answer", strict: false, schema: z.toJSONSchema(schema) as Record<string, unknown> },
        },
      });
      const inTok = res.usage?.prompt_tokens ?? 0;
      const outTok = res.usage?.completion_tokens ?? 0;
      const cost = (inTok * config.llm.priceInPerMTok[model] + outTok * config.llm.priceOutPerMTok[model]) / 1e6;
      store.addLlmCall({ portalId, runId, purpose, model: name, inputTokens: inTok, outputTokens: outTok, costUsd: cost, at: nowWithOffset() });
      const text = res.choices[0]?.message?.content ?? "";
      return schema.parse(JSON.parse(text));
    },
  };
}
