import { ActivityIcon } from "@/components/icons/activity";
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

// Sidebar navigation for the whole dashboard. Each system module is a
// top-level entry; modules with several pages list them under `items`.
export const dashboardNav = [
  {
    title: "Dashboard",
    href: "/dashboard",
    icon: LayoutGridIcon,
  },
  {
    title: "Medicine Impact",
    href: "/dashboard/medicine-impact",
    icon: SyringeIcon,
    description: "Global event analysis and medicine demand forecasting for Sri Lanka.",
    items: [
      {
        title: "Overview",
        href: "/dashboard/medicine-impact",
        icon: ChartColumnIncreasingIcon,
        description: "Global event analysis and medicine demand overview for Sri Lanka.",
      },
      {
        title: "Events",
        href: "/dashboard/medicine-impact/events",
        icon: EarthIcon,
        description: "Local and global events that may affect medicine demand.",
      },
      {
        title: "Articles / Sources",
        href: "/dashboard/medicine-impact/articles",
        icon: FileTextIcon,
        description: "News articles and reports linked to tracked events.",
      },
      {
        title: "Impact Analysis",
        href: "/dashboard/medicine-impact/analysis",
        icon: ChartBarIncreasingIcon,
        description: "Medicines expected to be affected by current events.",
      },
      {
        title: "Demand",
        href: "/dashboard/medicine-impact/demand",
        icon: ActivityIcon,
        description: "Recent medicine demand compared with the usual baseline.",
      },
      {
        title: "Forecasts",
        href: "/dashboard/medicine-impact/forecasts",
        icon: TrendingUpIcon,
        description: "Projected medicine demand for the coming weeks.",
      },
    ],
  },
  {
    title: "Warehouse",
    href: "/dashboard/warehouse",
    icon: WarehouseIcon,
    description: "FEFO inventory, QR batch tracking and storage allocation.",
    items: [
      {
        title: "Overview",
        href: "/dashboard/warehouse",
        icon: LayoutGridIcon,
        description: "Current warehouse stock, expiry alerts, capacity and recent movements.",
      },
      {
        title: "Inventory",
        href: "/dashboard/warehouse/inventory",
        icon: ActivityIcon,
        description: "Stock by batch and storage location, earliest expiry first.",
      },
      {
        title: "FEFO",
        href: "/dashboard/warehouse/fefo",
        icon: CalendarDaysIcon,
        description: "Expiry alerts, First-Expiry-First-Out picking and compliance.",
      },
      {
        title: "QR Scan",
        href: "/dashboard/warehouse/qr",
        icon: QrCodeIcon,
        description: "Scan or type a batch label to see the batch and move its stock.",
      },
      {
        title: "Storage",
        href: "/dashboard/warehouse/storage",
        icon: MapPinIcon,
        description: "Zones, racks and storage locations with their capacity and contents.",
      },
      {
        title: "Receive & Allocate",
        href: "/dashboard/warehouse/allocation",
        icon: ChartBarIncreasingIcon,
        description: "Register incoming batches and get recommended storage locations.",
      },
      {
        title: "Movements",
        href: "/dashboard/warehouse/movements",
        icon: RefreshCWIcon,
        description: "History of receipts, transfers, dispatches, adjustments and disposals.",
      },
    ],
  },
];

// Finds the nav entry for a path, plus its parent module when it's a sub-page.
// Pages that are not in the menu (e.g. a batch's detail page) fall back to
// their module.
export function getNavItem(pathname) {
  for (const item of dashboardNav) {
    const child = item.items?.find((sub) => sub.href === pathname);
    if (child) return { ...child, parent: item };
    if (item.href === pathname) return item;
  }
  return dashboardNav.find((item) => item.href !== "/dashboard" && pathname.startsWith(`${item.href}/`));
}

export function isActivePath(pathname, href) {
  if (href === "/dashboard") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}
