import { warehouseApi } from "@/lib/warehouse/api";

// Server-side client for the cold-chain API (backend/src/cold-chain). It is the
// warehouse client with the /cold-chain prefix: same token forwarding and
// errors (WarehouseApiError). Use only in Server Components and Server Actions.
//
// coldChainApi("/shipments/<id>/readings", { query: { limit: 720 } })
export function coldChainApi(path, options) {
  return warehouseApi(`/cold-chain${path}`, options);
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
