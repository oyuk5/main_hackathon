/**
 * A small dropdown that matches the rest of the dashboard instead of the browser's native menu.
 * Keyboard: Enter, Space or the arrow keys open it; the arrows move; Enter picks; Esc or Tab closes.
 */
import { useEffect, useId, useRef, useState } from "react";

export interface Option<T extends string> {
  value: T;
  label: string;
}

export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  size = "md",
  hideLabelOnPhone = false,
}: {
  label: string;
  value: T;
  options: Option<T>[];
  onChange: (v: T) => void;
  size?: "sm" | "md";
  /** Keep the label for screen readers only below 640 px, where long labels push the row to wrap. */
  hideLabelOnPhone?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  const current = options.find((o) => o.value === value) ?? options[0]!;

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);

  const show = () => {
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };
  const pick = (i: number) => {
    onChange(options[i]!.value);
    setOpen(false);
    button.current?.focus();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!open) {
      if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(e.key)) (e.preventDefault(), show());
      return;
    }
    if (e.key === "Escape") (e.preventDefault(), setOpen(false), button.current?.focus());
    else if (e.key === "Tab") setOpen(false);
    else if (e.key === "ArrowDown") (e.preventDefault(), setActive((a) => Math.min(options.length - 1, a + 1)));
    else if (e.key === "ArrowUp") (e.preventDefault(), setActive((a) => Math.max(0, a - 1)));
    else if (e.key === "Home") (e.preventDefault(), setActive(0));
    else if (e.key === "End") (e.preventDefault(), setActive(options.length - 1));
    else if (e.key === "Enter" || e.key === " ") (e.preventDefault(), pick(active));
  };

  const h = size === "sm" ? "h-7 text-[12.5px]" : "h-9 text-[13px]";
  return (
    <div ref={box} className="relative" onKeyDown={onKey}>
      <button
        ref={button}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-activedescendant={open ? `${id}-${active}` : undefined}
        onClick={() => (open ? setOpen(false) : show())}
        className={`flex items-center gap-1.5 rounded-[4px] border bg-paper px-3 whitespace-nowrap cursor-pointer transition-colors ${h} ${
          open ? "border-docker" : "border-hairline hover:border-slate/50"
        }`}
      >
        <span className={`text-slate ${hideLabelOnPhone ? "max-sm:sr-only" : ""}`}>{label}</span>
        <span className="font-medium text-ink">{current.label}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" className={`ml-0.5 shrink-0 text-slate transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M1.5 3.5 5 7l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
      {open && (
        <ul
          id={`${id}-list`}
          role="listbox"
          aria-label={label}
          className="absolute left-0 z-30 mt-1.5 min-w-full rounded-[6px] border border-hairline bg-paper py-1 shadow-[0_8px_24px_rgb(0_0_0/0.18)]"
        >
          {options.map((o, i) => {
            const selected = o.value === value;
            return (
              <li
                key={o.value}
                id={`${id}-${i}`}
                role="option"
                aria-selected={selected}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(i)}
                className={`flex cursor-pointer items-center gap-2.5 py-1.5 pr-4 pl-2.5 text-[13px] whitespace-nowrap ${
                  i === active ? "bg-mist" : ""
                } ${selected ? "font-semibold text-ink" : "text-ink"}`}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className={`shrink-0 text-docker ${selected ? "" : "invisible"}`}>
                  <path d="M2.2 6.3 4.8 8.8 9.8 3.4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {o.label}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
