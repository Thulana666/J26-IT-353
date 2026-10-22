// Pure helpers for the article processor: build the /event-intel/classify
// request, turn its response into a conservative Sri Lanka relevance decision,
// and describe the event (if any) an article should be linked to.
//
// The AI service already does the text work (frozen rules + DistilRoBERTa +
// hybrid). This module only combines its outputs; it never adds a supply-chain
// link, disease or location that the response does not contain.

// Limits of the AI service request schema (ai-service/event_intel/service/schemas.py).
const MAX_TITLE = 1_000;
const MAX_SUMMARY = 20_000;
const MAX_CONTENT = 100_000;

// The model is English-only (DistilRoBERTa fine-tuned on English news), and so
// are the rule lexicons.
const SUPPORTED_LANGUAGES = new Set(["en"]);

// Categories the pipeline turns into events. "other" never creates one.
const EVENT_TYPES = {
  public_health: (diseases) => (diseases.length > 0 ? "disease_outbreak" : "other"),
  natural_disaster: () => "natural_disaster",
  // Rules-only categories (the model cannot predict them): always reviewed.
  pharma_supply: () => "supply_disruption",
  logistics: () => "supply_disruption",
  geopolitical_trade: () => "economic",
};

const CATEGORY_LABELS = {
  public_health: "Public health",
  natural_disaster: "Natural disaster",
  pharma_supply: "Pharmaceutical supply",
  logistics: "Logistics",
  geopolitical_trade: "Geopolitical / trade",
  other: "Other",
};

// The rules report the matched word; "Indian" is their only adjective form (code IN).
const COUNTRY_NAME_FIXES = { Indian: "India" };
const countryName = (c) => COUNTRY_NAME_FIXES[c.name] ?? c.name;
const capitalise = (text) => text.charAt(0).toUpperCase() + text.slice(1);

const clip = (value, max) => (typeof value === "string" && value.length > max ? value.slice(0, max) : value ?? null);
const hasText = (value) => typeof value === "string" && value.trim().length > 0;

function buildRequest(article) {
  return {
    articleId: article.id,
    title: clip(article.title ?? "", MAX_TITLE),
    summary: clip(article.summary, MAX_SUMMARY),
    content: clip(article.content, MAX_CONTENT),
    url: article.url ?? null,
    publishedAt: article.published_at ?? null,
    language: article.language ?? null,
    countryCode: article.country_code ?? null,
    sourceName: article.source?.name ?? null,
    sourceType: article.source?.source_type ?? null,
    // Never let a rules-only answer be stored as a model result: a missing
    // model is a 501, which stops the run instead.
    requireModel: true,
  };
}

// Articles the service cannot meaningfully classify; recorded without a call.
function precheck(article) {
  if (![article.title, article.summary, article.content].some(hasText)) {
    return { relevance: "uncertain", reason: "No title, summary or content to analyse." };
  }
  const language = (article.language || "en").toLowerCase();
  if (!SUPPORTED_LANGUAGES.has(language)) {
    return {
      relevance: "uncertain",
      reason: `Language '${language}' is not supported by the English-only model and rules; needs a human reader.`,
    };
  }
  return null;
}

// Sri Lanka relevance from the rules evidence and the final (hybrid) category.
// The rules decide relevance from their own category; when the hybrid category
// disagrees, the result is downgraded to uncertain rather than guessed.
function assessRelevance(response) {
  const rules = response.rules ?? {};
  const category = response.hybrid?.category ?? rules.category ?? "other";
  const links = (rules.sri_lanka_links ?? []).map((l) => `${l.rule} (${l.detail})`).join("; ");
  const isEvent = category !== "other";

  switch (rules.relevance) {
    case "relevant":
      return isEvent
        ? { relevance: "direct", reason: `Event appears to be in Sri Lanka (scope: ${rules.event_scope}).` }
        : { relevance: "uncertain", reason: "Rules place an event in Sri Lanka, but the final category is 'other'." };
    case "possibly_relevant":
      return isEvent
        ? { relevance: "indirect", reason: `Event outside Sri Lanka with possible link(s): ${links}. A channel to check, not a confirmed impact.` }
        : { relevance: "uncertain", reason: "Rules found a possible link, but the final category is 'other'." };
    case "not_relevant":
      if (isEvent && rules.category === "other") {
        return { relevance: "uncertain", reason: `The model sees a ${category} event that the rules did not find; needs a human decision.` };
      }
      return {
        relevance: "none",
        reason: isEvent
          ? `${CATEGORY_LABELS[category] ?? category} event with no identified Sri Lankan connection (scope: ${rules.event_scope}).`
          : "No pharmaceutical-relevant event category found.",
      };
    case "insufficient_evidence":
      return { relevance: "uncertain", reason: "Too little text to decide." };
    default:
      return { relevance: "uncertain", reason: "No rule links this event to Sri Lanka either way." };
  }
}

// ISO week start (Monday, UTC) of a date, as YYYY-MM-DD.
function weekStart(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const day = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - day);
  return date.toISOString().slice(0, 10);
}

// GDACS reports carry a stable alert identifier (report.aspx?eventid=1101464&eventtype=FL).
function gdacsAlertId(url) {
  const match = /gdacs\.org\/.*[?&]eventid=(\d+)/i.exec(url ?? "");
  if (!match) return null;
  const type = /[?&]eventtype=([a-z]+)/i.exec(url)?.[1]?.toUpperCase();
  return type ? `${type}-${match[1]}` : match[1];
}

// Hazard named by the rules' natural-disaster evidence, e.g. "flood", "cyclone / storm".
function hazardOf(response) {
  const terms = response.rules?.matched_keywords?.natural_disaster ?? [];
  const plain = terms.find((t) => !String(t.term).startsWith("GDACS")) ?? terms[0];
  return plain ? String(plain.term).toLowerCase() : null;
}

// The event an article belongs to, or null (no event for irrelevant/uncertain articles).
//
// Grouping uses event identity, not time alone (version v2):
//   * GDACS alert            -> its alert id (episodes of the same alert merge; different alerts never do)
//   * disease (public health) -> disease + place, within GROUP_WINDOW_DAYS (processor)
//   * natural disaster        -> hazard + place, within GROUP_WINDOW_DAYS
//   * anything weaker (no disease/hazard, rules-only supply/logistics/trade categories)
//     -> a standalone event for this article only: an uncertain match is never merged.
// place = most specific Sri Lankan place (direct), "global" for global reports, else the
// foreign country codes named in the title/text.
function eventPlan(article, response, assessment) {
  const category = response.hybrid?.category ?? "other";
  if (!EVENT_TYPES[category] || !["direct", "indirect"].includes(assessment.relevance)) return null;

  const entities = response.rules?.entities ?? {};
  const diseases = entities.diseases ?? [];
  const direct = assessment.relevance === "direct";
  // Most specific Sri Lankan place first (district, then province).
  const lkPlaces = ["district", "province"].flatMap((t) => (entities.sri_lanka_locations ?? []).filter((l) => l.type === t));
  const foreign = (entities.foreign_countries ?? []).map((c) => ({ ...c, name: countryName(c) }));
  // A global / multi-country report is not placed in whichever country its text names first.
  const global = response.rules?.event_scope === "global";
  const week = weekStart(article.published_at ?? article.fetched_at);
  if (!week) return null;

  const place = direct
    ? `lk:${(lkPlaces[0]?.name ?? "sri lanka").toLowerCase()}`
    : global ? "global" : foreign.length ? foreign.map((c) => c.code ?? c.name).sort().join("+").toLowerCase() : null;
  const alert = gdacsAlertId(article.url);
  const hazard = category === "natural_disaster" ? hazardOf(response) : null;
  let identity = null;
  if (alert) identity = { group: `nlp:v2:gdacs:${alert}`, windowed: false };
  else if (category === "public_health" && diseases[0] && place) identity = { group: `nlp:v2:public_health:${diseases[0].name.toLowerCase()}:${place}`, windowed: true };
  else if (category === "natural_disaster" && hazard && place) identity = { group: `nlp:v2:natural_disaster:${hazard}:${place}`, windowed: true };
  const standalone = !identity;
  if (standalone) identity = { group: `nlp:v2:article:${article.id}`, windowed: false };

  const label = CATEGORY_LABELS[category];
  const where = direct ? lkPlaces[0]?.name ?? "Sri Lanka" : global ? "Multi-country" : foreign[0]?.name ?? "outside Sri Lanka";
  const what = diseases[0] ? `: ${capitalise(diseases[0].name)}` : hazard ? `: ${capitalise(hazard.split(" / ")[0])}` : "";
  return {
    group: identity.group,
    windowed: identity.windowed,
    standalone,
    // Windowed groups get one event per ISO week at most; others exactly one per group.
    dedupeKey: identity.windowed ? `${identity.group}:${week}` : identity.group,
    title: `${label}${what} – ${where}`,
    eventType: EVENT_TYPES[category](diseases),
    scope: direct ? "local" : "global",
    startedAt: week,
    category,
    diseaseNames: [...new Set(diseases.map((d) => d.name))],
    hazard,
    alertId: alert,
    // Sri Lankan places are event locations only when the event is in Sri Lanka;
    // a foreign report that merely mentions Sri Lanka is not located there.
    sriLankaLocations: direct ? entities.sri_lanka_locations ?? [] : [],
    foreignCountries: direct || global ? [] : foreign.slice(0, 3),
  };
}

// e.g. "service 1.0 / rules 0.1.0 / model transformer_accepted_category_seed13_… (sha256 c700182105cc)".
function analysisVersion(response) {
  const v = response.versions ?? {};
  const m = v.model;
  const model = !m ? "none" : typeof m === "string" ? m : `${m.run_id ?? m.base_model ?? "?"} (sha256 ${(m.checkpoint_sha256 ?? "?").slice(0, 12)})`;
  return [`service ${v.service ?? "?"}`, `rules ${v.rules?.version ?? "?"}`, `model ${model}`].join(" / ");
}

module.exports = {
  SUPPORTED_LANGUAGES,
  CATEGORY_LABELS,
  buildRequest,
  precheck,
  assessRelevance,
  eventPlan,
  gdacsAlertId,
  weekStart,
  analysisVersion,
};
