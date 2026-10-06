// NewsAPI.org - news search targeted at Sri Lankan public-health topics.
// Key: NEWS_API_KEY (server-side only, sent as a header so it never appears in URLs).
// Relevance comes from the search query itself; no NLP filtering here.

const { SourceNotConfigured, cleanText, fetchWithTimeout, normalizeUrl, toIsoDate } = require("../normalize");

const API_URL = "https://newsapi.org/v2/everything";
const PAGE_SIZE = 50;

// One combined query (the free plan allows 100 requests/day) covering:
// Sri Lanka dengue / disease outbreak / epidemic / public health / health
// emergency / flood health / disaster health / medicine.
const QUERY =
  '"Sri Lanka" AND (dengue OR outbreak OR epidemic OR "public health" OR "health emergency" ' +
  "OR medicine OR medicines OR ((flood OR floods OR disaster) AND (health OR disease OR hospital)))";

const source = {
  name: "NewsAPI",
  source_type: "news",
  base_url: "https://newsapi.org",
  country_code: null,
};

async function collect() {
  const apiKey = process.env.NEWS_API_KEY?.trim();
  if (!apiKey) {
    throw new SourceNotConfigured("NEWS_API_KEY is not set in backend/.env");
  }

  const query = new URLSearchParams({
    q: QUERY,
    searchIn: "title,description",
    language: "en",
    sortBy: "publishedAt",
    pageSize: String(PAGE_SIZE),
  });
  const response = await fetchWithTimeout(`${API_URL}?${query}`, {
    headers: { "X-Api-Key": apiKey, "User-Agent": "PharmaTwin research prototype" },
  });
  const body = await response.json();
  if (body.status !== "ok") {
    throw new Error(`NewsAPI error: ${body.code ?? "unknown"} ${body.message ?? ""}`.trim());
  }
  const items = Array.isArray(body.articles) ? body.articles : [];

  const articles = items
    // NewsAPI marks deleted articles with the title "[Removed]".
    .filter((item) => item.title && item.title !== "[Removed]")
    .map((item) => {
      const summary = cleanText(item.description);
      // Free-plan content is truncated and ends with "[+1234 chars]".
      const content = cleanText(item.content?.replace(/\s*\[\+\d+ chars\]\s*$/, "")) || summary;
      return {
        title: cleanText(item.title),
        url: normalizeUrl(item.url),
        summary,
        content,
        // Ignore placeholder authors like "noreply@blogger.com (Unknown)".
        author:
          (/@|^unknown$/i.test(item.author ?? "") ? null : cleanText(item.author)) ||
          cleanText(item.source?.name),
        language: "en",
        // Every result matched "Sri Lanka" in its title or description.
        country_code: "LK",
        published_at: toIsoDate(item.publishedAt),
      };
    })
    .filter((article) => article.title && article.url);

  return { fetched: items.length, articles };
}

module.exports = { source, collect, QUERY };
