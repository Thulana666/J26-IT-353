// Database rows -> API objects (camelCase).

const { daysBetween, expiryStatus, CRITICAL_EXPIRY_DAYS } = require("./dates");

const money = (value) => (value === null || value === undefined ? null : Number(value));
const decimal = (value) => (value === null || value === undefined ? null : Number(value));

function toProduct(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    genericName: row.generic_name ?? null,
    brandName: row.brand_name ?? null,
    manufacturer: row.manufacturer ?? null,
    strength: row.strength ?? null,
    dosageForm: row.dosage_form ?? null,
    packUnit: row.unit ?? null,
    dispensingUnit: row.dispensing_unit ?? null,
    unitsPerPack: row.units_per_pack ?? 1,
    unitCost: money(row.unit_cost),
    retailPrice: money(row.retail_price),
    storageCondition: row.storage_condition ?? null,
    isControlled: row.is_controlled ?? false,
    isActive: row.is_active ?? true,
    category: row.category?.name ?? null,
  };
}

// A row of pharmacy_inventory_overview.
function toStockRow(row, today, nearExpiryDays) {
  const status = expiryStatus(row.expiry_date, today, nearExpiryDays);
  return {
    inventoryId: row.inventory_id,
    pharmacyId: row.pharmacy_id,
    batchId: row.batch_id,
    batchNumber: row.batch_number,
    manufacturingDate: row.manufacturing_date,
    expiryDate: row.expiry_date,
    daysToExpiry: daysBetween(today, row.expiry_date),
    expiryStatus: status,
    batchStatus: row.batch_status,
    supplier: row.supplier,
    quantityOnHand: row.quantity_on_hand,
    quantityReserved: row.quantity_reserved,
    // Held by discrepancy reports (0 before the holds migration).
    quantityHeld: row.quantity_held ?? 0,
    quantityAvailable: row.quantity_available,
    unitCost: money(row.unit_cost),
    unitPrice: money(row.unit_price),
    // Can be sold now: active, unexpired, with unreserved stock and a price.
    sellable:
      row.batch_status === "active" && status !== "expired" && row.quantity_available > 0 && row.unit_price !== null,
    firstReceivedAt: row.first_received_at,
    lastReceivedAt: row.last_received_at,
    updatedAt: row.updated_at,
    product: {
      id: row.medicine_id,
      name: row.medicine_name,
      genericName: row.generic_name,
      brandName: row.brand_name,
      manufacturer: row.manufacturer,
      strength: row.strength,
      dosageForm: row.dosage_form,
      dispensingUnit: row.dispensing_unit,
      packUnit: row.pack_unit,
      unitsPerPack: row.units_per_pack,
      storageCondition: row.storage_condition,
      isControlled: row.is_controlled,
    },
  };
}

function toPharmacy(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    warehouseId: row.warehouse_id,
    locationId: row.location_id,
    address: row.address,
    phone: row.phone,
    licenseNumber: row.license_number,
    defaultLeadTimeDays: row.default_lead_time_days,
    defaultReviewPeriodDays: row.default_review_period_days,
    defaultServiceLevel: decimal(row.default_service_level),
    burnRateWindowDays: row.burn_rate_window_days,
    nearExpiryDays: row.near_expiry_days,
    taxRatePercent: decimal(row.tax_rate_percent),
    maxDiscountPercent: decimal(row.max_discount_percent),
    currency: row.currency,
    isActive: row.is_active,
  };
}

function toOrder(row, names = new Map()) {
  return {
    id: row.id,
    orderNumber: row.order_number,
    pharmacyId: row.pharmacy_id,
    pharmacyName: row.pharmacy?.name ?? null,
    status: row.status,
    notes: row.notes,
    createdBy: names.get(row.created_by) ?? null,
    submittedAt: row.submitted_at,
    dispatchedAt: row.dispatched_at,
    receivedAt: row.received_at,
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
    items: (row.items ?? []).map((item) => ({
      id: item.id,
      quantityOrdered: item.quantity_ordered,
      recommendationId: item.recommendation_id,
      notes: item.notes,
      product: toProduct(item.medicine),
    })),
    shipment: row.shipment
      ? { id: row.shipment.id, shipmentNumber: row.shipment.shipment_number, status: row.shipment.status }
      : null,
  };
}

function toShipment(row, names = new Map()) {
  return {
    id: row.id,
    shipmentNumber: row.shipment_number,
    orderId: row.order_id,
    orderNumber: row.purchase_order?.order_number ?? null,
    pharmacyId: row.pharmacy_id,
    pharmacyName: row.pharmacy?.name ?? null,
    status: row.status,
    dispatchedBy: names.get(row.dispatched_by) ?? null,
    dispatchedAt: row.dispatched_at,
    receivedBy: names.get(row.received_by) ?? null,
    receivedAt: row.received_at,
    notes: row.notes,
    receiptNotes: row.receipt_notes,
    items: (row.items ?? []).map((item) => ({
      id: item.id,
      orderItemId: item.order_item_id,
      quantityOrdered: item.order_item?.quantity_ordered ?? null,
      quantityShipped: item.quantity_shipped,
      unitsPerPack: item.units_per_pack,
      quantityReceived: item.quantity_received,
      quantityDamaged: item.quantity_damaged,
      quantityAccepted: item.quantity_accepted,
      unitCost: money(item.unit_cost),
      unitPrice: money(item.unit_price),
      verificationStatus: item.verification_status,
      scanCount: item.scan_count,
      acceptedAt: item.accepted_at ?? null,
      batch: item.batch
        ? {
            id: item.batch.id,
            batchNumber: item.batch.batch_number,
            manufacturingDate: item.batch.manufacturing_date,
            expiryDate: item.batch.expiry_date,
            status: item.batch.status,
          }
        : null,
      product: toProduct(item.medicine),
    })),
  };
}

function toDiscrepancy(row, names = new Map()) {
  return {
    id: row.id,
    reportNumber: row.report_number,
    shipmentId: row.shipment_id,
    shipmentNumber: row.shipment?.shipment_number ?? null,
    orderId: row.order_id,
    orderNumber: row.purchase_order?.order_number ?? null,
    pharmacyId: row.pharmacy_id,
    pharmacyName: row.pharmacy?.name ?? null,
    shipmentItemId: row.shipment_item_id,
    product: toProduct(row.medicine),
    batchNumber: row.batch?.batch_number ?? null,
    observedBarcode: row.observed_barcode,
    observedBatchNumber: row.observed_batch_number,
    type: row.discrepancy_type,
    expectedQuantity: row.expected_quantity,
    actualQuantity: row.actual_quantity,
    notes: row.notes,
    status: row.status,
    resolutionNotes: row.resolution_notes,
    reportedBy: names.get(row.reported_by) ?? null,
    reportedAt: row.reported_at,
    acknowledgedAt: row.acknowledged_at,
    resolvedBy: names.get(row.resolved_by) ?? null,
    resolvedAt: row.resolved_at,
    // Units of stock currently held by this report (see attachHolds()).
    heldUnits: row.held_units ?? 0,
  };
}

function toSale(row, names = new Map()) {
  return {
    id: row.id,
    saleNumber: row.sale_number,
    pharmacyId: row.pharmacy_id,
    source: row.source,
    subtotal: money(row.subtotal),
    discountPercent: decimal(row.discount_percent),
    discountAmount: money(row.discount_amount),
    taxPercent: decimal(row.tax_percent),
    taxAmount: money(row.tax_amount),
    totalAmount: money(row.total_amount),
    paymentMethod: row.payment_method,
    amountTendered: money(row.amount_tendered),
    changeDue: money(row.change_due),
    paymentReference: row.payment_reference,
    customerRef: row.customer_ref,
    servedBy: names.get(row.served_by) ?? null,
    soldAt: row.sold_at,
    itemCount: row.items?.length ?? null,
    items: (row.items ?? []).map((item) => ({
      id: item.id,
      quantity: item.quantity,
      unitPrice: money(item.unit_price),
      lineTotal: money(item.line_total),
      fefoCompliant: item.fefo_compliant,
      batchNumber: item.batch?.batch_number ?? null,
      expiryDate: item.batch?.expiry_date ?? null,
      product: toProduct(item.medicine),
    })),
  };
}

function toReturn(row, names = new Map()) {
  return {
    id: row.id,
    returnNumber: row.return_number,
    pharmacyId: row.pharmacy_id,
    pharmacyName: row.pharmacy?.name ?? null,
    status: row.status,
    notes: row.notes,
    requestedBy: names.get(row.requested_by) ?? null,
    requestedAt: row.requested_at,
    reviewedBy: names.get(row.reviewed_by) ?? null,
    reviewedAt: row.reviewed_at,
    reviewNotes: row.review_notes,
    receivedBy: names.get(row.received_by) ?? null,
    receivedAt: row.received_at,
    receiptNotes: row.receipt_notes,
    items: (row.items ?? []).map((item) => ({
      id: item.id,
      inventoryId: item.inventory_id,
      quantity: item.quantity,
      reason: item.reason,
      notes: item.notes,
      restockedPacks: item.restocked_packs,
      batch: item.batch
        ? { id: item.batch.id, batchNumber: item.batch.batch_number, expiryDate: item.batch.expiry_date, status: item.batch.status }
        : null,
      product: toProduct(item.medicine),
    })),
  };
}

function toRecommendation(row, names = new Map()) {
  return {
    id: row.id,
    runId: row.run_id,
    medicineId: row.medicine_id,
    product: row.medicine ? toProduct(row.medicine) : null,
    modelName: row.model_name,
    isProvisional: row.is_provisional,
    burnRate: decimal(row.burn_rate),
    forecastDailyDemand: decimal(row.forecast_daily_demand),
    leadTimeDays: row.lead_time_days,
    reviewPeriodDays: row.review_period_days,
    leadTimeDemand: decimal(row.lead_time_demand),
    reviewPeriodDemand: decimal(row.review_period_demand),
    safetyStock: decimal(row.safety_stock),
    reorderPoint: decimal(row.reorder_point),
    targetStock: decimal(row.target_stock),
    onHandUsable: row.on_hand_usable,
    reserved: row.reserved,
    incoming: row.incoming,
    inventoryPosition: decimal(row.inventory_position),
    daysOfCover: decimal(row.days_of_cover),
    projectedStockoutDate: row.projected_stockout_date,
    stockoutRisk: row.stockout_risk,
    expiryRiskUnits: row.expiry_risk_units,
    needsReorder: row.needs_reorder,
    rawQuantity: decimal(row.raw_quantity),
    recommendedUnits: row.recommended_units,
    recommendedPacks: row.recommended_packs,
    constraintsApplied: row.constraints_applied ?? [],
    explanation: row.explanation,
    assumptions: row.assumptions ?? {},
    status: row.status,
    decidedPacks: row.decided_packs,
    decidedBy: names.get(row.decided_by) ?? null,
    decidedAt: row.decided_at,
    decisionNotes: row.decision_notes,
    orderId: row.order_id,
    generatedAt: row.generated_at,
  };
}

function toAlert(row) {
  return {
    id: row.id,
    pharmacyId: row.pharmacy_id,
    medicineId: row.medicine_id,
    batchId: row.batch_id,
    productName: row.medicine?.name ?? null,
    productStrength: row.medicine?.strength ?? null,
    batchNumber: row.batch?.batch_number ?? null,
    type: row.alert_type,
    severity: row.severity,
    title: row.title,
    message: row.message,
    details: row.details ?? {},
    status: row.status,
    acknowledgedAt: row.acknowledged_at,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMovement(row, names = new Map()) {
  return {
    id: row.id,
    type: row.movement_type,
    onHandChange: row.on_hand_change,
    reservedChange: row.reserved_change,
    onHandAfter: row.on_hand_after,
    reservedAfter: row.reserved_after,
    heldChange: row.held_change ?? 0,
    heldAfter: row.held_after ?? 0,
    referenceType: row.reference_type,
    referenceId: row.reference_id,
    notes: row.notes,
    performedBy: names.get(row.performed_by) ?? null,
    batchNumber: row.batch?.batch_number ?? null,
    createdAt: row.created_at,
  };
}

module.exports = {
  money,
  decimal,
  expiryStatus,
  CRITICAL_EXPIRY_DAYS,
  toProduct,
  toStockRow,
  toPharmacy,
  toOrder,
  toShipment,
  toDiscrepancy,
  toSale,
  toReturn,
  toRecommendation,
  toAlert,
  toMovement,
};
