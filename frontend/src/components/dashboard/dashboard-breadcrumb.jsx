"use client";

import { Fragment } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { getNavItem } from "@/lib/navigation";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

// Builds the trail: Dashboard > Module > Page (e.g. Medicine Impact > Events).
function getTrail(pathname) {
  const trail = [{ title: "Dashboard", href: "/dashboard" }];
  const current = getNavItem(pathname);
  if (!current || current.href === "/dashboard") return trail;

  if (current.parent) {
    trail.push({ title: current.parent.title, href: current.parent.href });
    // The module's overview page is the module itself.
    if (current.href !== current.parent.href) {
      trail.push({ title: current.title, href: current.href });
    }
  } else {
    trail.push({ title: current.title, href: current.href });
  }
  return trail;
}

export function DashboardBreadcrumb() {
  const trail = getTrail(usePathname());

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {trail.map((crumb, index) => {
          const isLast = index === trail.length - 1;
          // On small screens show only the current page.
          const hideOnMobile = !isLast && "hidden sm:inline-flex";
          return (
            <Fragment key={crumb.href + index}>
              {index > 0 && <BreadcrumbSeparator className={hideOnMobile || undefined} />}
              <BreadcrumbItem className={hideOnMobile || undefined}>
                {isLast ? (
                  <BreadcrumbPage>{crumb.title}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink render={<Link href={crumb.href} />}>
                    {crumb.title}
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
