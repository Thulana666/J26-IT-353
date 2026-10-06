// WHO Disease Outbreak News (official WHO API).
// Every item is a public-health event report, so no keyword filter is needed.

const { cleanText, fetchWithTimeout, toIsoDate } = require("../normalize");

const API_URL = "https://www.who.int/api/news/diseaseoutbreaknews";
const ITEM_URL = "https://www.who.int/emergencies/disease-outbreak-news/item/";
const MAX_ITEMS = 30;

const source = {
  name: "WHO Disease Outbreak News",
  source_type: "international",
  base_url: "https://www.who.int/emergencies/disease-outbreak-news",
  country_code: null,
};

async function collect() {
  const query = new URLSearchParams({
    sf_culture: "en",
    $orderby: "PublicationDateAndTime desc",
    $top: String(MAX_ITEMS),
  });
  // The WHO API can be slow to respond, so allow a generous timeout.
  const response = await fetchWithTimeout(`${API_URL}?${query}`, {
    headers: { Accept: "application/json" },
    timeoutMs: 120000,
  });
  const body = await response.json();
  const items = Array.isArray(body?.value) ? body.value : [];

  const articles = items
    .filter((item) => item.Title && item.UrlName)
    .map((item) => ({
      title: cleanText(item.Title),
      url: ITEM_URL + encodeURIComponent(item.UrlName),
      summary: cleanText(item.Summary),
      content: cleanText(
        [item.Overview, item.Epidemiology, item.Assessment, item.Advice].filter(Boolean).join("\n")
      ),
      author: "World Health Organization",
      language: "en",
      // Reports cover many countries; the country is extracted in the NLP stage.
      country_code: null,
      published_at: toIsoDate(item.PublicationDateAndTime || item.PublicationDate),
    }));

  return { fetched: items.length, articles };
}

module.exports = { source, collect };
