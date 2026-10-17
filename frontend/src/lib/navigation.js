const PHARMACY_ROLES = ["admin", "pharmacy_staff"];
// Cold-chain shipments are warehouse -> pharmacy deliveries: both sides see them.
// The warehouse side starts monitoring and manages the sensor devices.
const COLD_CHAIN_ROLES = ["admin", "warehouse_staff", "pharmacy_staff"];
const COLD_CHAIN_MANAGER_ROLES = ["admin", "warehouse_staff"];

// Sidebar navigation for the whole dashboard. Each system module is a
// top-level entry; modules with several pages list them under `items`.
export const dashboardNav = [
  {
    title: "Dashboard",
    href: "/dashboard",
    icon: "layout-grid",
  },
  {
    title: "Medicine Impact",
    href: "/dashboard/medicine-impact",
    icon: "syringe",
    description: "Global event analysis and medicine demand forecasting for Sri Lanka.",
    items: [
      {
        title: "Overview",
        href: "/dashboard/medicine-impact",
        icon: "chart-column-increasing",
        description: "Global event analysis and medicine demand overview for Sri Lanka.",
      },
      {
        title: "Events",
        href: "/dashboard/medicine-impact/events",
        icon: "earth",
        description: "Local and global events that may affect medicine demand.",
      },
      {
        title: "Articles / Sources",
        href: "/dashboard/medicine-impact/articles",
        icon: "file-text",
        description: "News articles and reports linked to tracked events.",
      },
      {
        title: "Impact Analysis",
        href: "/dashboard/medicine-impact/analysis",
        icon: "chart-bar-increasing",
        description: "Medicines expected to be affected by current events.",
      },
      {
        title: "Demand",
        href: "/dashboard/medicine-impact/demand",
        icon: "activity",
        description: "Recent medicine demand compared with the usual baseline.",
      },
      {
        title: "Forecasts",
        href: "/dashboard/medicine-impact/forecasts",
        icon: "trending-up",
        description: "Projected medicine demand for the coming weeks.",
      },
    ],
  },
  {
    title: "Cold Chain",
    href: "/dashboard/cold-chain",
    icon: "thermometer",
    description: "IoT temperature, humidity and GPS tracking of shipments in transit, with alerts and risk prediction.",
    items: [
      {
        title: "Shipments",
        href: "/dashboard/cold-chain",
        icon: "thermometer",
        roles: COLD_CHAIN_ROLES,
        description: "Monitored shipments: current conditions, connection, delivery, alerts and predicted risk.",
      },
      {
        title: "Start monitoring",
        href: "/dashboard/cold-chain/start",
        icon: "play",
        roles: COLD_CHAIN_MANAGER_ROLES,
        description: "Assign a sensor device to a shipment in transit and set its limits.",
      },
      {
        title: "Devices",
        href: "/dashboard/cold-chain/devices",
        icon: "cpu",
        roles: COLD_CHAIN_MANAGER_ROLES,
        description: "ESP32 loggers and simulators: registration, keys and status.",
      },
    ],
  },
  {
    title: "Warehouse",
    href: "/dashboard/warehouse",
    icon: "warehouse",
    description: "FEFO inventory, QR batch tracking and storage allocation.",
    items: [
      {
        title: "Overview",
        href: "/dashboard/warehouse",
        icon: "layout-grid",
        description: "Current warehouse stock, expiry alerts, capacity and recent movements.",
      },
      {
        title: "Inventory",
        href: "/dashboard/warehouse/inventory",
        icon: "activity",
        description: "Stock by batch and storage location, earliest expiry first.",
      },
      {
        title: "FEFO",
        href: "/dashboard/warehouse/fefo",
        icon: "calendar-days",
        description: "Expiry alerts, First-Expiry-First-Out picking and compliance.",
      },
      {
        title: "QR Scan",
        href: "/dashboard/warehouse/qr",
        icon: "qr-code",
        description: "Scan or type a batch label to see the batch and move its stock.",
      },
      {
        title: "Storage",
        href: "/dashboard/warehouse/storage",
        icon: "map-pin",
        description: "Zones, racks and storage locations with their capacity and contents.",
      },
      {
        title: "Receive & Allocate",
        href: "/dashboard/warehouse/allocation",
        icon: "chart-bar-increasing",
        description: "Register incoming batches and get recommended storage locations.",
      },
      {
        title: "Movements",
        href: "/dashboard/warehouse/movements",
        icon: "refresh-cw",
        description: "History of receipts, transfers, dispatches, adjustments and disposals.",
      },
    ],
  },
  {
    title: "Pharmacy",
    href: "/dashboard/pharmacy",
    icon: "pharmacy",
    description: "Pharmacy stock, receiving, POS billing, returns and rule-based reorder recommendations.",
    // Sub-pages with `roles` are shown only to those roles (see visibleNav()).
    items: [
      {
        title: "Overview",
        href: "/dashboard/pharmacy",
        icon: "pharmacy",
        roles: PHARMACY_ROLES,
        description: "Stock value, low stock, near expiry, shipments, today's sales and reorder recommendations.",
      },
      {
        title: "Inventory",
        href: "/dashboard/pharmacy/inventory",
        icon: "activity",
        roles: PHARMACY_ROLES,
        description: "Products with batch-level quantities, expiry dates, manufacturers and stock status.",
      },
      {
        title: "Receiving",
        href: "/dashboard/pharmacy/receiving",
        icon: "qr-code",
        roles: PHARMACY_ROLES,
        description: "Check delivered shipments against the order, confirm receipt or report disputed items.",
      },
      {
        title: "Discrepancies",
        href: "/dashboard/pharmacy/discrepancies",
        icon: "badge-alert",
        roles: PHARMACY_ROLES,
        description: "Missing, excess, damaged or incorrect items reported to the warehouse.",
      },
      {
        title: "Sales / POS",
        href: "/dashboard/pharmacy/pos",
        icon: "shopping-cart",
        roles: PHARMACY_ROLES,
        description: "Scan medicines, bill customers and update stock, with FEFO batch suggestions.",
      },
      {
        title: "Orders",
        href: "/dashboard/pharmacy/orders",
        icon: "chart-bar-increasing",
        roles: PHARMACY_ROLES,
        description: "Order from the warehouse with recommended reorder quantities (Q*).",
      },
      {
        title: "Returns",
        href: "/dashboard/pharmacy/returns",
        icon: "refresh-cw",
        roles: PHARMACY_ROLES,
        description: "Return expired, damaged or excess stock to the warehouse.",
      },
      {
        title: "Analytics",
        href: "/dashboard/pharmacy/analytics",
        icon: "trending-up",
        roles: PHARMACY_ROLES,
        description: "Burn rate, stock cover, moving-average demand and recommended Q*.",
      },
      {
        title: "Alerts",
        href: "/dashboard/pharmacy/alerts",
        icon: "bell",
        roles: PHARMACY_ROLES,
        description: "Low stock, reorder, near-expiry and expired stock.",
      },
      {
        title: "Research",
        href: "/dashboard/pharmacy/research",
        icon: "chart-column-increasing",
        roles: PHARMACY_ROLES,
        description: "Actual vs estimated demand, stockouts, expiry, turnover and recommendation acceptance.",
      },
      {
        title: "Settings",
        href: "/dashboard/pharmacy/settings",
        icon: "settings",
        roles: PHARMACY_ROLES,
        description: "Pharmacy profile, reorder thresholds, lead times and user access.",
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

// The navigation a role can use: sub-pages with `roles` are shown only to
// those roles; a module whose own page is hidden opens its first visible page.
export function visibleNav(role) {
  return dashboardNav
    .map((item) => {
      if (!item.items) return item;
      const items = item.items.filter((sub) => !sub.roles || sub.roles.includes(role));
      if (items.length === 0) return null;
      const href = items.some((sub) => sub.href === item.href) ? item.href : items[0].href;
      return { ...item, href, items };
    })
    .filter(Boolean);
}

export function isActivePath(pathname, href) {
  if (href === "/dashboard") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}
