/**
 * Add many portals at once: drop a spreadsheet, CSV, JSON or text file (or paste a list), review the addresses
 * found, then add the ones kept. Each one is a normal POST /portals; Watchtower attaches them one by one.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ACCEPT, keyOf, unique, urlsInFile, urlsInText, type FoundUrl } from "./importUrls";
import { t, useT } from "./i18n";
import { usd } from "./lib";

/** Measured by the lab eval: a new portal on unknown software costs about this to attach. */
const ATTACH_USD = 0.04;
const PARALLEL = 3;

type Result = "added" | "invalid" | "failed";
interface Row extends FoundUrl {
  picked: boolean;
  watched: boolean;
  result?: Result;
}

export function ImportDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [paste, setPaste] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [drag, setDrag] = useState(false);
  const [onePerSite, setOnePerSite] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const adding = progress !== null && progress.done < progress.total;
  useT();

  useEffect(() => {
    box.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !adding && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [adding, onClose]);

  const review = async (found: FoundUrl[]) => {
    const list = unique(found);
    if (!list.length) return setError(t("imp.noUrls"));
    const watched = new Set<string>();
    const res = await fetch("/portals").catch(() => null);
    if (res?.ok) for (const p of (await res.json()) as Array<{ url: string }>) watched.add(keyOf(p.url));
    setError(null);
    setRows(list.map((f) => ({ ...f, watched: watched.has(f.key), picked: !watched.has(f.key) })));
  };

  const readFiles = async (files: FileList | File[]) => {
    setReading(true);
    try {
      const found = (await Promise.all([...files].map(urlsInFile))).flat();
      await review(found);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("imp.unreadable"));
    } finally {
      setReading(false);
    }
  };

  const sites = useMemo(() => new Set(rows?.map((r) => r.host)).size, [rows]);
  const shown = useMemo(() => {
    if (!rows) return [];
    if (!onePerSite) return rows;
    const seen = new Set<string>();
    return rows.filter((r) => !seen.has(r.host) && (seen.add(r.host), true));
  }, [rows, onePerSite]);
  const chosen = shown.filter((r) => r.picked && !r.watched && !r.result);

  const setPicked = (pred: (r: Row) => boolean, picked: boolean) =>
    setRows((rs) => rs && rs.map((r) => (pred(r) && !r.watched ? { ...r, picked } : r)));

  const addAll = async () => {
    const queue = [...chosen];
    const total = queue.length;
    let done = 0;
    setProgress({ done, total });
    const mark = (key: string, result: Result) => setRows((rs) => rs && rs.map((r) => (r.key === key ? { ...r, result } : r)));
    const worker = async () => {
      for (let r = queue.shift(); r; r = queue.shift()) {
        const res = await fetch("/portals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: r.url }) }).catch(() => null);
        mark(r.key, res?.ok ? "added" : res?.status === 400 ? "invalid" : "failed");
        setProgress({ done: ++done, total });
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, total) }, worker));
    onAdded();
  };

  const counts = rows && {
    added: rows.filter((r) => r.result === "added").length,
    invalid: rows.filter((r) => r.result === "invalid").length,
    failed: rows.filter((r) => r.result === "failed").length,
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 p-4 sm:pt-[8vh]" onMouseDown={(e) => e.target === e.currentTarget && !adding && onClose()}>
      <div
        ref={box}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-title"
        className="w-full max-w-[680px] rounded-[6px] border border-hairline bg-paper p-5 text-ink shadow-xl outline-none"
      >
        <div className="flex items-baseline justify-between gap-4">
          <h2 id="import-title" className="font-display text-[19px] font-bold tracking-tight">{t("imp.title")}</h2>
          <button onClick={onClose} disabled={adding} className="cursor-pointer text-[13px] text-slate hover:text-ink disabled:opacity-40">
            {t("imp.close")}
          </button>
        </div>

        {!rows && (
          <>
            <p className="mt-1 text-[13px] text-slate">
              {t("imp.intro")}
            </p>
            <div
              onDragOver={(e) => (e.preventDefault(), setDrag(true))}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => (e.preventDefault(), setDrag(false), void readFiles(e.dataTransfer.files))}
              className={`mt-4 flex flex-col items-center justify-center gap-2 rounded-[6px] border-2 border-dashed px-4 py-8 text-center ${drag ? "border-docker bg-sea" : "border-hairline"}`}
            >
              <p className="text-[14px] font-semibold">{reading ? t("imp.reading") : t("imp.drop")}</p>
              <button
                type="button"
                onClick={() => file.current?.click()}
                className="h-8 cursor-pointer rounded-[4px] border border-hairline bg-sea px-3 text-[13px] font-semibold hover:border-docker"
              >
                {t("imp.choose")}
              </button>
              <input ref={file} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => e.target.files && void readFiles(e.target.files)} />
            </div>
            <label htmlFor="import-paste" className="mt-4 block text-[13px] font-semibold">
              {t("imp.paste")}
            </label>
            <textarea
              id="import-paste"
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              rows={4}
              placeholder={"https://www.tenderned.nl/aankondigingen/overzicht\nhttps://platformazakupowa.pl/all"}
              className="mt-1 w-full rounded-[4px] border border-hairline bg-sea p-2 font-mono text-[12.5px] placeholder:text-faint focus:border-docker focus:bg-paper"
            />
            <div className="mt-2 flex justify-end">
              <button
                disabled={!paste.trim()}
                onClick={() => void review(urlsInText(paste, "pasted text"))}
                className="h-8 cursor-pointer rounded-[4px] bg-docker-solid px-3.5 text-[13px] font-semibold text-white hover:bg-docker-hover disabled:cursor-default disabled:opacity-50"
              >
                {t("imp.find")}
              </button>
            </div>
          </>
        )}

        {error && <p role="alert" className="mt-3 text-[13px] text-failed">{error}</p>}

        {rows && counts && (
          <>
            <p className="mt-1 text-[13px] text-slate">
              {t("imp.found", { n: rows.length, s: sites, w: rows.filter((r) => r.watched).length })}
            </p>
            {rows.length > sites && (
              <label className="mt-2 flex cursor-pointer items-start gap-2 rounded-[4px] bg-sea px-2.5 py-2 text-[13px]">
                <input type="checkbox" checked={onePerSite} onChange={(e) => setOnePerSite(e.target.checked)} disabled={!!progress} className="mt-0.5" />
                <span>
                  <b>{t("imp.onePerSite")}</b> <span className="text-slate">{t("imp.onePerSiteNote")}</span>
                </span>
              </label>
            )}
            {!progress && (
              <div className="mt-3 flex gap-3 text-[12.5px]">
                <button className="cursor-pointer text-docker hover:underline" onClick={() => setPicked(() => true, true)}>{t("imp.selectAll")}</button>
                <button className="cursor-pointer text-docker hover:underline" onClick={() => setPicked(() => true, false)}>{t("imp.selectNone")}</button>
              </div>
            )}
            <ul className="mt-2 max-h-[46vh] divide-y divide-hairline overflow-y-auto rounded-[4px] border border-hairline">
              {shown.map((r) => (
                <li key={r.key}>
                  <label className={`flex items-center gap-2.5 px-2.5 py-1.5 text-[13px] ${r.watched ? "opacity-55" : "cursor-pointer"}`}>
                    <input
                      type="checkbox"
                      checked={r.picked && !r.watched}
                      disabled={r.watched || !!progress}
                      onChange={(e) => setPicked((x) => x.key === r.key, e.target.checked)}
                    />
                    <span className="min-w-0 flex-1 truncate" title={r.url}>{r.url.replace(/^https?:\/\//, "")}</span>
                    <span className={`shrink-0 text-[12px] ${r.result === "added" ? "text-serving" : r.result ? "text-failed" : "text-slate"}`}>
                      {r.watched ? t("imp.already") : r.result === "added" ? t("imp.added") : r.result === "invalid" ? t("imp.invalid") : r.result === "failed" ? t("imp.notAdded") : ""}
                    </span>
                  </label>
                </li>
              ))}
            </ul>

            {!progress ? (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <button onClick={() => (setRows(null), setOnePerSite(false))} className="cursor-pointer text-[13px] text-slate hover:text-ink">
                  {t("imp.another")}
                </button>
                <div className="flex items-center gap-3">
                  {chosen.length > 0 && (
                    <span className="text-[12.5px] text-slate">
                      {t("imp.cost", { usd: usd(chosen.length * ATTACH_USD, 2) })}
                    </span>
                  )}
                  <button
                    disabled={!chosen.length}
                    onClick={() => void addAll()}
                    className="h-8 shrink-0 cursor-pointer rounded-[4px] bg-docker-solid px-3.5 text-[13px] font-semibold text-white hover:bg-docker-hover disabled:cursor-default disabled:opacity-50"
                  >
                    {t("imp.watch", { n: chosen.length })}
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-4 flex items-center justify-between gap-3 text-[13px]" role="status">
                <span>
                  {adding
                    ? t("imp.progress", { d: progress.done, t: progress.total })
                    : t("imp.result", { a: counts.added, i: counts.invalid, f: counts.failed })}
                </span>
                {!adding && (
                  <button onClick={onClose} className="h-8 shrink-0 cursor-pointer rounded-[4px] bg-docker-solid px-3.5 font-semibold text-white hover:bg-docker-hover">
                    {t("imp.done")}
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
