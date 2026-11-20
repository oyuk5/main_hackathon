/**
 * MODULE BOUNDARIES. Freeze in the first hour; change only with the owners involved.
 *
 *   platform (A)  owns: server, store, orchestrator, polite HTTP/browser, documents, files
 *   attach   (B)  owns: Recipe, Extractor, Cartographer, families, normalization, LLM client
 *   watch    (C)  owns: checks, blocker detection, Medic, Verifier, state decision
 *   web/lab  (D)  owns: dashboard, test portals, chaos lab, eval
 *
 * The orchestrator (A) only talks to attach and watch through these interfaces.
 */
import type { Page } from "playwright";
import type { ZodType } from "zod";
import type { Recipe } from "./recipe.js";
import type { TenderDocument, Tender } from "./contract.js";

// ------------------------------------------------------------ shared context

/** Everything a module may use to touch the outside world. Always use these, never raw fetch. */
export interface PortalContext {
  portalId: string;
  /** The address the operator gave us. */
  url: string;
  /** At most 1 request per second to this portal. Honors robots.txt. */
  http: PoliteHttp;
  /** Headless Chromium whose requests to the portal go through the same 1 rps limiter. */
  browser: PoliteBrowser;
  llm: Llm;
  /** Writes to the run log the dashboard shows. One short, plain sentence per call. */
  log: (message: string, level?: "info" | "warn" | "error") => void;
  /** Aborted when the portal is deleted or the run is cancelled. Check it in loops. */
  signal: AbortSignal;
}

export interface PoliteHttp {
  fetch(url: string, init?: RequestInit & { maxBytes?: number }): Promise<Response>;
}

export interface PoliteBrowser {
  /** Opens a fresh page (images, fonts and media blocked), runs fn, always closes the page. */
  withPage<T>(fn: (page: Page) => Promise<T>): Promise<T>;
}

export type ModelTier = "smart" | "fast";

export interface Llm {
  /** One structured call. Logs model, tokens and cost to the ledger under `purpose`. */
  json<T>(opts: {
    purpose: "attach" | "repair" | "triage" | "check";
    model: ModelTier;
    system: string;
    user: string;
    schema: ZodType<T>;
  }): Promise<T>;
}

// ------------------------------------------------------------ extraction (B)

/** Where a document can be fetched. Produced by the Extractor, consumed by DocumentFetcher. */
export interface DocumentRef {
  url: string;
  fileNameHint?: string;
  /** "browser" when the download needs a click or JavaScript. */
  via: "http" | "browser";
  method?: "GET" | "POST";
  form?: Record<string, string>;
  /** For multi-step downloads in the browser: selectors to click in order on `url`. */
  clickPath?: string[];
}

/** A tender as read from the portal, normalized, before documents are downloaded. */
export type ExtractedTender = Omit<Tender, "documents" | "lastChangedAt" | "status"> & {
  /** Set when the portal says the tender was cancelled. Otherwise status is derived. */
  withdrawn?: boolean;
  documentRefs: DocumentRef[];
};

export interface FieldFill {
  filled: number;
  total: number;
}

export interface ReadDiagnostics {
  requests: number;
  listPages: number;
  itemsSeen: number;
  fieldFill: Record<string, FieldFill>;
  /** sha256 of a structural skeleton of the list page, for drift detection. */
  listSkeletonHash?: string;
  /** Text from the page that said "no results", if any. */
  emptyStateText?: string;
  durationMs: number;
}

export type ReadOutcome =
  | { kind: "ok"; tenders: ExtractedTender[]; diagnostics: ReadDiagnostics }
  | { kind: "blocked"; reason: string } // login or captcha in the way
  | { kind: "unreachable"; reason: string; httpStatus?: number }
  | { kind: "error"; reason: string; diagnostics?: Partial<ReadDiagnostics> };

export interface Extractor {
  /** Deterministic. MUST NOT call the LLM. */
  read(recipe: Recipe, ctx: PortalContext): Promise<ReadOutcome>;
}

/** Known values used to prove a recipe still reads correctly. */
export interface GoldenRecord {
  id: string;
  fields: Partial<Pick<ExtractedTender, "title" | "buyerName" | "publicationDate" | "submissionDeadline" | "referenceNumber" | "url">>;
}

export type AttachOutcome =
  | { kind: "ok"; recipe: Recipe; golden: GoldenRecord[]; read: Extract<ReadOutcome, { kind: "ok" }>; note: string }
  | { kind: "blocked"; reason: string }
  | { kind: "failed"; reason: string };

export interface Cartographer {
  /** Learns how to read a never-seen portal. May use the LLM. */
  attach(ctx: PortalContext): Promise<AttachOutcome>;
}

// ------------------------------------------------------------ watching (C)

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface Baseline {
  lastGoodCount: number | null;
  lastGoodFieldFill: Record<string, FieldFill> | null;
  lastGoodSkeletonHash: string | null;
  golden: GoldenRecord[];
}

export type Verdict =
  | { kind: "healthy"; reason: string; checks: CheckResult[] }
  | { kind: "broken"; reason: string; checks: CheckResult[] } // start a repair
  | { kind: "blocked"; reason: string } // failed: login/captcha
  | { kind: "unreachable"; reason: string }; // transient: retry later

export interface Watch {
  /** Deterministic. Decides whether a read is correct enough to serve. */
  evaluate(read: ReadOutcome, baseline: Baseline): Verdict;
}

export type RepairOutcome =
  | { kind: "ok"; recipe: Recipe; read: Extract<ReadOutcome, { kind: "ok" }>; summary: string }
  | { kind: "failed"; reason: string };

export interface Medic {
  /** Repairs a broken recipe. May use the LLM. Must verify before returning ok. */
  repair(input: { recipe: Recipe; verdict: Verdict; baseline: Baseline }, ctx: PortalContext): Promise<RepairOutcome>;
}

// ------------------------------------------------------------ documents (A)

export interface DocumentFetcher {
  /** Downloads, unpacks ZIPs, hashes, stores. Skips files over 250 MB. Never throws for one bad file. */
  fetchAll(refs: DocumentRef[], ctx: PortalContext): Promise<{ documents: TenderDocument[]; problems: string[] }>;
}
