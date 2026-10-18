import { getNavItem } from "@/lib/navigation";
import { warehouseApi } from "@/lib/warehouse/api";
import { ROLE_LABELS, formatDateTime } from "@/lib/warehouse/format";
import { getViewer, getWarehouses, safe } from "@/lib/warehouse/page-data";
import { updateStaffAction } from "@/app/dashboard/warehouse/config-actions";
import { PageHeader } from "@/components/dashboard/page-header";
import { ActionForm } from "@/components/warehouse/action-form";
import { LoadError } from "@/components/warehouse/load-error";
import { StaffAccessFields } from "@/components/warehouse/staff-access-fields";
import { StatusBadge } from "@/components/warehouse/warehouse-badges";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import styles from "@/components/warehouse/warehouse.module.css";

const page = getNavItem("/dashboard/warehouse/staff");

export const metadata = {
  title: "Staff | PharmaTwin",
};

// New accounts sign up themselves and start as "user" (no access) until an
// admin assigns a role here. Pharmacy staff belong to a pharmacy; warehouse
// staff to a warehouse; admins may have a home warehouse.
export default async function StaffPage() {
  const { user: viewer, isAdmin } = await getViewer();
  if (!isAdmin) {
    return (
      <>
        <PageHeader title="Staff" description={page.description} mock={false} />
        <LoadError title="Admins only" message="Ask an admin to change staff access." />
      </>
    );
  }
  const [[staff, error], [pharmacies], [warehouses]] = await Promise.all([
    safe(warehouseApi("/warehouse/staff").then((b) => b.staff)),
    safe(warehouseApi("/pharmacy/admin/pharmacies").then((b) => b.pharmacies)),
    safe(getWarehouses()),
  ]);
  const pharmacyName = new Map((pharmacies ?? []).map((p) => [p.id, p.name]));
  const warehouseName = new Map((warehouses ?? []).map((w) => [w.id, w.name]));

  function assignment(user) {
    if (user.role === "pharmacy_staff") return user.pharmacyId ? pharmacyName.get(user.pharmacyId) : "No pharmacy assigned";
    if (user.role === "warehouse_staff") return user.warehouseId ? warehouseName.get(user.warehouseId) : "No warehouse assigned";
    if (user.role === "admin") return user.warehouseId ? warehouseName.get(user.warehouseId) : "All warehouses";
    return null;
  }

  return (
    <>
      <PageHeader title="Staff and access" description={page.description} mock={false} />
      {error ? (
        <LoadError message={error} />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Accounts</CardTitle>
            <CardDescription>
              Warehouse staff can receive, move, pick and dispatch stock and handle reports and returns, and need a
              warehouse. Admins can also configure the warehouse, correct stock and change access. Pharmacy staff need
              a pharmacy. Inactive accounts cannot do anything.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead>Current access</TableHead>
                  <TableHead>Change</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {staff.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell>
                      <div className={styles.strong}>{u.fullName || u.email}</div>
                      <div className={`${styles.small} ${styles.muted}`}>
                        {u.email} · since {formatDateTime(u.createdAt)}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div>{ROLE_LABELS[u.role] ?? u.role}</div>
                      {assignment(u) && <div className={`${styles.small} ${styles.muted} ${styles.wrap}`}>{assignment(u)}</div>}
                      <StatusBadge status={u.status === "active" ? "resolved" : "rejected"} label={u.status} />
                    </TableCell>
                    <TableCell>
                      {u.id === viewer.id ? (
                        <span className={`${styles.small} ${styles.muted}`}>Your own account</span>
                      ) : (
                        <ActionForm action={updateStaffAction} submitLabel="Save" variant="outline" resetOnSuccess={false}>
                          <input type="hidden" name="userId" value={u.id} />
                          <StaffAccessFields user={u} pharmacies={pharmacies ?? []} warehouses={warehouses ?? []} />
                        </ActionForm>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </>
  );
}
