import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const TONES = {
  red: "border-red-200 bg-red-50 text-red-700",
  amber: "border-amber-200 bg-amber-50 text-amber-800",
  green: "border-emerald-200 bg-emerald-50 text-emerald-700",
  blue: "border-sky-200 bg-sky-50 text-sky-700",
  violet: "border-violet-200 bg-violet-50 text-violet-700",
  gray: "border-border bg-muted text-muted-foreground",
};

export function ToneBadge({ tone = "gray", className, children, ...props }) {
  return (
    <Badge variant="outline" className={cn(TONES[tone] ?? TONES.gray, className)} {...props}>
      {children}
    </Badge>
  );
}

// map: { value: [label, tone] } from lib/pharmacy/format.js
export function StatusBadge({ map, value, className }) {
  const [label, tone] = map[value] ?? [value ?? "—", "gray"];
  return (
    <ToneBadge tone={tone} className={className}>
      {label}
    </ToneBadge>
  );
}

// Marks values computed from synthetic (seeded) data or provisional models.
export function SyntheticBadge({ children = "Synthetic data" }) {
  return (
    <ToneBadge tone="violet" title="Computed from sales.source = 'synthetic_seed' sample history, not real transactions">
      {children}
    </ToneBadge>
  );
}
