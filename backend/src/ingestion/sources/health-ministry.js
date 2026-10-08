// Ministry of Health Sri Lanka - official website feed (circulars and notices).
// Every item is official health information, so no keyword filter is applied.

const { createRssSource } = require("./rss-source");

module.exports = createRssSource({
  source: {
    name: "Ministry of Health Sri Lanka",
    source_type: "government",
    base_url: "https://www.health.gov.lk",
    country_code: "LK",
  },
  feeds: [{ url: "https://www.health.gov.lk/feed/", language: "en" }],
  filter: false,
  // The feed's author field is an internal account name ("moh_admin").
  author: "Ministry of Health Sri Lanka",
});
