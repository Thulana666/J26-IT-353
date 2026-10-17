import { getPharmacyContext } from "@/lib/pharmacy/page-data";
import { RealtimeRefresh } from "@/components/pharmacy/realtime-refresh";

// Live refresh for rows of the current pharmacy. all: no pharmacy filter
// (warehouse pages); RLS still limits what each user receives.
export async function PharmacyRealtime({ tables, all = false }) {
  const [context] = await getPharmacyContext();
  const pharmacyId = context?.currentPharmacy?.id;
  if (!all && !pharmacyId) return null;
  return <RealtimeRefresh tables={tables} filter={all ? undefined : `pharmacy_id=eq.${pharmacyId}`} />;
}
