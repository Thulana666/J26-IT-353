// FEFO (First Expiry, First Out) for pharmacy stock rows (toStockRow shape).
// Sellable batches first (active, unexpired, unreserved stock, priced), then
// the earliest expiry date; ties by batch number for a stable order.

function byFefo(a, b) {
  if (a.sellable !== b.sellable) return a.sellable ? -1 : 1;
  if (a.expiryDate !== b.expiryDate) return a.expiryDate < b.expiryDate ? -1 : 1;
  return a.batchNumber < b.batchNumber ? -1 : a.batchNumber > b.batchNumber ? 1 : 0;
}

// The batch the POS should sell: the scanned batch if it is sellable, else the
// earliest-expiring sellable batch; null when nothing can be sold.
function suggestBatch(batches, scannedBatchId = null) {
  const sellable = batches.filter((b) => b.sellable).sort(byFefo);
  if (scannedBatchId) {
    const scanned = sellable.find((b) => b.batchId === scannedBatchId);
    if (scanned) return scanned;
  }
  return sellable[0] ?? null;
}

module.exports = { byFefo, suggestBatch };
