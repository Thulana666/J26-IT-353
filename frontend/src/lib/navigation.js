import { ActivityIcon } from "@/components/icons/activity";
import { ChartBarIncreasingIcon } from "@/components/icons/chart-bar-increasing";
import { ChartColumnIncreasingIcon } from "@/components/icons/chart-column-increasing";
import { EarthIcon } from "@/components/icons/earth";
import { FileTextIcon } from "@/components/icons/file-text";
import { LayoutGridIcon } from "@/components/icons/layout-grid";
import { SyringeIcon } from "@/components/icons/syringe";
import { TrendingUpIcon } from "@/components/icons/trending-up";

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
];

// Finds the nav entry for a path, plus its parent module when it's a sub-page.
export function getNavItem(pathname) {
  for (const item of dashboardNav) {
    const child = item.items?.find((sub) => sub.href === pathname);
    if (child) return { ...child, parent: item };
    if (item.href === pathname) return item;
  }
  return undefined;
}

export function isActivePath(pathname, href) {
  if (href === "/dashboard") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}
