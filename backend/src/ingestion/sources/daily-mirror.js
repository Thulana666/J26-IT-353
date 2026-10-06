// Daily Mirror (Sri Lanka) - official RSS feed.
// General news, so only items matching health/disaster keywords are kept.
// robots.txt asks for at most one request per hour: run the collector manually.

const { parseRssItems } = require("../rss");
const { cleanText, fetchWithTimeout, matchesHealthTopic, normalizeUrl, toIsoDate } = require("../normalize");

const FEED_URL = "https://www.dailymirror.lk/rss/breaking_news/108";

const source = {
  name: "Daily Mirror (Sri Lanka)",
  source_type: "news",
  base_url: "https://www.dailymirror.lk",
  country_code: "LK",
};

async function collect() {
  const response = await fetchWithTimeout(FEED_URL, {
    headers: { "User-Agent": "PharmaTwin research prototype (RSS reader)" },
  });
  const items = parseRssItems(await response.text());

  const articles = items
    .map((item) => {
      const title = cleanText(item.title);
      const summary = cleanText(item.description);
      const content = cleanText(item.content) || summary;
      return {
        title,
        url: normalizeUrl(item.link || item.guid),
        summary,
        content,
        author: cleanText(item.author),
        language: "en",
        country_code: "LK",
        // Feed dates have no timezone; they are Sri Lanka local time.
        published_at: toIsoDate(item.pubDate, "+05:30"),
      };
    })
    .filter((article) => article.title && article.url)
    .filter((article) => matchesHealthTopic(article.title, article.summary, article.content));

  return { fetched: items.length, articles };
}

module.exports = { source, collect };
