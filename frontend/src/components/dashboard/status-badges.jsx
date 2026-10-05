import { AnimatedIcon } from "@/components/icons/animated-icon";
import { ArrowDownRightIcon } from "@/components/icons/arrow-down-right";
import { ArrowRightIcon } from "@/components/icons/arrow-right";
import { ArrowUpRightIcon } from "@/components/icons/arrow-up-right";
import { Badge } from "@/components/ui/badge";
import { formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

const LEVEL_STYLES = {
  critical: "bg-red-500/15 text-red-400",
  high: "bg-orange-500/15 text-orange-400",
  medium: "bg-amber-500/15 text-amber-300",
  low: "bg-emerald-500/15 text-emerald-400",
};

const STATUS_STYLES = {
  active: "bg-red-500/15 text-red-400",
  monitoring: "bg-sky-500/15 text-sky-400",
  resolved: "bg-muted text-muted-foreground",
};

// Severity / impact / relevance levels: critical, high, medium, low.
export function LevelBadge({ level }) {
  return (
    <Badge className={cn("capitalize", LEVEL_STYLES[level])} variant="secondary">
      {level}
    </Badge>
  );
}

export function StatusBadge({ status }) {
  return (
    <Badge className={cn("capitalize", STATUS_STYLES[status])} variant="secondary">
      {status}
    </Badge>
  );
}

// Percentage change with an up/down arrow.
export function ChangeBadge({ value }) {
  const icon = value > 0 ? ArrowUpRightIcon : value < 0 ? ArrowDownRightIcon : ArrowRightIcon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 font-medium tabular-nums",
        value > 0 && "text-orange-400",
        value < 0 && "text-sky-400",
        value === 0 && "text-muted-foreground"
      )}
    >
      <AnimatedIcon icon={icon} size={14} />
      {formatPercent(value)}
    </span>
  );
}
