"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

// Elements whose hover/focus should play the icon's animation.
const TRIGGER_SELECTOR = [
  "a",
  "button",
  "[role='menuitem']",
  "[data-slot='table-row']",
  "[data-slot='alert']",
  "[data-animate-icon]",
].join(", ");

// Renders a lucide-animated icon and plays its animation while the closest
// interactive parent (button, link, menu item, table row...) is hovered or
// focused, not only when the pointer is over the icon itself.
//
//   <AnimatedIcon icon={EarthIcon} />
export function AnimatedIcon({ icon: Icon, size = 16, className, ...props }) {
  const anchorRef = useRef(null);
  const iconRef = useRef(null);

  useEffect(() => {
    const anchor = anchorRef.current;
    const target = anchor?.closest(TRIGGER_SELECTOR) ?? anchor?.firstElementChild;
    if (!target) return;

    const start = () => iconRef.current?.startAnimation();
    const stop = () => iconRef.current?.stopAnimation();

    target.addEventListener("mouseenter", start);
    target.addEventListener("mouseleave", stop);
    target.addEventListener("focusin", start);
    target.addEventListener("focusout", stop);
    return () => {
      target.removeEventListener("mouseenter", start);
      target.removeEventListener("mouseleave", stop);
      target.removeEventListener("focusin", start);
      target.removeEventListener("focusout", stop);
    };
  }, []);

  return (
    <span ref={anchorRef} data-slot="animated-icon" className="contents">
      <Icon
        ref={iconRef}
        size={size}
        aria-hidden="true"
        className={cn("inline-flex shrink-0 items-center justify-center", className)}
        {...props}
      />
    </span>
  );
}
