// Daily Mirror (Sri Lanka) - official RSS feed.
// General news, so only items matching health/disaster keywords are kept.
// robots.txt asks for at most one request per hour: run the collector manually.

const { createRssSource } = require("./rss-source");

module.exports = createRssSource({
  source: {
    name: "Daily Mirror (Sri Lanka)",
    source_type: "news",
    base_url: "https://www.dailymirror.lk",
    country_code: "LK",
  },
  feeds: [{ url: "https://www.dailymirror.lk/rss/breaking_news/108", language: "en" }],
  filter: true,
});
