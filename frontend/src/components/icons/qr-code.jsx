"use client";
import { motion, useAnimation } from "motion/react";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";

import { cn } from "@/lib/utils";

// Lucide "qr-code" icon; a scan line sweeps down on hover.
const SCAN_VARIANTS = {
  normal: { opacity: 0, y: 0 },
  animate: {
    opacity: [0, 1, 1, 0],
    y: [0, 9, 18, 18],
    transition: { duration: 0.8, ease: "easeInOut", times: [0, 0.4, 0.9, 1] },
  },
};

const QrCodeIcon = forwardRef(({ onMouseEnter, onMouseLeave, className, size = 28, ...props }, ref) => {
  const controls = useAnimation();
  const isControlledRef = useRef(false);

  useImperativeHandle(ref, () => {
    isControlledRef.current = true;

    return {
      startAnimation: () => controls.start("animate"),
      stopAnimation: () => controls.start("normal"),
    };
  });

  const handleMouseEnter = useCallback(
    (e) => {
      if (isControlledRef.current) {
        onMouseEnter?.(e);
      } else {
        controls.start("animate");
      }
    },
    [controls, onMouseEnter]
  );

  const handleMouseLeave = useCallback(
    (e) => {
      if (isControlledRef.current) {
        onMouseLeave?.(e);
      } else {
        controls.start("normal");
      }
    },
    [controls, onMouseLeave]
  );

  return (
    <div
      className={cn(className)}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      {...props}
    >
      <svg
        fill="none"
        height={size}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        viewBox="0 0 24 24"
        width={size}
        xmlns="http://www.w3.org/2000/svg"
      >
        <rect height="5" rx="1" width="5" x="3" y="3" />
        <rect height="5" rx="1" width="5" x="16" y="3" />
        <rect height="5" rx="1" width="5" x="3" y="16" />
        <path d="M21 16h-3a2 2 0 0 0-2 2v3" />
        <path d="M21 21v.01" />
        <path d="M12 7v3a2 2 0 0 1-2 2H7" />
        <path d="M3 12h.01" />
        <path d="M12 3h.01" />
        <path d="M12 16v.01" />
        <path d="M16 12h1" />
        <path d="M21 12v.01" />
        <path d="M12 21v-1" />
        <motion.path animate={controls} d="M2 3h20" initial="normal" variants={SCAN_VARIANTS} />
      </svg>
    </div>
  );
});

QrCodeIcon.displayName = "QrCodeIcon";

export { QrCodeIcon };
