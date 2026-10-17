import { getPharmacyContext } from "@/lib/pharmacy/page-data";
import { PharmacyToolbar } from "@/components/pharmacy/pharmacy-toolbar";

// Pharmacy module (Component 4). The toolbar needs the pharmacy context; when
// the backend is unreachable the page itself shows the error.
export default async function PharmacyLayout({ children }) {
  const [context] = await getPharmacyContext();
  return (
    <>
      {context && <PharmacyToolbar context={context} />}
      {children}
    </>
  );
}
