// Helpers that turn raw source data into clean `event_articles` values.
// No NLP here: only text cleanup and simple keyword filtering.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

// HTML/RSS fragment -> plain text.
function cleanText(value) {
  if (!value) return null;
  const text = decodeEntities(
    String(value)
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\/(p|div|li|h[1-6])>|<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
  return text || null;
}

const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|mc_cid|mc_eid|ref)$/i;

// Canonical URL used for duplicate detection: no fragment, no tracking params.
function normalizeUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value).trim());
    if (!/^https?:$/.test(url.protocol)) return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return null;
  }
}

// Parses a date string to ISO. Dates without a timezone (e.g. Daily Mirror's
// "2026-10-06 20:51:00") are read in `defaultOffset`, Sri Lanka by default.
function toIsoDate(value, defaultOffset = "+05:30") {
  if (!value) return null;
  let text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(text)) {
    text = text.replace(" ", "T") + defaultOffset;
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// Simple topic filter for general news feeds (pharmaceutical / public-health
// relevance). This is deliberately basic; NLP relevance comes in a later stage.
const HEALTH_KEYWORDS = {
  // Matched on word boundaries.
  en: [
    "dengue", "outbreak", "epidemic", "pandemic", "disease", "diseases", "virus",
    "infection", "infections", "fever", "health", "hospital", "hospitals",
    "medicine", "medicines", "medical", "drug", "drugs", "pharmacy",
    "pharmaceutical", "pharmaceuticals", "vaccine", "vaccination", "cholera",
    "leptospirosis", "influenza", "flu", "covid", "malaria", "chikungunya",
    "patients", "flood", "floods", "flooding", "landslide", "landslides",
    "disaster", "drought", "cyclone", "MOH",
  ],
  // Sinhala and Tamil have no simple word boundaries: matched as substrings.
  si: [
    "ඩෙංගු", "වසංගත", "රෝග", "සෞඛ්‍ය", "රෝහල", "ඖෂධ", "බෙහෙත්", "එන්නත",
    "වෛරස", "කොළරාව", "ගංවතුර", "නායයෑම්", "ආපදා",
  ],
  ta: ["டெங்கு", "தொற்று", "நோய்", "சுகாதார", "மருத்துவ", "மருந்து", "தடுப்பூசி", "வெள்ளம்", "அனர்த்த"],
};

const englishPattern = new RegExp(`\\b(${HEALTH_KEYWORDS.en.join("|")})\\b`, "i");

function matchesHealthTopic(...texts) {
  const text = texts.filter(Boolean).join(" ");
  if (!text) return false;
  if (englishPattern.test(text)) return true;
  return [...HEALTH_KEYWORDS.si, ...HEALTH_KEYWORDS.ta].some((word) => text.includes(word));
}

// fetch() with a timeout and a clear error message (never includes headers).
async function fetchWithTimeout(url, { timeoutMs = 30000, ...options } = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) }).catch((error) => {
    const reason = error.name === "TimeoutError" ? `timed out after ${timeoutMs / 1000}s` : error.cause?.code || error.message;
    throw new Error(`Request to ${new URL(url).host} failed: ${reason}`);
  });
  if (!response.ok) {
    throw new Error(`Request to ${new URL(url).host}${new URL(url).pathname} returned HTTP ${response.status}`);
  }
  return response;
}

module.exports = { cleanText, normalizeUrl, toIsoDate, matchesHealthTopic, fetchWithTimeout };
