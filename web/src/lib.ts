/** Data from the Watchtower API, polling, and the small formatters the screens share. */
import { useCallback, useEffect, useRef, useState } from "react";
import { fmtInt, getLang, locale, t } from "./i18n";


export type State = "integrating" | "serving" | "healing" | "failed";

export interface RecentRun {
  kind: "read" | "repair";
  result: "ok" | "failed" | null;
  startedAt: string;
  finishedAt: string | null;
  summary?: string;
}

export interface PortalRow {
  id: string;
  url: string;
  state: State;
  reason: string;
  tenderCount: number;
  openCount: number;
  lastSuccessAt: string | null;
  busy: { runId: string; kind: string } | null;
  recipeVersion: number;
  tier: string | null;
  family: string | null;
  costUsd: number;
  country?: string | null;
  recent?: RecentRun[];
}

export interface RunRow {
  id: string;
  kind: "read" | "repair";
  started_at: string;
  finished_at: string | null;
  result: "ok" | "failed" | null;
  summary: string;
}

export interface LedgerRow {
  purpose: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface PortalDetail {
  portal: Omit<PortalRow, "busy" | "recipeVersion" | "tier" | "family" | "costUsd" | "recent" | "country" | "openCount">;
  runs: RunRow[];
  events: { run_id: string | null; at: string; level: string; message: string }[];
  recipes: { version: number; created_at: string; origin: string; note: string; json: unknown }[];
  ledger: LedgerRow[];
  runCosts?: Record<string, number>;
  busy?: { runId: string; kind: string } | null;
}

/** Polls a JSON endpoint. Keeps the last good answer when a poll fails. */
export function usePoll<T>(url: string | null, everyMs = 3000) {
  const [data, setData] = useState<T | null>(null);
  const [failing, setFailing] = useState(false);
  const urlRef = useRef(url);
  urlRef.current = url;

  const load = useCallback(async () => {
    const u = urlRef.current;
    if (!u) return;
    try {
      const res = await fetch(u, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as T;
      if (urlRef.current === u) {
        setData(body);
        setFailing(false);
      }
    } catch {
      if (urlRef.current === u) setFailing(true);
    }
  }, []);

  useEffect(() => {
    setData(null);
    if (!url) return;
    void load();
    const t = setInterval(load, everyMs);
    return () => clearInterval(t);
  }, [url, everyMs, load]);

  return { data, failing, reload: load };
}

/** Re-renders every 30 s so "3 min ago" stays true between polls. */
export function useNow(everyMs = 30_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

// ------------------------------------------------------------ formatting

/** Formatters per language; the 24-hour clock in both. */
const fmts = new Map<string, { clock: Intl.DateTimeFormat; day: Intl.DateTimeFormat; date: Intl.DateTimeFormat }>();
export function dateFormats() {
  const lang = getLang();
  let f = fmts.get(lang);
  if (!f) {
    const loc = locale();
    f = {
      clock: new Intl.DateTimeFormat(loc, { hour: "2-digit", minute: "2-digit", hour12: false }),
      day: new Intl.DateTimeFormat(loc, { weekday: "short" }),
      date: new Intl.DateTimeFormat(loc, { day: "numeric", month: "short" }),
    };
    fmts.set(lang, f);
  }
  return f;
}

export const clock = (iso: string) => dateFormats().clock.format(new Date(iso));

export function ago(iso: string, now: number): string {
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (s < 45) return t("ago.now");
  const m = Math.round(s / 60);
  if (m < 60) return t("ago.min", { n: m });
  const h = Math.round(m / 60);
  if (h < 24) return t("ago.h", { n: h });
  const d = Math.round(h / 24);
  return d === 1 ? t("ago.yesterday") : t("ago.days", { n: d });
}

/** "10:42, 3 min ago" today; "Tue 22:10" this week; "18 Nov, 09:00" before. */
export function when(iso: string, now: number): string {
  const t = new Date(iso);
  const days = (now - t.getTime()) / 86_400_000;
  const sameDay = new Date(now).toDateString() === t.toDateString();
  if (sameDay) return `${clock(iso)}, ${ago(iso, now)}`;
  if (days < 6) return `${dateFormats().day.format(t)} ${clock(iso)}`;
  return `${dateFormats().date.format(t)}, ${clock(iso)}`;
}

export function duration(fromIso: string, toIso: string | null): string {
  if (!toIso) return "";
  const s = Math.max(0, Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 1000));
  return s < 90 ? t("dur.s", { n: s }) : t("dur.min", { n: Math.round(s / 60) });
}

/** Dollars with as many decimals as small amounts need: "$0.004" in English, "0,004 $" in German. */
export function usd(n: number, digits = n === 0 ? 0 : n < 0.01 ? 4 : n < 1 ? 3 : 2): string {
  if (getLang() === "de") return `${n.toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits })} $`;
  return `$${n.toFixed(digits)}`;
}
export const int = fmtInt;
export const plural = (n: number, one: string, many = `${one}s`) => `${int(n)} ${n === 1 ? one : many}`;

export function host(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/$/, "");
    // Demo portals from the lab run on localhost; show their name, not the port.
    if (/^(localhost|127\.0\.0\.1)$/.test(u.hostname) && path) return `${path.split("/").pop()} (lab)`;
    return u.host.replace(/^www\./, "") + (path && path !== "/" ? path : "");
  } catch {
    return url;
  }
}

export const STATE_ORDER: Record<State, number> = { failed: 0, healing: 1, integrating: 2, serving: 3 };
/** State words in the current language. Getters, so every read follows the language switch. */
export const STATE_LABEL: Record<State, string> = {
  get serving() { return t("state.serving"); },
  get healing() { return t("state.healing"); },
  get integrating() { return t("state.integrating"); },
  get failed() { return t("state.failed"); },
};
/** State words inside a sentence ("3 need a person"). */
export const stateLower = (s: State) => t(`stateLower.${s}`);
export const STATE_COLOR: Record<State, string> = {
  serving: "text-serving",
  healing: "text-healing-text",
  integrating: "text-integrating",
  failed: "text-failed",
};

// ------------------------------------------------------------ recipe diff

type Flat = Map<string, string>;
function flatten(v: unknown, prefix = "", out: Flat = new Map()): Flat {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) flatten(x, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out.set(prefix, JSON.stringify(v));
  }
  return out;
}

export interface Change {
  path: string;
  before: string | null;
  after: string | null;
}

/** What a repair changed in the recipe, as a list of field paths with old and new values. */
export function diffRecipes(before: unknown, after: unknown): Change[] {
  const a = flatten(before);
  const b = flatten(after);
  const paths = [...new Set([...a.keys(), ...b.keys()])].sort();
  return paths.filter((p) => a.get(p) !== b.get(p)).map((p) => ({ path: p, before: a.get(p) ?? null, after: b.get(p) ?? null }));
}

// ------------------------------------------------------------ chart

/** The light characteristic that stands for each state, as printed on nautical charts. */
export const CHARACTER: Record<State, { code: string; words: string; cls: string }> = {
  serving: { code: "F.G", get words() { return t("state.serving"); }, cls: "ch-serving" },
  healing: { code: "Fl.Y 3s", get words() { return t("state.healing"); }, cls: "ch-healing" },
  failed: { code: "Q.R", get words() { return t("state.failed"); }, cls: "ch-failed" },
  integrating: { code: "Iso 2s", get words() { return t("state.integrating"); }, cls: "ch-integrating" },
};

/** A point inside each country where its lights are anchored, [longitude, latitude]. */
export const ANCHOR: Record<string, [number, number]> = {
  AT: [14.6, 47.6], BE: [4.6, 50.6], BG: [25.3, 42.7], HR: [16.0, 45.6], CY: [33.2, 35.0], CZ: [15.3, 49.8], DK: [9.2, 56.1],
  EE: [25.6, 58.7], FI: [26.0, 62.6], FR: [2.4, 46.7], DE: [10.3, 51.2], GR: [22.2, 39.4], HU: [19.4, 47.2], IE: [-8.0, 53.3],
  IT: [12.6, 42.9], LV: [24.9, 56.9], LT: [23.9, 55.3], LU: [6.1, 49.7], MT: [14.4, 35.9], NL: [5.6, 52.3], PL: [19.3, 52.1],
  PT: [-8.1, 39.7], RO: [24.9, 45.9], SK: [19.5, 48.7], SI: [14.8, 46.1], ES: [-3.6, 40.2], SE: [15.2, 61.8], GB: [-1.7, 52.9],
  NO: [9.6, 61.2], CH: [8.2, 46.8], IS: [-18.6, 64.9], LI: [9.55, 47.15], RS: [20.8, 44.1], BA: [17.8, 44.2], ME: [19.3, 42.8],
  MK: [21.7, 41.6], AL: [20.0, 41.1], UA: [31.2, 49.0], MD: [28.5, 47.2],
};

const TLD: Record<string, string> = { uk: "GB", eu: "LU" };

/** Country of a portal: the recipe's, else the address's country domain, else unknown. */
export function countryOf(p: { url: string; country?: string | null }): string | null {
  if (p.country && ANCHOR[p.country.toUpperCase()]) return p.country.toUpperCase();
  try {
    const tld = new URL(p.url).hostname.split(".").at(-1)!.toLowerCase();
    const code = TLD[tld] ?? tld.toUpperCase();
    return ANCHOR[code] ? code : null;
  } catch {
    return null;
  }
}
