// Sunday Observer (Lake House weekly) - official RSS feed.
// General news, so only items matching health/disaster keywords are kept.

const { createRssSource } = require("./rss-source");

module.exports = createRssSource({
  source: {
    name: "Sunday Observer (Sri Lanka)",
    source_type: "news",
    base_url: "https://www.sundayobserver.lk",
    country_code: "LK",
  },
  feeds: [{ url: "https://www.sundayobserver.lk/feed/", language: "en" }],
  filter: true,
});
