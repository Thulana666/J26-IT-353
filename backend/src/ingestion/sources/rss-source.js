// Builds a collector for a publisher's official RSS feed(s).
// filter: true keeps only items matching health/disaster keywords (general news);
// filter: false keeps everything (feeds that are health-only, e.g. a ministry).

const { parseRssItems } = require("../rss");
const { cleanText, fetchWithTimeout, matchesHealthTopic, normalizeUrl, toIsoDate } = require("../normalize");

const USER_AGENT = "PharmaTwin research prototype (RSS reader)";

function createRssSource({ source, feeds, filter, author, timezoneOffset = "+05:30" }) {
  async function collect() {
    let fetched = 0;
    const articles = [];
    const problems = [];

    // One feed failing doesn't stop the others.
    for (const feed of feeds) {
      try {
        const response = await fetchWithTimeout(feed.url, { headers: { "User-Agent": USER_AGENT } });
        const items = parseRssItems(await response.text());
        fetched += items.length;

        for (const item of items) {
          const title = cleanText(item.title);
          const summary = cleanText(item.description);
          const content = cleanText(item.content) || summary;
          const article = {
            title,
            url: normalizeUrl(item.link || item.guid),
            summary,
            content,
            author: author || cleanText(item.author),
            language: feed.language || "en",
            country_code: source.country_code,
            // Dates without a timezone are read in the publisher's local time.
            published_at: toIsoDate(item.pubDate, timezoneOffset),
          };
          if (!article.title || !article.url) continue;
          // Match on title + summary only: a keyword buried in a long article
          // (e.g. "medicine" in a Nobel physics story) isn't a good signal.
          if (filter && !matchesHealthTopic(title, summary)) continue;
          articles.push(article);
        }
      } catch (error) {
        problems.push(feeds.length > 1 ? `${feed.url}: ${error.message}` : error.message);
      }
    }

    if (problems.length === feeds.length) throw new Error(problems.join("; "));
    return { fetched, articles, warnings: problems };
  }

  return { source, collect };
}

module.exports = { createRssSource };
