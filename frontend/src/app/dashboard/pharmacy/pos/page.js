import { pharmacyApi } from "@/lib/pharmacy/api";
import { getPharmacyContext, safe } from "@/lib/pharmacy/page-data";
import { PAYMENT_METHODS, formatDateTime, formatMoney } from "@/lib/pharmacy/format";
import { PageHeader } from "@/components/dashboard/page-header";
import { PosTerminal } from "@/components/pharmacy/pos-terminal";
import { LoadError } from "@/components/pharmacy/ui";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const metadata = { title: "Sales / POS | Pharmacy | PharmaTwin" };

export default async function PosPage() {
  const [[context, contextError], [sales, salesError]] = await Promise.all([
    getPharmacyContext(),
    safe(pharmacyApi("/pharmacy/sales", { query: { limit: 15, source: "pos" } })),
  ]);
  const pharmacy = context?.currentPharmacy;
  const error = contextError ?? salesError ?? (!pharmacy && context ? "Choose or create a pharmacy first." : null);

  return (
    <>
      <PageHeader title="Sales / POS" description="Scan or search medicines, bill the customer and update stock in one step." mock={false} />
      {error ? (
        <LoadError message={error} />
      ) : (
        <>
          <PosTerminal pharmacy={pharmacy} />
          <Card>
            <CardHeader>
              <CardTitle>Recent POS sales</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              {sales.sales.length === 0 ? (
                <p className="px-4 text-sm text-muted-foreground">No POS sales yet.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-4">Receipt</TableHead>
                      <TableHead>When</TableHead>
                      <TableHead>Items</TableHead>
                      <TableHead>Payment</TableHead>
                      <TableHead>Served by</TableHead>
                      <TableHead className="pr-4 text-right">Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sales.sales.map((s) => (
                      <TableRow key={s.id}>
                        <TableCell className="pl-4 font-mono text-xs">{s.saleNumber}</TableCell>
                        <TableCell className="text-xs">{formatDateTime(s.soldAt)}</TableCell>
                        <TableCell className="text-xs">{s.items.map((i) => `${i.quantity}× ${i.product?.name}`).join(", ")}</TableCell>
                        <TableCell className="text-xs">{PAYMENT_METHODS[s.paymentMethod]}</TableCell>
                        <TableCell className="text-xs">{s.servedBy ?? "—"}</TableCell>
                        <TableCell className="pr-4 text-right tabular-nums">{formatMoney(s.totalAmount)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}
