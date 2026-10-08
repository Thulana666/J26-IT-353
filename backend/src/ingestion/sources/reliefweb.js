// ReliefWeb (UN OCHA) - official API (v2). Two kinds of Sri Lanka content:
//   * reports: situation reports from the National Dengue Control Unit, WHO,
//     IFRC, FEWS NET, government agencies... (full text)
//   * disasters: officially recorded disasters and epidemics (GLIDE-numbered)
// Needs a free, pre-approved appname in RELIEFWEB_APPNAME (request form:
// https://apidoc.reliefweb.int/parameters#appname). ReliefWeb's robots.txt
// disallows automated RSS access, so the API is used instead.

const { SourceNotConfigured, cleanText, fetchWithTimeout, normalizeUrl, toIsoDate } = require("../normalize");

const API_URL = "https://api.reliefweb.int/v2";
const COUNTRY_ISO3 = "lka";
// Max per request is 1000; one request per run covers roughly a year of reports.
const REPORT_LIMIT = 1000;
const DISASTER_LIMIT = 200;

const source = {
  name: "ReliefWeb (UN OCHA)",
  source_type: "international",
  base_url: "https://reliefweb.int",
  country_code: "LK",
};

async function query(appname, contentType, body) {
  const response = await fetchWithTimeout(`${API_URL}/${contentType}?appname=${encodeURIComponent(appname)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    timeoutMs: 90000,
  });
  const json = await response.json();
  return Array.isArray(json?.data) ? json.data : [];
}

// First paragraph of a text, as a short summary.
function firstParagraph(text, maxLength = 500) {
  if (!text) return null;
  const paragraph = text.split("\n").find((line) => line.trim().length > 40) ?? text;
  return paragraph.length > maxLength ? `${paragraph.slice(0, maxLength).replace(/\s+\S*$/, "")}…` : paragraph;
}

async function collect() {
  const appname = process.env.RELIEFWEB_APPNAME?.trim();
  if (!appname) {
    throw new SourceNotConfigured(
      "RELIEFWEB_APPNAME is not set in backend/.env (request a free appname from ReliefWeb)"
    );
  }

  const articles = [];
  const problems = [];
  let fetched = 0;

  // Reports and disasters are fetched separately; one failing doesn't stop the other.
  try {
    const reports = await query(appname, "reports", {
      filter: { field: "primary_country.iso3", value: COUNTRY_ISO3 },
      fields: {
        include: ["title", "body-html", "body", "url_alias", "url", "date.original", "date.created", "source.shortname", "source.name", "language.code"],
      },
      sort: ["date.original:desc"],
      limit: REPORT_LIMIT,
    });
    fetched += reports.length;
    for (const { fields: f } of reports) {
      const content = cleanText(f["body-html"] || f.body);
      articles.push({
        title: cleanText(f.title),
        url: normalizeUrl(f.url_alias || f.url),
        summary: firstParagraph(content),
        content,
        author: (f.source ?? []).map((s) => s.shortname || s.name).filter(Boolean).join(", ") || null,
        language: f.language?.[0]?.code || "en",
        country_code: "LK",
        published_at: toIsoDate(f.date?.original || f.date?.created, "Z"),
      });
    }
  } catch (error) {
    problems.push(`reports: ${error.message}`);
  }

  try {
    const disasters = await query(appname, "disasters", {
      filter: { field: "country.iso3", value: COUNTRY_ISO3 },
      fields: { include: ["name", "description-html", "description", "glide", "date.event", "url_alias", "url", "type.name", "status"] },
      sort: ["date.event:desc"],
      limit: DISASTER_LIMIT,
    });
    fetched += disasters.length;
    for (const { fields: f } of disasters) {
      const description = cleanText(f["description-html"] || f.description);
      const types = (f.type ?? []).map((t) => t.name).filter(Boolean).join(", ");
      articles.push({
        title: cleanText(f.name),
        url: normalizeUrl(f.url_alias || f.url),
        summary: [types && `Disaster type: ${types}`, f.glide && `GLIDE: ${f.glide}`, f.status && `Status: ${f.status}`]
          .filter(Boolean)
          .join(" · ") || null,
        content: description,
        author: "ReliefWeb",
        language: "en",
        country_code: "LK",
        published_at: toIsoDate(f.date?.event, "Z"),
      });
    }
  } catch (error) {
    problems.push(`disasters: ${error.message}`);
  }

  if (problems.length === 2) throw new Error(problems.join("; "));
  return {
    fetched,
    articles: articles.filter((article) => article.title && article.url),
    warnings: problems,
  };
}

module.exports = { source, collect };
