// Finds a country named in a text (e.g. a WHO title "Measles - Bangladesh")
// and returns its ISO 3166-1 alpha-2 code. Plain name matching, not NLP.

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

// Not countries: EU, Eurozone, UN, Outlying Oceania, unknown and pseudo regions.
const EXCLUDED = new Set(["EU", "EZ", "UN", "QO", "ZZ", "XA", "XB"]);

// Official UN/WHO spellings and common names the ISO display names lack.
const ALIASES = {
  "Democratic Republic of the Congo": "CD",
  "DR Congo": "CD",
  "Republic of the Congo": "CG",
  "Côte d'Ivoire": "CI",
  "Ivory Coast": "CI",
  "Viet Nam": "VN",
  "Republic of Korea": "KR",
  "Democratic People's Republic of Korea": "KP",
  "Lao People's Democratic Republic": "LA",
  "Syrian Arab Republic": "SY",
  "Russian Federation": "RU",
  "United States of America": "US",
  "USA": "US",
  "United Kingdom of Great Britain and Northern Ireland": "GB",
  "UK": "GB",
  "Turkey": "TR",
  "Hong Kong": "HK",
  "Macao": "MO",
  "Cabo Verde": "CV",
  "Eswatini": "SZ",
  "Timor-Leste": "TL",

  // South Asia (project focus): official names, nationality words, and
  // Sinhala/Tamil spellings. "Indian" is left out ("Indian Ocean").
  "Democratic Socialist Republic of Sri Lanka": "LK",
  "Sri Lankan": "LK",
  "Sri Lankans": "LK",
  "Ceylon": "LK",
  "ශ්‍රී ලංකාව": "LK",
  "ශ්‍රී ලංකා": "LK",
  "ලංකාව": "LK",
  "இலங்கை": "LK",
  "Republic of India": "IN",
  "ඉන්දියාව": "IN",
  "இந்தியா": "IN",
  "People's Republic of Bangladesh": "BD",
  "Bangladeshi": "BD",
  "බංග්ලාදේශය": "BD",
  "வங்காளதேசம்": "BD",
  "Islamic Republic of Pakistan": "PK",
  "Pakistani": "PK",
  "පකිස්තානය": "PK",
  "பாகிஸ்தான்": "PK",
  "Federal Democratic Republic of Nepal": "NP",
  "Nepali": "NP",
  "Nepalese": "NP",
  "නේපාලය": "NP",
  "நேபாளம்": "NP",
  "Kingdom of Bhutan": "BT",
  "Bhutanese": "BT",
  "භූතානය": "BT",
  "பூட்டான்": "BT",
  "Republic of Maldives": "MV",
  "Maldivian": "MV",
  "Maldivians": "MV",
  "මාලදිවයින": "MV",
  "மாலைதீவு": "MV",
  "Islamic Republic of Afghanistan": "AF",
  "Afghan": "AF",
  "ඇෆ්ගනිස්ථානය": "AF",
  "ஆப்கானிஸ்தான்": "AF",
};

function buildNameIndex() {
  const index = new Map();
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      const name = regionNames.of(code);
      if (!EXCLUDED.has(code) && name && name !== code && !/unknown/i.test(name)) {
        index.set(name.toLowerCase(), code);
      }
    }
  }
  for (const [name, code] of Object.entries(ALIASES)) index.set(name.toLowerCase(), code);
  return index;
}

const NAME_TO_CODE = buildNameIndex();
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Latin-script names must be whole words ("Niger" must not match "Nigeria").
// Sinhala/Tamil names are matched inside words, because those languages attach
// case endings to the name (e.g. "இலங்கையில்" = "in Sri Lanka").
const toAlternative = (name) =>
  /[a-z]/i.test(name) ? `(?<!\\p{L})${escape(name)}(?!\\p{L})` : escape(name);
// Longest names first, so "Papua New Guinea" wins over "Guinea".
const PATTERN = new RegExp(
  `(${[...NAME_TO_CODE.keys()].sort((x, y) => y.length - x.length).map(toAlternative).join("|")})`,
  "iu"
);

// Returns the code of the first country named in the text, or null
// (e.g. "Global situation", "Multi-country").
function findCountryCode(text) {
  if (!text) return null;
  const match = String(text).replace(/[’‘]/g, "'").match(PATTERN);
  return match ? NAME_TO_CODE.get(match[1].toLowerCase()) : null;
}

module.exports = { findCountryCode };
