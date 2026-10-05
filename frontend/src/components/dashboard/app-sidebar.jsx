"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatedIcon } from "@/components/icons/animated-icon";
import { ChevronRightIcon } from "@/components/icons/chevron-right";
import { MapPinIcon } from "@/components/icons/map-pin";
import { SyringeIcon } from "@/components/icons/syringe";
import { dashboardNav, isActivePath } from "@/lib/navigation";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";

export function AppSidebar() {
  const pathname = usePathname();
  const { isMobile, setOpenMobile } = useSidebar();

  // Close the mobile drawer after choosing a page.
  const handleNavigate = () => {
    if (isMobile) setOpenMobile(false);
  };

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              render={<Link href="/dashboard" onClick={handleNavigate} />}
            >
              <span className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <AnimatedIcon icon={SyringeIcon} />
              </span>
              <span className="grid flex-1 text-left leading-tight">
                <span className="truncate font-semibold">PharmaTwin</span>
                <span className="truncate text-xs text-muted-foreground">
                  Intelligent Warehouse
                </span>
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Platform</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {dashboardNav.map((item) =>
                item.items ? (
                  <NavSection
                    key={item.href}
                    item={item}
                    pathname={pathname}
                    onNavigate={handleNavigate}
                  />
                ) : (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      isActive={isActivePath(pathname, item.href)}
                      tooltip={item.title}
                      render={<Link href={item.href} onClick={handleNavigate} />}
                    >
                      <AnimatedIcon icon={item.icon} />
                      <span>{item.title}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Region: Sri Lanka" className="pointer-events-none">
              <AnimatedIcon icon={MapPinIcon} />
              <span>Region: Sri Lanka</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

// A module with sub-pages: the main button opens its first page, the chevron
// expands or collapses the list. It opens automatically when one of its pages
// becomes active.
function NavSection({ item, pathname, onNavigate }) {
  const sectionActive = isActivePath(pathname, item.href);
  const [open, setOpen] = useState(sectionActive);
  const [wasActive, setWasActive] = useState(sectionActive);
  if (sectionActive !== wasActive) {
    setWasActive(sectionActive);
    if (sectionActive) setOpen(true);
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      render={<SidebarMenuItem />}
    >
      <SidebarMenuButton
        isActive={sectionActive}
        tooltip={item.title}
        render={<Link href={item.href} onClick={onNavigate} />}
      >
        <AnimatedIcon icon={item.icon} />
        <span>{item.title}</span>
      </SidebarMenuButton>
      <CollapsibleTrigger
        render={
          <SidebarMenuAction className="transition-transform data-panel-open:rotate-90" />
        }
      >
        <AnimatedIcon icon={ChevronRightIcon} />
        <span className="sr-only">Toggle {item.title}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <SidebarMenuSub>
          {item.items.map((sub) => (
            <SidebarMenuSubItem key={sub.href}>
              <SidebarMenuSubButton
                isActive={pathname === sub.href}
                render={<Link href={sub.href} onClick={onNavigate} />}
              >
                <span>{sub.title}</span>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          ))}
        </SidebarMenuSub>
      </CollapsibleContent>
    </Collapsible>
  );
}
