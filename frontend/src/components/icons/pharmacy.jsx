"use client";
import { motion, useAnimation } from "motion/react";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";

import { cn } from "@/lib/utils";

// Animated pharmacy cross / pill icon for the sidebar and nav.
const PharmacyIcon = forwardRef(({ onMouseEnter, onMouseLeave, className, size = 28, ...props }, ref) => {
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
        fill="currentColor"
        height={size}
        viewBox="0 0 24 24"
        width={size}
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Pill / capsule body */}
        <motion.g
          animate={controls}
          variants={{
            normal: { rotate: 0, scale: 1 },
            animate: {
              rotate: [0, -15, 15, -10, 10, 0],
              scale: [1, 1.1, 1.05, 1],
              transition: { duration: 0.7, ease: "easeInOut" },
            },
          }}
        >
          {/* Pharmacy cross */}
          <rect x="10.5" y="2" width="3" height="9" rx="1" />
          <rect x="7" y="5.5" width="10" height="3" rx="1" />
          {/* Pill shape at bottom */}
          <rect x="7.5" y="14" width="9" height="4.5" rx="2.25" />
          <path d="M7.5 16.25h9" stroke="currentColor" strokeWidth="0.8" fill="none" />
        </motion.g>
      </svg>
    </div>
  );
});

PharmacyIcon.displayName = "PharmacyIcon";

export { PharmacyIcon };
