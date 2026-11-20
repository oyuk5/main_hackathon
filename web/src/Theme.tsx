/**
 * Light, dark, or follow the computer (the default). The choice is remembered in this browser only;
 * index.html applies it before the first paint.
 */
import { useRef, useState } from "react";
import { t, type Key } from "./i18n";

type Theme = "auto" | "light" | "dark";

function read(): Theme {
  try {
    const t = localStorage.getItem("wt.theme");
    return t === "light" || t === "dark" ? t : "auto";
  } catch {
    return "auto";
  }
}

function apply(t: Theme) {
  if (t === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  try {
    if (t === "auto") localStorage.removeItem("wt.theme");
    else localStorage.setItem("wt.theme", t);
  } catch {
    /* private window: the choice lasts until reload */
  }
}

const OPTIONS: { id: Theme; label: Key; icon: React.ReactNode }[] = [
  {
    id: "auto",
    label: "theme.auto",
    icon: (
      <>
        <rect x="2" y="3" width="12" height="8.5" rx="1.3" />
        <path d="M5.5 14h5M8 11.5V14" />
      </>
    ),
  },
  {
    id: "light",
    label: "theme.light",
    icon: (
      <>
        <circle cx="8" cy="8" r="2.8" />
        <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" />
      </>
    ),
  },
  {
    id: "dark",
    label: "theme.dark",
    icon: <path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8Z" />,
  },
];

export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(read);
  const group = useRef<HTMLDivElement>(null);
  const select = (value: Theme) => {
    apply(value);
    setTheme(value);
  };
  return (
    <div ref={group} role="radiogroup" aria-label={t("theme.group")} className="flex shrink-0 items-center rounded-[5px] border border-hairline bg-sea p-0.5"
      onKeyDown={(e) => {
        const delta = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
        if (!delta) return;
        e.preventDefault();
        const active = OPTIONS.findIndex((o) => o.id === theme);
        const next = (active + delta + OPTIONS.length) % OPTIONS.length;
        select(OPTIONS[next]!.id);
        group.current?.querySelectorAll<HTMLButtonElement>('button[role="radio"]')[next]?.focus();
      }}>
      {OPTIONS.map((o) => {
        const on = theme === o.id;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            aria-label={t(o.label)}
            title={t(o.label)}
            onClick={() => select(o.id)}
            className={`grid size-7 place-items-center rounded-[4px] transition-colors cursor-pointer ${
              on ? "bg-paper text-ink shadow-[0_0_0_1px_var(--color-hairline)]" : "text-faint hover:text-ink"
            }`}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {o.icon}
            </svg>
          </button>
        );
      })}
    </div>
  );
}
