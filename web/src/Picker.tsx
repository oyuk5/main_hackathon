/**
 * Choose which portals the dashboard shows. One choice for every tab: the summary, the list,
 * the map, the issues and the log. `picked` null means all portals.
 */
import { useEffect, useRef, useState } from "react";
import { StatusIcon, stateToIconKind } from "./StatusIcon";
import { STATE_ORDER, host, type PortalRow } from "./lib";

export function Picker({ all, picked, setPicked }: { all: PortalRow[]; picked: string[] | null; setPicked: (ids: string[] | null) => void }) {
  const [open, setOpen] = useState(false);
  const [find, setFind] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !box.current?.contains(document.activeElement)) return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", esc);
    return () => (document.removeEventListener("mousedown", outside), document.removeEventListener("keydown", esc));
  }, [open]);

  const chosen = new Set(picked ?? all.map((p) => p.id));
  const count = all.filter((p) => chosen.has(p.id)).length;
  const label = picked === null || count === all.length ? "All portals" : count === 1 ? host(all.find((p) => chosen.has(p.id))!.url) : `${count} of ${all.length} portals`;
  const q = find.trim().toLowerCase();
  const list = [...all]
    .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || host(a.url).localeCompare(host(b.url)))
    .filter((p) => !q || host(p.url).toLowerCase().includes(q));

  const toggle = (id: string) => {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next.size === all.length ? null : [...next]);
  };

  return (
    <div ref={box} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={`flex h-8 max-w-[260px] items-center gap-2 rounded-[4px] border px-2.5 text-[13px] font-medium cursor-pointer ${picked ? "border-docker bg-docker/15 text-ink" : "border-hairline bg-paper text-ink hover:border-slate/50"}`}
      >
        <span className="truncate">{label}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M1.5 3.5 5 7l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 z-30 mt-1.5 w-[min(300px,calc(100vw-2rem))] rounded-[6px] border border-hairline bg-paper shadow-[0_8px_24px_rgb(0_0_0/0.25)] sm:right-0 sm:left-auto">
          {all.length > 8 && (
            <div className="border-b border-hairline p-2">
              <label htmlFor="picker-find" className="sr-only">Find a portal</label>
              <input
                id="picker-find"
                autoFocus
                value={find}
                onChange={(e) => setFind(e.target.value)}
                placeholder="Find a portal"
                className="h-8 w-full rounded-[4px] border border-hairline bg-sea px-2.5 text-[13px] text-ink placeholder:text-faint focus:border-docker focus:bg-paper"
              />
            </div>
          )}
          <div className="flex items-center justify-between border-b border-hairline px-3 py-2 text-[12.5px]">
            <span className="text-slate">{count} of {all.length} shown</span>
            <span className="flex gap-3">
              <button type="button" onClick={() => setPicked(null)} className="font-semibold text-docker hover:underline cursor-pointer">All</button>
              <button type="button" onClick={() => setPicked([])} className="font-semibold text-docker hover:underline cursor-pointer">None</button>
            </span>
          </div>
          <ul className="max-h-[320px] overflow-y-auto py-1">
            {list.map((p) => (
              <li key={p.id}>
                <div className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-mist">
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5">
                  <input type="checkbox" checked={chosen.has(p.id)} onChange={() => toggle(p.id)} className="size-4 shrink-0 accent-[var(--color-docker)]" />
                  <StatusIcon kind={stateToIconKind(p.state)} size={10} />
                  <span className="min-w-0 truncate text-[13.5px] font-medium text-ink">{host(p.url)}</span>
                  </label>
                  <button
                    type="button"
                    aria-label={`Show only ${host(p.url)}`}
                    onClick={() => (setPicked([p.id]), setOpen(false), trigger.current?.focus())}
                    className="ml-auto shrink-0 text-[12px] text-docker hover:underline cursor-pointer"
                  >
                    Only
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
