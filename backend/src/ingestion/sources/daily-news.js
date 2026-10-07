// Daily News (Lake House, state-owned national daily) - official RSS feed.
// General news, so only items matching health/disaster keywords are kept.

const { createRssSource } = require("./rss-source");

module.exports = createRssSource({
  source: {
    name: "Daily News (Sri Lanka)",
    source_type: "news",
    base_url: "https://www.dailynews.lk",
    country_code: "LK",
  },
  feeds: [{ url: "https://www.dailynews.lk/feed/", language: "en" }],
  filter: true,
});
