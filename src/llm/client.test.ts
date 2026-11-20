import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { config } from "../platform/config.js";
import { buildRequest, cacheKeyFor, costOf, llmFor, PART_SEPARATOR, pricesFor, resetCachingForTests, type LlmDeps, type Usage } from "./client.js";

// Prices as in docs/DECISIONS.md: smart 2/10, fast 0.10/0.50 USD per million tokens.
// config is read-only by type; tests set it through a writable view.
const llm = config.llm as unknown as { priceInPerMTok: Record<string, number>; priceOutPerMTok: Record<string, number>; smartModel: string; fastModel: string };
Object.assign(llm.priceInPerMTok, { smart: 2, fast: 0.1 });
Object.assign(llm.priceOutPerMTok, { smart: 10, fast: 0.5 });
Object.assign(llm, { smartModel: "smart-model", fastModel: "fast-model" });

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);

test("cached input defaults to half the input price, or the env value", () => {
  assert.deepEqual(pricesFor("smart", {}), { in: 2, cachedIn: 1, out: 10 });
  assert.deepEqual(pricesFor("smart", { PRICE_SMART_CACHED_IN: "0.2" }), { in: 2, cachedIn: 0.2, out: 10 });
  assert.equal(pricesFor("fast", { PRICE_FAST_CACHED_IN: "0.01" }).cachedIn, 0.01);
  assert.equal(pricesFor("fast", { PRICE_FAST_CACHED_IN: "abc" }).cachedIn, 0.05);
});

test("cost without cached tokens is unchanged", () => {
  const p = { in: 2, cachedIn: 0.2, out: 10 };
  const c = costOf({ prompt_tokens: 10_000, completion_tokens: 500 }, p);
  assert.equal(c.cachedTokens, 0);
  close(c.costUsd, (10_000 * 2 + 500 * 10) / 1e6);
  close(costOf({ prompt_tokens: 10_000, completion_tokens: 500, prompt_tokens_details: null }, p).costUsd, c.costUsd);
  close(costOf({ prompt_tokens: 10_000, completion_tokens: 500, prompt_tokens_details: {} }, p).costUsd, c.costUsd);
  assert.equal(costOf(undefined, p).costUsd, 0);
});

test("cached tokens are billed at the cached price", () => {
  const c = costOf({ prompt_tokens: 10_000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 8_192 } }, { in: 2, cachedIn: 0.2, out: 10 });
  assert.equal(c.inputTokens, 10_000);
  assert.equal(c.cachedTokens, 8_192);
  close(c.costUsd, (1_808 * 2 + 8_192 * 0.2 + 500 * 10) / 1e6);
  // A provider reporting more cached than sent never makes the cost negative.
  assert.equal(costOf({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 500 } }, { in: 2, cachedIn: 0.2, out: 10 }).cachedTokens, 100);
});

function fakeDeps(usage: Usage) {
  const bodies: Record<string, unknown>[] = [];
  const calls: Parameters<LlmDeps["addLlmCall"]>[0][] = [];
  const deps: LlmDeps = {
    create: async (body) => {
      bodies.push(body as unknown as Record<string, unknown>);
      return { usage, choices: [{ message: { content: '{"ok":true}' } }] };
    },
    addLlmCall: (c) => void calls.push(c),
  };
  return { deps, bodies, calls };
}

test("the portal's cache key is passed and the ledger gets the discounted cost", async () => {
  const { deps, bodies, calls } = fakeDeps({ prompt_tokens: 2_000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 1_024 } });
  const out = await llmFor("p1", "r1", deps).json({ purpose: "attach", model: "smart", system: "S", user: "U", schema: z.object({ ok: z.boolean() }) });
  assert.deepEqual(out, { ok: true });
  assert.equal(bodies[0]!.prompt_cache_key, cacheKeyFor("attach", "p1"));
  assert.equal(bodies[0]!.model, "smart-model");
  assert.deepEqual((bodies[0]!.messages as { role: string }[]).map((m) => m.role), ["system", "user"]);
  assert.ok(bodies[0]!.response_format);
  const p = pricesFor("smart");
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0]!).sort(), ["at", "costUsd", "inputTokens", "model", "outputTokens", "portalId", "purpose", "runId"]);
  assert.equal(calls[0]!.inputTokens, 2_000);
  assert.equal(calls[0]!.outputTokens, 100);
  close(calls[0]!.costUsd, (976 * p.in + 1_024 * p.cachedIn + 100 * p.out) / 1e6);
});

test("no portal means no cache key; usage without cached details costs as before", async () => {
  const { deps, bodies, calls } = fakeDeps({ prompt_tokens: 1_000, completion_tokens: 10 });
  await llmFor(null, null, deps).json({ purpose: "check", model: "fast", system: "S", user: "U", schema: z.object({ ok: z.boolean() }) });
  assert.equal("prompt_cache_key" in bodies[0]!, false);
  close(calls[0]!.costUsd, (1_000 * 0.1 + 10 * 0.5) / 1e6);
});

type Part = { type: string; text: string; prompt_cache_breakpoint?: unknown };
const textOf = (c: unknown) => (typeof c === "string" ? c : (c as Part[]).map((p) => p.text).join(""));

test("the request keeps the exact text and marks breakpoints at the stable boundaries", () => {
  const user = ["PAGE VIEW", "Round 1 feedback", "Round 2 feedback"].join(PART_SEPARATOR);
  const body = buildRequest({ model: "m", system: "SYS", user, jsonSchema: {}, cacheKey: "k", caching: true });
  const [sys, usr] = body.messages as { role: string; content: unknown }[];
  assert.equal(textOf(sys!.content), "SYS");
  assert.equal(textOf(usr!.content), user);
  const parts = usr!.content as Part[];
  assert.deepEqual(parts.map((p) => Boolean(p.prompt_cache_breakpoint)), [true, true, false]);
  assert.ok((sys!.content as Part[])[0]!.prompt_cache_breakpoint);
  // The next draft only appends: its prefix up to the old message's end is identical.
  const next = buildRequest({ model: "m", system: "SYS", user: user + PART_SEPARATOR + "Round 3", jsonSchema: {}, cacheKey: "k", caching: true });
  const nextParts = (next.messages[1] as { content: Part[] }).content;
  assert.deepEqual(nextParts.slice(0, 3).map((p) => p.text), parts.map((p) => p.text));
  assert.equal(body.prompt_cache_key, "k");
  const plain = buildRequest({ model: "m", system: "SYS", user, jsonSchema: {}, cacheKey: "k", caching: false });
  assert.equal((plain.messages[1] as { content: unknown }).content, user);
  assert.equal("prompt_cache_key" in plain, false);
});

test("a provider that rejects the caching fields gets the plain request, then and afterwards", async () => {
  const bodies: Record<string, unknown>[] = [];
  const deps: LlmDeps = {
    create: async (body) => {
      bodies.push(body as unknown as Record<string, unknown>);
      if ("prompt_cache_key" in body) throw Object.assign(new Error("400 Unrecognized request argument supplied: prompt_cache_key"), { status: 400 });
      return { usage: { prompt_tokens: 10, completion_tokens: 1 }, choices: [{ message: { content: '{"ok":true}' } }] };
    },
    addLlmCall: () => {},
  };
  const schema = z.object({ ok: z.boolean() });
  try {
    assert.deepEqual(await llmFor("p", null, deps).json({ purpose: "attach", model: "smart", system: "S", user: "U", schema }), { ok: true });
    await llmFor("p", null, deps).json({ purpose: "attach", model: "smart", system: "S", user: "U", schema });
    assert.deepEqual(bodies.map((b) => "prompt_cache_key" in b), [true, false, false]);
  } finally {
    resetCachingForTests();
  }
});

test("other errors are not retried", async () => {
  let n = 0;
  const deps: LlmDeps = {
    create: async () => {
      n += 1;
      throw Object.assign(new Error("400 invalid schema"), { status: 400 });
    },
    addLlmCall: () => {},
  };
  await assert.rejects(llmFor("p", null, deps).json({ purpose: "attach", model: "smart", system: "S", user: "U", schema: z.object({}) }));
  assert.equal(n, 1);
});
