/** All runtime settings. Every env var here must also be listed in README.md. */
import path from "node:path";

const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);

export const config = {
  port: num(process.env.PORT, 8080),
  dataDir: path.resolve(process.env.DATA_DIR ?? "./data"),
  /** How often a serving portal is read again on its own. */
  readIntervalMinutes: num(process.env.READ_INTERVAL_MINUTES, 30),
  /** How often a failed portal is probed again (it recovers by itself if the portal comes back). */
  failedRetryMinutes: num(process.env.FAILED_RETRY_MINUTES, 30),
  /** Document refs fetched per read at most; the rest follow in the next reads (see budget.ts). */
  docRefsPerRead: Math.max(1, num(process.env.DOC_REFS_PER_READ, 300)),
  /** While documents are pending, the next read follows this soon instead of the normal interval. */
  pendingReadMinutes: 1,
  /** Minimum gap between two requests to one host. The brief allows at most 1 per second. */
  minRequestGapMs: Math.max(1000, num(process.env.MIN_REQUEST_GAP_MS, 1100)),
  /** Files bigger than this are left out (brief: may leave out files over 250 MB). */
  maxFileBytes: num(process.env.MAX_FILE_BYTES, 250 * 1024 * 1024),
  userAgent: process.env.USER_AGENT ?? "WatchtowerBot/0.1 (+tender monitoring; polite, 1 req/s)",
  llm: {
    apiKey: process.env.OPENAI_API_KEY ?? "",
    baseUrl: process.env.OPENAI_BASE_URL || undefined,
    smartModel: process.env.MODEL_SMART ?? "",
    fastModel: process.env.MODEL_FAST ?? "",
    /** USD per million tokens, for the cost ledger. Set from the provider's price page. */
    priceInPerMTok: { smart: num(process.env.PRICE_SMART_IN, 0), fast: num(process.env.PRICE_FAST_IN, 0) },
    priceOutPerMTok: { smart: num(process.env.PRICE_SMART_OUT, 0), fast: num(process.env.PRICE_FAST_OUT, 0) },
  },
} as const;
