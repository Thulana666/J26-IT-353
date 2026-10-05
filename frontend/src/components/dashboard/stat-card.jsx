import { AnimatedIcon } from "@/components/icons/animated-icon";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function StatCard({ label, value, hint, icon: Icon }) {
  return (
    // data-animate-icon: hovering the card plays the icon animation.
    <Card data-animate-icon>
      <CardHeader>
        <CardDescription className="flex items-center gap-2">
          {Icon && <AnimatedIcon icon={Icon} />}
          {label}
        </CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardHeader>
    </Card>
  );
}
