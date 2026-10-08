// /api/medicines - shared medicine master data.

const express = require("express");
const store = require("../store");
const { HttpError, unwrap } = require("../errors");
const { rules, validate, toColumns } = require("../validation");
const { requireAdmin } = require("../auth");
const { toMedicine } = require("../mappers");
const { STORAGE_CONDITIONS } = require("../constants");

const router = express.Router();
const { supabase } = store;

const COLUMNS = {
  name: "name",
  genericName: "generic_name",
  medicineCategoryId: "medicine_category_id",
  dosageForm: "dosage_form",
  strength: "strength",
  unit: "unit",
  storageCondition: "storage_condition",
  isControlled: "is_controlled",
  isActive: "is_active",
};

function medicineSchema(creating) {
  return {
    name: rules.string({ required: creating, max: 200 }),
    genericName: rules.string({ max: 200, nullable: true }),
    medicineCategoryId: rules.uuid({ nullable: true }),
    dosageForm: rules.string({ max: 80, nullable: true }),
    strength: rules.string({ max: 80, nullable: true }),
    unit: rules.string({ max: 40 }),
    storageCondition: rules.oneOf(STORAGE_CONDITIONS),
    isControlled: rules.bool(),
    isActive: rules.bool(),
  };
}

// GET /api/medicines?q=&active=
router.get("/", async (req, res) => {
  const { q, active } = validate(req.query, { q: rules.string({ max: 100 }), active: rules.bool() });
  const rows = await store.fetchAll(() => supabase.from("medicines").select(store.MEDICINE_SELECT).order("id"));
  const needle = q?.toLowerCase();
  const medicines = rows
    .map(toMedicine)
    .filter((m) => active === undefined || m.isActive === active)
    .filter((m) => !needle || m.name.toLowerCase().includes(needle) || m.genericName?.toLowerCase().includes(needle))
    .sort((a, b) => store.naturalCompare(a.name, b.name) || store.naturalCompare(a.strength ?? "", b.strength ?? ""));
  res.json({ medicines });
});

// GET /api/medicines/categories - Component 1's medicine categories, for forms.
router.get("/categories", async (_req, res) => {
  const rows = unwrap(await supabase.from("medicine_categories").select("id, name").order("name"));
  res.json({ categories: rows });
});

router.get("/:id", async (req, res) => {
  const { id } = validate(req.params, { id: rules.uuid({ required: true }) });
  res.json({ medicine: toMedicine(await store.getMedicine(id)) });
});

router.post("/", requireAdmin, async (req, res) => {
  const values = validate(req.body, medicineSchema(true));
  const row = unwrap(
    await supabase.from("medicines").insert(toColumns(values, COLUMNS)).select(store.MEDICINE_SELECT).single()
  );
  res.status(201).json({ medicine: toMedicine(row) });
});

router.patch("/:id", requireAdmin, async (req, res) => {
  const { id } = validate(req.params, { id: rules.uuid({ required: true }) });
  const values = validate(req.body, medicineSchema(false));
  if (Object.keys(values).length === 0) throw new HttpError(400, "Nothing to update");
  const row = unwrap(
    await supabase.from("medicines").update(toColumns(values, COLUMNS)).eq("id", id).select(store.MEDICINE_SELECT).maybeSingle()
  );
  if (!row) throw new HttpError(404, "Medicine not found");
  res.json({ medicine: toMedicine(row) });
});

module.exports = router;
