/**
 * Operator dashboard, first version. Owned by D.
 * Polls /internal/overview every 3 s. D replaces this with the full design in docs/ARCHITECTURE.md §7.
 */
import { useEffect, useState } from "react";

type State = "integrating" | "serving" | "healing" | "failed";
interface Row {
  id: string;
  url: string;
  state: State;
  reason: string;
  tenderCount: number;
  lastSuccessAt: string | null;
  busy: { runId: string; kind: string } | null;
  recipeVersion: number;
  tier: string | null;
  family: string | null;
  costUsd: number;
}

const color: Record<State, string> = {
  serving: "var(--serving)",
  integrating: "var(--integrating)",
  healing: "var(--healing)",
  failed: "var(--failed)",
};

export function App() {
  const [rows, setRows] = useState<Row[]>([]);
  const [url, setUrl] = useState("");

  useEffect(() => {
    const load = () =>
      fetch("/internal/overview")
        .then((r) => r.json())
        .then(setRows)
        .catch(() => {});
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url) return;
    await fetch("/portals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) });
    setUrl("");
  };

  const counts = rows.reduce<Record<string, number>>((a, r) => ((a[r.state] = (a[r.state] ?? 0) + 1), a), {});

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <header className="mb-8 flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Watchtower</h1>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          {rows.length} portals · {counts.serving ?? 0} serving · {counts.healing ?? 0} healing · {counts.failed ?? 0} failed
        </p>
      </header>

      <form onSubmit={add} className="mb-8 flex gap-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Add a portal by its address"
          className="flex-1 rounded-lg border px-3 py-2 text-sm outline-none"
          style={{ borderColor: "var(--line)", background: "var(--panel)" }}
        />
        <button className="rounded-lg px-4 py-2 text-sm font-medium text-white" style={{ background: "var(--ink)" }}>
          Add
        </button>
      </form>

      <ul className="grid gap-3 sm:grid-cols-2">
        {rows.map((r) => (
          <li key={r.id} className="rounded-xl border p-4" style={{ borderColor: "var(--line)", background: "var(--panel)" }}>
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: color[r.state] }} />
              <span className="truncate text-sm font-medium">{new URL(r.url).host}</span>
              <span className="ml-auto text-xs" style={{ color: "var(--muted)" }}>
                {r.state}
              </span>
            </div>
            <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
              {r.reason}
            </p>
            <p className="mt-3 text-xs" style={{ color: "var(--muted)" }}>
              {r.tenderCount} tenders · {r.tier ?? "–"} · recipe v{r.recipeVersion} · ${r.costUsd.toFixed(3)}
            </p>
          </li>
        ))}
      </ul>
    </main>
  );
}
