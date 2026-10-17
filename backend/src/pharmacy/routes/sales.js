// /api/pharmacy/sales - POS checkout and receipts for the current pharmacy.
//
// POST /       checkout: { clientRequestId, items: [{ batchId, quantity }], discountPercent,
//              paymentMethod, amountTendered, paymentReference, customerRef }.
//              Prices and totals are computed by pharmacy_checkout(); a repeated
//              clientRequestId returns the first sale instead of selling twice.
// GET  /       recent sales (?date=YYYY-MM-DD&source=pos|synthetic_seed&limit=)
// GET  /:id    one sale (receipt)

const express = require("express");
const { supabase, today, addDays, rpc, userNames } = require("../store");
const { HttpError, unwrap } = require("../errors");
const { requirePharmacyStaff, pharmacyScope } = require("../auth");
const { parse, z, id, int, num, text, isoDate, optional } = require("../validation");
const { toSale } = require("../mappers");
const { refreshAlertsQuietly } = require("../analytics/service");
const { SALE_SELECT } = require("./common");

const router = express.Router();
router.use(requirePharmacyStaff, pharmacyScope);

async function loadSale(pharmacyId, saleId) {
  const row = unwrap(await supabase.from("sales").select(SALE_SELECT).eq("id", saleId).eq("pharmacy_id", pharmacyId).maybeSingle());
  if (!row) throw new HttpError(404, "Sale not found");
  return row;
}

const checkoutBody = z
  .object({
    clientRequestId: id,
    items: z.array(z.object({ batchId: id, quantity: int(1, 10_000) })).min(1, "the bill is empty").max(100),
    discountPercent: optional(num(0, 100)),
    paymentMethod: z.enum(["cash", "card", "mobile", "other"]),
    amountTendered: optional(num(0, 100_000_000)),
    paymentReference: text(100),
    customerRef: text(200),
  })
  .refine((body) => body.paymentMethod !== "cash" || body.amountTendered !== undefined, {
    message: "enter the cash received",
    path: ["amountTendered"],
  });

router.post("/", async (req, res) => {
  const body = parse(checkoutBody, req.body);
  const sale = await rpc("pharmacy_checkout", {
    p_pharmacy_id: req.pharmacy.id,
    p_user_id: req.user.id,
    p_client_request_id: body.clientRequestId,
    p_items: body.items,
    p_discount_percent: body.discountPercent ?? 0,
    p_payment_method: body.paymentMethod,
    p_amount_tendered: body.amountTendered ?? null,
    p_payment_reference: body.paymentReference ?? null,
    p_customer_ref: body.customerRef ?? null,
    p_today: today(),
  });
  refreshAlertsQuietly(req.pharmacy);
  const row = await loadSale(req.pharmacy.id, sale.id);
  const names = await userNames([row.served_by]);
  res.status(201).json({ sale: toSale(row, names) });
});

const listQuery = z.object({
  date: optional(isoDate),
  source: z.enum(["pos", "synthetic_seed"]).optional(),
  limit: optional(int(1, 200)),
});

router.get("/", async (req, res) => {
  const { date, source, limit = 50 } = parse(listQuery, req.query);
  let query = supabase.from("sales").select(SALE_SELECT).eq("pharmacy_id", req.pharmacy.id).order("sold_at", { ascending: false }).limit(limit);
  if (date) query = query.gte("sold_at", `${date}T00:00:00+05:30`).lt("sold_at", `${addDays(date, 1)}T00:00:00+05:30`);
  if (source) query = query.eq("source", source);
  const rows = unwrap(await query);
  const names = await userNames(rows.map((r) => r.served_by));
  res.json({ sales: rows.map((row) => toSale(row, names)) });
});

router.get("/:id", async (req, res) => {
  const { id: saleId } = parse(z.object({ id }), req.params);
  const row = await loadSale(req.pharmacy.id, saleId);
  const names = await userNames([row.served_by]);
  res.json({ sale: toSale(row, names) });
});

module.exports = router;
