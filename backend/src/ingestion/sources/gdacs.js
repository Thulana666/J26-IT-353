// GDACS - Global Disaster Alert and Coordination System (UN / European Commission).
// Official natural-hazard alerts (floods, cyclones, droughts, earthquakes) for
// Sri Lanka, all alert levels, including history back to SINCE. No key needed.

const { cleanText, fetchWithTimeout, toIsoDate } = require("../normalize");

const API_URL = "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH";
const SINCE = "2010-01-01";

const EVENT_TYPES = {
  FL: "Flood",
  TC: "Tropical cyclone",
  DR: "Drought",
  EQ: "Earthquake",
  TS: "Tsunami",
  VO: "Volcano",
  WF: "Wildfire",
};

const source = {
  name: "GDACS (Global Disaster Alert and Coordination System)",
  source_type: "international",
  base_url: "https://www.gdacs.org",
  country_code: "LK",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// ISO date (UTC) -> "14 Sep 2026"
const formatDay = (iso) => {
  const date = new Date(iso);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
};

async function collect() {
  const query = new URLSearchParams({
    country: "Sri Lanka",
    alertlevel: "green;orange;red",
    fromdate: SINCE,
    todate: new Date().toISOString().slice(0, 10),
  });
  const response = await fetchWithTimeout(`${API_URL}?${query}`, {
    headers: { Accept: "application/json", "User-Agent": "PharmaTwin research prototype" },
    timeoutMs: 60000,
  });
  const features = (await response.json())?.features ?? [];

  const articles = features
    .map(({ properties: p }) => {
      // GDACS dates are UTC without a timezone suffix.
      const from = toIsoDate(p.fromdate, "Z");
      const to = toIsoDate(p.todate, "Z");
      if (!p.name || !p.eventid || !from) return null;

      const alert = p.alertlevel ? p.alertlevel[0].toUpperCase() + p.alertlevel.slice(1).toLowerCase() : null;
      const dates = to && formatDay(to) !== formatDay(from) ? `${formatDay(from)} to ${formatDay(to)}` : formatDay(from);
      const countries = (p.affectedcountries ?? []).map((c) => c.countryname).filter(Boolean);
      const severity = p.severitydata?.severity > 0 ? cleanText(p.severitydata.severitytext) : null;

      return {
        // GDACS reuses names like "Flood in Sri Lanka", so add alert level and dates.
        title: `${p.name} – ${alert ? `${alert} alert, ` : ""}${dates}`,
        // One stable link per event (episodes of the same event share it).
        url: `https://www.gdacs.org/report.aspx?eventid=${p.eventid}&eventtype=${p.eventtype}`,
        summary: cleanText(p.htmldescription || p.description),
        content: [
          `Event type: ${EVENT_TYPES[p.eventtype] ?? p.eventtype}`,
          alert && `Alert level: ${alert}`,
          countries.length && `Affected countries: ${countries.join(", ")}`,
          severity && `Severity: ${severity}`,
          `Period: ${dates}`,
          p.glide && `GLIDE: ${p.glide}`,
        ]
          .filter(Boolean)
          .join("\n"),
        author: "GDACS",
        language: "en",
        country_code: "LK",
        published_at: from,
      };
    })
    .filter(Boolean);

  return { fetched: features.length, articles };
}

module.exports = { source, collect };
