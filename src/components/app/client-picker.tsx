"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { fieldClass } from "./list";

export type PickerClient = { id: string; name: string; email: string; phone: string | null };

type Props = {
  /** Searches this business's active clients (a bound server action; at most a handful of rows). */
  search: (query: string) => Promise<PickerClient[]>;
  /** The hidden field carrying the chosen client's id. */
  name: string;
  label: string;
  /** Preselected client (e.g. "New event" from a client's page). */
  initial?: PickerClient | null;
  /** Clients that can't be chosen here (already on the event). */
  exclude?: string[];
  onChange?: (client: PickerClient | null) => void;
};

/**
 * Finds an existing client by name, email or phone instead of scrolling a
 * dropdown of every client: the server returns a few matches at a time, so
 * a business with thousands of clients loads nothing extra. Results are
 * plain buttons (keyboard and touch friendly); the count is announced.
 */
export function ClientPicker({ search, name, label, initial = null, exclude = [], onChange }: Props) {
  const id = useId();
  const [chosen, setChosen] = useState<PickerClient | null>(initial);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PickerClient[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, start] = useTransition();
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  const excluded = new Set(exclude);

  // An "add another" form that resets after saving starts the picker over too.
  useEffect(() => {
    const form = box.current?.closest("form");
    if (!form) return;
    const reset = () => {
      setChosen(initial);
      setQuery("");
    };
    form.addEventListener("reset", reset);
    return () => form.removeEventListener("reset", reset);
  }, [initial]);

  useEffect(() => {
    if (chosen) return;
    const ticket = ++latest.current;
    const timer = window.setTimeout(() => {
      start(async () => {
        try {
          const rows = await search(query);
          if (ticket === latest.current) {
            setResults(rows);
            setFailed(false);
          }
        } catch {
          if (ticket === latest.current) setFailed(true);
        }
      });
    }, query ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [query, chosen, search]);

  function choose(client: PickerClient | null) {
    setChosen(client);
    onChange?.(client);
    if (!client) window.requestAnimationFrame(() => input.current?.focus());
  }

  const shown = (results ?? []).filter((c) => !excluded.has(c.id));

  return (
    <div ref={box} className="grid gap-1.5" data-testid="client-picker">
      <input type="hidden" name={name} value={chosen?.id ?? ""} />
      {chosen ? (
        <>
          <p className="text-sm font-medium">{label}</p>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-background px-3 py-2 text-sm" data-testid="picked-client">
            <span className="grid min-w-0">
              <span className="font-medium [overflow-wrap:anywhere]">{chosen.name}</span>
              <span className="text-muted-foreground [overflow-wrap:anywhere]">{chosen.email}{chosen.phone ? ` · ${chosen.phone}` : ""}</span>
            </span>
            <Button type="button" variant="outline" size="sm" onClick={() => choose(null)}>Change</Button>
          </div>
        </>
      ) : (
        <>
          <label htmlFor={`${id}-search`} className="text-sm font-medium">{label}</label>
          <span className="relative">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              ref={input}
              id={`${id}-search`}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // Enter picks the only match instead of submitting the whole form.
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (shown.length === 1) choose(shown[0]);
                }
              }}
              maxLength={100}
              autoComplete="off"
              placeholder="Search by name, email or phone"
              aria-describedby={`${id}-status`}
              className={cn(fieldClass, "h-10 w-full pl-8 text-foreground")}
            />
          </span>
          <p id={`${id}-status`} aria-live="polite" className="text-xs text-muted-foreground">
            {failed
              ? "Clients couldn't be searched. Check your connection and try again."
              : results === null || pending
                ? "Searching…"
                : shown.length === 0
                  ? query
                    ? "No active client matches. Check the spelling, or add a new client."
                    : "No other active clients yet."
                  : `${shown.length === 8 ? "First 8 matches" : `${shown.length} ${shown.length === 1 ? "match" : "matches"}`}${query ? "" : ", by name"}. Choose one.`}
          </p>
          {shown.length > 0 ? (
            <ul className="grid divide-y overflow-hidden rounded-lg border bg-background" aria-label="Matching clients">
              {shown.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => choose(c)}
                    className="grid min-h-11 w-full gap-0.5 px-3 py-2 text-left text-sm outline-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    <span className="font-medium [overflow-wrap:anywhere]">{c.name}</span>
                    <span className="text-muted-foreground [overflow-wrap:anywhere]">{c.email}{c.phone ? ` · ${c.phone}` : ""}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </div>
  );
}
