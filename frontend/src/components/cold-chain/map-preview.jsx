// Small embedded map of the shipment's latest GPS fix, framed on its recent
// track. OpenStreetMap's embed page needs no API key, billing account or map
// library (a Google Maps embed needs a Google Cloud key). Opening the page
// sends the coordinates to openstreetmap.org from the viewer's browser.
//
//   latest: { latitude, longitude }
//   track:  [{ latitude, longitude }] fixes to frame (flagged GPS jumps excluded by the caller)

const MIN_SPAN_DEG = 0.01;

function boundingBox(latest, track) {
  const points = [latest, ...track];
  const lats = points.map((p) => p.latitude);
  const lngs = points.map((p) => p.longitude);
  const pad = (lo, hi) => {
    const span = Math.max(hi - lo, MIN_SPAN_DEG);
    const mid = (lo + hi) / 2;
    return [mid - span * 0.6, mid + span * 0.6];
  };
  const [south, north] = pad(Math.min(...lats), Math.max(...lats));
  const [west, east] = pad(Math.min(...lngs), Math.max(...lngs));
  return [west, south, east, north].map((v) => v.toFixed(5)).join(",");
}

export function mapLinks({ latitude, longitude }) {
  return {
    google: `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`,
    openStreetMap: `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=14/${latitude}/${longitude}`,
  };
}

export function MapPreview({ latest, track = [], height = 200 }) {
  const src =
    "https://www.openstreetmap.org/export/embed.html" +
    `?bbox=${boundingBox(latest, track)}&layer=mapnik&marker=${latest.latitude},${latest.longitude}`;
  return (
    <iframe
      title="Map of the shipment's latest position"
      src={src}
      loading="lazy"
      referrerPolicy="no-referrer"
      sandbox="allow-scripts allow-same-origin allow-popups"
      className="w-full rounded-lg border bg-muted"
      style={{ height }}
    />
  );
}
