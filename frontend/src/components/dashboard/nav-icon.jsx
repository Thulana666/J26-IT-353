"use client";

import { Bell, Settings, ShoppingCart } from "lucide-react";
import { ActivityIcon } from "@/components/icons/activity";
import { BadgeAlertIcon } from "@/components/icons/badge-alert";
import { CalendarDaysIcon } from "@/components/icons/calendar-days";
import { ChartBarIncreasingIcon } from "@/components/icons/chart-bar-increasing";
import { ChartColumnIncreasingIcon } from "@/components/icons/chart-column-increasing";
import { EarthIcon } from "@/components/icons/earth";
import { FileTextIcon } from "@/components/icons/file-text";
import { LayoutGridIcon } from "@/components/icons/layout-grid";
import { MapPinIcon } from "@/components/icons/map-pin";
import { QrCodeIcon } from "@/components/icons/qr-code";
import { RefreshCWIcon } from "@/components/icons/refresh-cw";
import { SyringeIcon } from "@/components/icons/syringe";
import { TrendingUpIcon } from "@/components/icons/trending-up";
import { WarehouseIcon } from "@/components/icons/warehouse";
import { PharmacyIcon } from "@/components/icons/pharmacy";
import { AnimatedIcon } from "@/components/icons/animated-icon";

// Navigation entries name their icon (a string), so the nav config stays
// serialisable for Server Components.
const ICONS = {
  "activity": ActivityIcon,
  "badge-alert": BadgeAlertIcon,
  "calendar-days": CalendarDaysIcon,
  "chart-bar-increasing": ChartBarIncreasingIcon,
  "chart-column-increasing": ChartColumnIncreasingIcon,
  "earth": EarthIcon,
  "file-text": FileTextIcon,
  "layout-grid": LayoutGridIcon,
  "map-pin": MapPinIcon,
  "qr-code": QrCodeIcon,
  "refresh-cw": RefreshCWIcon,
  "syringe": SyringeIcon,
  "trending-up": TrendingUpIcon,
  "warehouse": WarehouseIcon,
  "pharmacy": PharmacyIcon,
};

// Plain lucide icons where no animated version exists.
const STATIC_ICONS = {
  "bell": Bell,
  "settings": Settings,
  "shopping-cart": ShoppingCart,
};

export function NavIcon({ name, ...props }) {
  const Static = STATIC_ICONS[name];
  if (Static) return <Static size={16} aria-hidden="true" {...props} />;
  const Icon = ICONS[name] ?? (typeof name === "function" ? name : null);
  if (!Icon) return null;
  return <AnimatedIcon icon={Icon} {...props} />;
}
