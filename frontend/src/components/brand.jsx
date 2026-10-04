import { Pill } from "lucide-react";
import { cn } from "@/lib/utils";

export function Brand({ className }) {
  return (
    <div className={cn("flex items-center gap-2 font-semibold", className)}>
      <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <Pill className="size-4" />
      </span>
      PharmaTwin
    </div>
  );
}
