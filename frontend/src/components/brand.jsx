import { AnimatedIcon } from "@/components/icons/animated-icon";
import { SyringeIcon } from "@/components/icons/syringe";
import { cn } from "@/lib/utils";

export function Brand({ className }) {
  return (
    <div className={cn("flex items-center gap-2 font-semibold", className)}>
      <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <AnimatedIcon icon={SyringeIcon} />
      </span>
      PharmaTwin
    </div>
  );
}
