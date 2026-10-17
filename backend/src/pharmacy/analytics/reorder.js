// Rule-based reorder recommendation (Q*):
//
//   inventory position (IP) = usable on hand + confirmed incoming - reserved
//   reorder point (ROP)     = forecast demand during the lead time + safety stock
//   target stock (S)        = forecast demand during lead time + review period + safety stock
//   recommended Q*          = max(0, S - IP)
//
// then rounded up to whole warehouse packs, raised to the minimum order and
// limited by the storage capacity. IP <= ROP means "reorder now". This is a
// transparent order-up-to rule, NOT the classical Economic Order Quantity
// (EOQ = sqrt(2DS/H)): ordering and holding costs are not modelled.
//
// All quantities are in dispensing units unless named packs.

const { mean, normalQuantile, round } = require("./stats");

// Demand of forecast days [from, to) (day 0 = today).
const demandBetween = (forecast, from, to) => {
  const level = mean(forecast) ?? 0;
  let total = 0;
  for (let day = from; day < to; day++) total += forecast[day] ?? level;
  return total;
};

// Safety stock for the configured method. The service-level method covers
// demand variability over lead time + review period (stock is only reviewed
// every review period).
function safetyStock({ method, serviceLevel, safetyDays, safetyUnits, dailyDemand, demandSd, leadTimeDays, reviewPeriodDays }) {
  if (method === "fixed_units") {
    const value = safetyUnits ?? 0;
    return { value, method, description: `fixed ${value} units` };
  }
  if (method === "days_of_cover") {
    const days = safetyDays ?? 0;
    return { value: days * dailyDemand, method, description: `${days} days x ${round(dailyDemand)} units/day` };
  }
  const z = normalQuantile(serviceLevel);
  const protectionDays = leadTimeDays + reviewPeriodDays;
  return {
    value: Math.max(0, z * demandSd * Math.sqrt(protectionDays)),
    method: "service_level",
    z,
    description: `z ${round(z)} (${round(serviceLevel * 100, 1)}% service level) x daily sd ${round(demandSd)} x sqrt(${protectionDays} days)`,
  };
}

function computeReorder({
  forecast,
  demandSd,
  leadTimeDays,
  reviewPeriodDays,
  safety,
  onHandUsable,
  reserved,
  incoming,
  unitsPerPack = 1,
  minOrderPacks = 1,
  maxStockUnits = null,
}) {
  const dailyDemand = mean(forecast.slice(0, Math.max(1, leadTimeDays + reviewPeriodDays))) ?? 0;
  const leadTimeDemand = demandBetween(forecast, 0, leadTimeDays);
  const reviewPeriodDemand = demandBetween(forecast, leadTimeDays, leadTimeDays + reviewPeriodDays);
  const ss = safetyStock({ ...safety, dailyDemand, demandSd, leadTimeDays, reviewPeriodDays });
  const reorderPoint = leadTimeDemand + ss.value;
  const targetStock = leadTimeDemand + reviewPeriodDemand + ss.value;
  const inventoryPosition = onHandUsable + incoming - reserved;
  const needsReorder = inventoryPosition <= reorderPoint && targetStock > 0;
  const rawQuantity = Math.max(0, targetStock - inventoryPosition);

  const constraints = [];
  let packs = 0;
  if (rawQuantity > 0) {
    packs = Math.ceil(rawQuantity / unitsPerPack);
    if (packs * unitsPerPack !== Math.ceil(rawQuantity)) {
      constraints.push({
        type: "pack_size",
        detail: `Rounded ${Math.ceil(rawQuantity)} units up to ${packs} whole pack(s) of ${unitsPerPack}`,
      });
    }
    if (packs < minOrderPacks) {
      constraints.push({ type: "minimum_order", detail: `Raised from ${packs} to the minimum order of ${minOrderPacks} pack(s)` });
      packs = minOrderPacks;
    }
    if (maxStockUnits) {
      const roomPacks = Math.max(0, Math.floor((maxStockUnits - inventoryPosition) / unitsPerPack));
      if (packs > roomPacks) {
        constraints.push({
          type: "storage_capacity",
          detail: `Limited from ${packs} to ${roomPacks} pack(s) by the storage capacity of ${maxStockUnits} units`,
        });
        packs = roomPacks;
      }
    }
  }

  return {
    dailyDemand,
    leadTimeDemand,
    reviewPeriodDemand,
    safetyStock: ss.value,
    safety: ss,
    reorderPoint,
    targetStock,
    inventoryPosition,
    needsReorder,
    rawQuantity,
    recommendedPacks: packs,
    recommendedUnits: packs * unitsPerPack,
    constraints,
  };
}

// Plain-language explanation of a recommendation.
function explain({ result, unitLabel, packLabel, windowDays, leadTimeDays, reviewPeriodDays, onHandUsable, incoming, reserved }) {
  const n = (value) => Math.round(value).toLocaleString("en-US");
  const parts = [
    `Moving-average demand is ${round(result.dailyDemand, 1)} ${unitLabel}/day (units sold in the last ${windowDays} days / ${windowDays}).`,
    `Demand over the ${leadTimeDays}-day lead time: ${n(result.leadTimeDemand)}; over the following ${reviewPeriodDays}-day review period: ${n(result.reviewPeriodDemand)}.`,
    `Safety stock ${n(result.safetyStock)} (${result.safety.description}).`,
    `Reorder point = ${n(result.leadTimeDemand)} + ${n(result.safetyStock)} = ${n(result.reorderPoint)}; target stock = ${n(result.leadTimeDemand)} + ${n(result.reviewPeriodDemand)} + ${n(result.safetyStock)} = ${n(result.targetStock)}.`,
    `Inventory position = ${n(onHandUsable)} usable on hand + ${n(incoming)} incoming - ${n(reserved)} reserved = ${n(result.inventoryPosition)}.`,
    `Q* = max(0, ${n(result.targetStock)} - ${n(result.inventoryPosition)}) = ${n(result.rawQuantity)} units.`,
  ];
  if (result.recommendedPacks > 0) {
    parts.push(`Order ${result.recommendedPacks} ${packLabel} (${n(result.recommendedUnits)} ${unitLabel}).`);
  } else {
    parts.push("No order needed.");
  }
  parts.push(
    result.needsReorder
      ? "The position is at or below the reorder point: reorder now."
      : "The position is above the reorder point: this quantity can wait for the next review."
  );
  for (const constraint of result.constraints) parts.push(`${constraint.detail}.`);
  return parts.join(" ");
}

module.exports = { safetyStock, computeReorder, explain, demandBetween };
