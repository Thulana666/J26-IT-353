import { AnimatedIcon } from "@/components/icons/animated-icon";
import { BadgeAlertIcon } from "@/components/icons/badge-alert";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { packagingLabel, productLabel } from "@/lib/pharmacy/format";
import { cn } from "@/lib/utils";

// Leading cell of item tables: the medicine first (name and strength), then
// brand and packaging; children add secondary details such as reference numbers.
export function ProductSummary({ product, fallback = "Unknown item", children }) {
  const details = product ? [product.brandName, packagingLabel(product)].filter(Boolean).join(" · ") : null;
  return (
    <div className="min-w-0">
      <div className="font-medium">{product ? productLabel(product) : <span className="italic">{fallback}</span>}</div>
      {details && <div className="text-xs text-muted-foreground">{details}</div>}
      {children}
    </div>
  );
}

// Small secondary reference such as a shipment or report number.
export function RefTag({ children, className }) {
  return <span className={cn("rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-muted-foreground", className)}>{children}</span>;
}

// Shown when a pharmacy page cannot load its data from the backend.
export function LoadError({ title = "Pharmacy data could not be loaded", message }) {
  return (
    <Alert variant="destructive">
      <AnimatedIcon icon={BadgeAlertIcon} className="row-span-2 translate-y-0.5" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

export function EmptyState({ title, children, className }) {
  return (
    <div className={cn("rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground", className)}>
      <p className="font-medium text-foreground">{title}</p>
      {children && <div className="mt-1">{children}</div>}
    </div>
  );
}

// Explains that figures include synthetic seeded data (never real findings).
export function DataNote({ children, tone = "violet" }) {
  const tones = {
    violet: "border-violet-200 bg-violet-50 text-violet-900",
    amber: "border-amber-200 bg-amber-50 text-amber-900",
    blue: "border-sky-200 bg-sky-50 text-sky-900",
  };
  return <div className={cn("rounded-lg border px-3 py-2 text-sm", tones[tone])}>{children}</div>;
}

export function DefinitionList({ items, className }) {
  return (
    <dl className={cn("grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm", className)}>
      {items
        .filter(([, value]) => value !== undefined)
        .map(([term, value]) => (
          <div key={term} className="contents">
            <dt className="text-muted-foreground">{term}</dt>
            <dd className="min-w-0 break-words">{value ?? "—"}</dd>
          </div>
        ))}
    </dl>
  );
}

export const statGrid = "grid gap-4 grid-cols-2 lg:grid-cols-4";
