export function formatDate(value) {
  return new Date(value).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

// Friendlier names where the built-in ones are awkward (e.g. "Congo - Kinshasa").
const COUNTRY_NAME_OVERRIDES = { CD: "DR Congo", CG: "Congo" };

// ISO country code -> name, e.g. "LK" -> "Sri Lanka".
export function formatCountry(code) {
  if (!code) return null;
  const upper = code.trim().toUpperCase();
  if (COUNTRY_NAME_OVERRIDES[upper]) return COUNTRY_NAME_OVERRIDES[upper];
  try {
    return regionNames.of(upper);
  } catch {
    return code;
  }
}

const languageNames = new Intl.DisplayNames(["en"], { type: "language" });

// ISO language code -> name, e.g. "si" -> "Sinhala".
export function formatLanguage(code) {
  if (!code) return null;
  try {
    return languageNames.of(code.trim());
  } catch {
    return code;
  }
}

export function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatPercent(value) {
  return `${value > 0 ? "+" : ""}${value}%`;
}
