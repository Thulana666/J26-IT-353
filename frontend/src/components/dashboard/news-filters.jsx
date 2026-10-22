"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Loader2, Search, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const ALL = "all";
const SEARCH_DELAY_MS = 400;

// Filter bar for Recent News. Every change updates the URL (?q=&category=...),
// which re-renders the server page, so results, pagination and links stay shareable.
// `filters` = [{ name, label, options: [[value, text]] }].
export function NewsFilters({ filters, values }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [query, setQuery] = useState(values.q ?? "");
  const lastPushed = useRef(values.q ?? "");

  const update = (changes) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (!value || value === ALL) next.delete(key);
      else next.set(key, value);
    }
    next.delete("page"); // a new filter starts at page 1
    const search = next.toString();
    startTransition(() => router.push(search ? `${pathname}?${search}` : pathname, { scroll: false }));
  };

  // Debounced search while typing.
  useEffect(() => {
    if (query === lastPushed.current) return;
    const timer = setTimeout(() => {
      lastPushed.current = query;
      update({ q: query.trim() });
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  });

  const label = (f, value) => f.options.find(([v]) => v === value)?.[1] ?? value;
  const chips = [
    ...(values.q ? [{ key: "q", text: `“${values.q}”` }] : []),
    ...filters.filter((f) => values[f.name]).map((f) => ({ key: f.name, text: `${f.label}: ${label(f, values[f.name])}` })),
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="relative flex-1">
          {pending ? (
            <Loader2 className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
          ) : (
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          )}
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                lastPushed.current = query;
                update({ q: query.trim() });
              }
            }}
            placeholder="Search headlines and article text…"
            aria-label="Search news"
            className="h-9 pl-8"
          />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex">
          {filters.map((f) => (
            <Select
              key={f.name}
              items={{ [ALL]: `All ${f.plural}`, ...Object.fromEntries(f.options) }}
              value={values[f.name] ?? ALL}
              onValueChange={(value) => update({ [f.name]: value })}
            >
              <SelectTrigger className="h-9 w-full sm:w-44" aria-label={f.label}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All {f.plural}</SelectItem>
                {f.options.map(([value, text]) => (
                  <SelectItem key={value} value={value}>
                    {text}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ))}
        </div>
      </div>

      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((chip) => (
            <Badge key={chip.key} variant="secondary" className="h-6 gap-1 pr-1">
              {chip.text}
              <button
                type="button"
                onClick={() => {
                  if (chip.key === "q") {
                    setQuery("");
                    lastPushed.current = "";
                  }
                  update({ [chip.key]: null });
                }}
                className="rounded-full p-0.5 hover:bg-foreground/10"
                aria-label={`Remove ${chip.text}`}
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setQuery("");
              lastPushed.current = "";
              startTransition(() => router.push(pathname, { scroll: false }));
            }}
          >
            Clear all
          </Button>
        </div>
      )}
    </div>
  );
}
