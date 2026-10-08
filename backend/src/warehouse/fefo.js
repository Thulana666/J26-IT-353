// FEFO (First Expiry, First Out): a deterministic business rule, not AI.
//
// Works on stock items (one batch at one location, see mappers.toStockItem).
// Eligible for outbound: active batch, not expired, in a storage zone, with
// stock. Eligible items are ordered by expiry date; ties fall back to the
// older manufacturing date, then the earlier receipt (FIFO), then the
// location nearest to dispatch.

function dispatchIneligibility(item, today) {
  if (!(item.quantity > 0)) return "No stock";
  if (item.batchStatus !== "active") return `Batch is ${item.batchStatus}`;
  if (item.expiryDate < today) return "Expired";
  if (item.zoneType !== "storage") return "Held in a quarantine zone";
  return null;
}

const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// Missing dates sort last.
const compareOptional = (a, b) => (a == null ? (b == null ? 0 : 1) : b == null ? -1 : compareText(a, b));

function compareFefo(a, b) {
  return (
    compareText(a.expiryDate, b.expiryDate) ||
    compareOptional(a.manufacturingDate, b.manufacturingDate) ||
    compareOptional(a.batchCreatedAt, b.batchCreatedAt) ||
    compareText(a.batchNumber, b.batchNumber) ||
    (a.distanceToDispatchM ?? 0) - (b.distanceToDispatchM ?? 0) ||
    compareText(a.locationCode ?? "", b.locationCode ?? "")
  );
}

// Splits items into eligible (FEFO order) and excluded (with the reason).
function splitByEligibility(items, today) {
  const eligible = [];
  const excluded = [];
  for (const item of items) {
    const reason = dispatchIneligibility(item, today);
    if (reason) excluded.push({ ...item, reason });
    else eligible.push(item);
  }
  eligible.sort(compareFefo);
  excluded.sort(compareFefo);
  return { eligible, excluded };
}

function rankFefo(items, today) {
  return splitByEligibility(items, today).eligible;
}

// Which stock to pick, in FEFO order, to fulfil `quantity` units.
function buildPickList(items, quantity, today) {
  const { eligible, excluded } = splitByEligibility(items, today);
  const lines = [];
  let remaining = quantity;
  for (const item of eligible) {
    if (remaining <= 0) break;
    const pickQuantity = Math.min(item.quantity, remaining);
    lines.push({ ...item, pickQuantity });
    remaining -= pickQuantity;
  }
  return {
    requested: quantity,
    allocated: quantity - remaining,
    shortfall: remaining,
    available: eligible.reduce((sum, item) => sum + item.quantity, 0),
    lines,
    excluded,
  };
}

// Is dispatching `batchId` FEFO-compliant, given all stock of the same
// medicine in the same warehouse? Batches expiring on the same day as the
// earliest eligible batch are compliant too.
function checkDispatchCompliance(items, batchId, today) {
  const eligible = rankFefo(items, today);
  const selected = items.find((item) => item.batchId === batchId);
  if (!selected || eligible.length === 0) {
    return { compliant: true, earliestExpiryDate: null, recommended: null };
  }
  const first = eligible[0];
  const compliant = selected.expiryDate <= first.expiryDate;
  return {
    compliant,
    earliestExpiryDate: first.expiryDate,
    recommended: compliant
      ? null
      : {
          batchId: first.batchId,
          batchNumber: first.batchNumber,
          expiryDate: first.expiryDate,
          storageLocationId: first.storageLocationId,
          locationCode: first.locationCode,
          quantity: first.quantity,
        },
  };
}

module.exports = {
  dispatchIneligibility,
  compareFefo,
  splitByEligibility,
  rankFefo,
  buildPickList,
  checkDispatchCompliance,
};
