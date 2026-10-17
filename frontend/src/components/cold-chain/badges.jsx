import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// Badge tones for the dark dashboard, matching components/dashboard/status-badges.jsx.
const TONES = {
  red: "bg-red-500/15 text-red-400",
  amber: "bg-amber-500/15 text-amber-300",
  green: "bg-emerald-500/15 text-emerald-400",
  blue: "bg-sky-500/15 text-sky-400",
  violet: "bg-violet-500/15 text-violet-300",
  gray: "bg-muted text-muted-foreground",
};

export function ToneBadge({ tone = "gray", className, children, ...props }) {
  return (
    <Badge variant="secondary" className={cn(TONES[tone] ?? TONES.gray, className)} {...props}>
      {children}
    </Badge>
  );
}

// map: { value: [label, tone] } from lib/cold-chain/format.js
export function MapBadge({ map, value, className, title }) {
  const [label, tone] = map[value] ?? [value ?? "—", "gray"];
  return (
    <ToneBadge tone={tone} className={className} title={title}>
      {label}
    </ToneBadge>
  );
}

// Simulated readings are never presented as real sensor data.
export function TestDataBadge() {
  return (
    <ToneBadge tone="violet" title="Readings from a development simulator device, not real sensor data">
      Test data
    </ToneBadge>
  );
}

// The rule-based predictor is a temporary stand-in for the trained model.
export function PrototypeBadge() {
  return (
    <ToneBadge tone="amber" title="Rule-based prototype used until the CNN-LSTM model is trained">
      Prototype prediction · temporary model
    </ToneBadge>
  );
}
