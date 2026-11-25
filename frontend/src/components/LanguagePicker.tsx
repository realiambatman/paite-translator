import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

export interface PickerOption {
  code: string;
  label: string;
  /** Heading the language is listed under; options keep the order they are given in. */
  group?: string;
  /** A short remark shown after the name, e.g. "little data". */
  note?: string;
}

interface Props {
  value: string;
  onChange: (code: string) => void;
  options: PickerOption[];
  disabled?: boolean;
  /** What the choice is for, read out by screen readers ("The language your text is in"). */
  ariaLabel: string;
  /** Which edge of the button the list lines up with. */
  align?: "left" | "right";
  className?: string;
}

const SEARCH_FROM = 8;   // shorter lists need no search box

/**
 * The language choice used on both tabs: a button showing the chosen language that opens a list to pick
 * from, with a search box for the long lists. It replaces the browser's own drop-down, which on a phone
 * covered the page with a plain wheel and on a desktop could not be searched or grouped clearly.
 *
 * Keyboard: Enter, Space or the down arrow opens it; type to search; arrows move; Enter chooses; Esc closes.
 */
export function LanguagePicker({ value, onChange, options, disabled, ariaLabel, align = "left", className }: Props) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const current = options.find((o) => o.code === value);
  const searchable = options.length >= SEARCH_FROM;

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    const starts = options.filter((o) => o.label.toLowerCase().startsWith(q));
    const rest = options.filter(
      (o) => !o.label.toLowerCase().startsWith(q) && (o.label.toLowerCase().includes(q) || o.code.toLowerCase().includes(q)),
    );
    return [...starts, ...rest];
  }, [options, query]);

  // With a search typed the headings would split a short result list for no reason.
  const groups = useMemo(() => {
    if (query.trim()) return [{ name: "", items: shown }];
    const out: { name: string; items: PickerOption[] }[] = [];
    for (const o of shown) {
      const name = o.group ?? "";
      const last = out[out.length - 1];
      if (last && last.name === name) last.items.push(o);
      else out.push({ name, items: [o] });
    }
    return out;
  }, [shown, query]);

  const position = () => {
    const b = buttonRef.current?.getBoundingClientRect();
    if (!b) return;
    const width = Math.min(384, window.innerWidth - 16);
    const left = Math.max(8, Math.min(align === "right" ? b.right - width : b.left, window.innerWidth - width - 8));
    const below = window.innerHeight - b.bottom - 16;
    setPlace({ top: b.bottom + 6, left, width, maxHeight: Math.max(220, Math.min(460, below)) });
  };

  const openList = () => {
    if (disabled) return;
    setQuery("");
    setActive(Math.max(0, options.findIndex((o) => o.code === value)));
    position();
    setOpen(true);
  };
  const close = (focusButton = true) => {
    setOpen(false);
    if (focusButton) buttonRef.current?.focus();
  };
  const choose = (code: string) => {
    onChange(code);
    close();
  };

  useLayoutEffect(() => {
    if (!open) return;
    (searchable ? searchRef.current : panelRef.current)?.focus();
  }, [open, searchable]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panelRef.current?.contains(t) && !buttonRef.current?.contains(t)) close(false);
    };
    const move = (e: Event) => {
      if (panelRef.current?.contains(e.target as Node)) return;   // scrolling the list itself
      position();
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", move, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", move, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const onKeys = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(shown.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(shown.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (shown[active]) choose(shown[active].code);
    } else if (e.key === "Tab") {
      close(false);
    }
  };

  let index = -1;
  return (
    <span className={`relative inline-flex min-w-0 items-center ${className ?? ""}`}>
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-label={`${ariaLabel}: ${current?.label ?? value}`}
        onClick={() => (open ? close() : openList())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            openList();
          }
        }}
        className={`inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-xl border py-1.5 pl-2.5 pr-2 font-serif text-lg font-semibold text-zomi-ink outline-none transition focus-visible:border-zomi-red/40 focus-visible:ring-2 focus-visible:ring-zomi-red/15 disabled:cursor-default disabled:opacity-60 ${
          open ? "border-stone-300/70 bg-white" : "border-transparent bg-transparent hover:bg-white/70"
        }`}
      >
        <span className="truncate">{current?.label ?? value}</span>
        <svg
          aria-hidden
          viewBox="0 0 20 20"
          className={`h-4 w-4 shrink-0 text-zomi-muted transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
        >
          <path d="M6 8l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && place && (
        <div
          ref={panelRef}
          tabIndex={-1}
          onKeyDown={onKeys}
          style={{ top: place.top, left: place.left, width: place.width, maxHeight: place.maxHeight }}
          className="fixed z-50 flex flex-col overflow-hidden rounded-2xl border border-stone-300/70 bg-white font-sans shadow-[0_18px_44px_-18px_rgb(28_25_23/0.45)] outline-none"
        >
          {searchable && (
            <div className="border-b border-stone-200 p-2">
              <input
                ref={searchRef}
                type="text"
                inputMode="search"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                placeholder="Find a language"
                aria-label="Find a language"
                aria-controls={`${id}-list`}
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded-lg border border-stone-300/70 bg-zomi-cream px-3 py-2 text-sm text-zomi-ink outline-none placeholder:text-zomi-muted focus:border-zomi-red/40 focus:ring-2 focus:ring-zomi-red/15"
              />
            </div>
          )}
          <div ref={listRef} id={`${id}-list`} role="listbox" aria-label={ariaLabel} className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {shown.length === 0 && (
              <p className="px-3 py-6 text-center text-sm text-zomi-muted">No language matches “{query.trim()}”.</p>
            )}
            {groups.map((g) => (
              <div key={g.name || "all"} role="group" aria-label={g.name || undefined}>
                {g.name && <p className="px-2.5 pb-1 pt-2.5 text-xs text-zomi-muted">{g.name}</p>}
                <div className="grid grid-cols-1 gap-x-1 min-[400px]:grid-cols-2">
                  {g.items.map((o) => {
                    index += 1;
                    const i = index;
                    const chosen = o.code === value;
                    return (
                      <button
                        key={o.code}
                        type="button"
                        role="option"
                        aria-selected={chosen}
                        data-index={i}
                        tabIndex={-1}
                        onClick={() => choose(o.code)}
                        onPointerMove={() => setActive(i)}
                        className={`relative flex min-w-0 items-baseline gap-2 rounded-lg py-2 pl-3.5 pr-2 text-left font-serif text-[1.02rem] leading-snug text-zomi-ink ${
                          i === active ? "bg-stone-100" : ""
                        } ${chosen ? "font-semibold" : ""}`}
                      >
                        {chosen && <span aria-hidden className="absolute bottom-2 left-1 top-2 w-[3px] rounded-full bg-zomi-red" />}
                        <span className="min-w-0 break-words">{o.label}</span>
                        {o.note && <span className="shrink-0 font-sans text-[11px] font-normal text-zomi-muted">{o.note}</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </span>
  );
}
