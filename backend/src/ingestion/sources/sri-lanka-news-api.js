// Sri Lanka News API (RapidAPI) - aggregated Sri Lankan news.
// Key: NEWS_API_KEY (server-side only). Headlines are general news, so only
// items matching health/disaster keywords (English/Sinhala/Tamil) are kept.

const { cleanText, fetchWithTimeout, matchesHealthTopic, normalizeUrl, toIsoDate } = require("../normalize");

const HOST = "sri-lanka-news-api.p.rapidapi.com";
const ENDPOINTS = [{ path: "/news/sinhala", language: "si" }];

const source = {
  name: "Sri Lanka News API (RapidAPI)",
  source_type: "news",
  base_url: `https://${HOST}`,
  country_code: "LK",
};

// The response shape isn't documented publicly, so accept the common layouts.
function extractItems(body) {
  if (Array.isArray(body)) return body;
  for (const key of ["data", "news", "articles", "results", "items"]) {
    if (Array.isArray(body?.[key])) return body[key];
  }
  return [];
}

const pick = (item, keys) => keys.map((key) => item?.[key]).find((value) => value != null && value !== "");

async function collect() {
  const apiKey = process.env.NEWS_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("NEWS_API_KEY is not set in backend/.env");
  }

  let fetched = 0;
  const articles = [];
  const problems = [];

  // One endpoint failing doesn't stop the others.
  for (const endpoint of ENDPOINTS) {
    try {
      const response = await fetchWithTimeout(`https://${HOST}${endpoint.path}`, {
        headers: { "x-rapidapi-host": HOST, "x-rapidapi-key": apiKey },
      });
      const items = extractItems(await response.json());
      fetched += items.length;

      for (const item of items) {
        const title = cleanText(pick(item, ["title", "headline", "name"]));
        const summary = cleanText(pick(item, ["description", "summary", "excerpt"]));
        const content = cleanText(pick(item, ["content", "body", "text", "fullText"])) || summary;
        const article = {
          title,
          url: normalizeUrl(pick(item, ["url", "link", "href", "source_url", "sourceUrl"])),
          summary,
          content,
          author: cleanText(pick(item, ["author", "source", "publisher", "site"])),
          language: endpoint.language,
          country_code: "LK",
          published_at: toIsoDate(pick(item, ["publishedAt", "published_at", "pubDate", "date", "time", "datetime"])),
        };
        if (article.title && article.url && matchesHealthTopic(title, summary, content)) {
          articles.push(article);
        }
      }
    } catch (error) {
      problems.push(`${endpoint.path}: ${error.message}`);
    }
  }

  if (problems.length === ENDPOINTS.length) {
    throw new Error(problems.join("; "));
  }
  return { fetched, articles, warnings: problems };
}

module.exports = { source, collect, extractItems };
